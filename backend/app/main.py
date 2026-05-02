import hashlib
import logging
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .auth import HmacMiddleware
from .cache import get_cached_price, store_price
from .claude_client import identify_and_price, parse_sale_text
from .db import get_conn, init_db
from .images import preprocess_image
from .schemas import (
    HealthResponse, LedgerEntry, LedgerResponse,
    ParseSaleRequest, ParseSaleResponse,
    PriceRequest, PriceResponse,
    SaleRequest, SaleResponse, SaleUpdateRequest,
    SearchHit, SearchResponse, SummaryResponse, UploadResponse,
)
from .settings import settings

log = logging.getLogger(__name__)

_MAX_IMAGE_BYTES = 4 * 1024 * 1024  # 4 MB
_FRONTEND_DIR = Path(__file__).parent.parent.parent / "frontend"
_UPLOAD_DIR = Path(settings.cache_dir) / "uploads"

# In-memory token bucket: ip -> (last_refill_ts, tokens)
_rate_buckets: dict[str, tuple[float, float]] = {}


def _check_rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    last_refill, tokens = _rate_buckets.get(ip, (now, float(settings.rate_limit_rpm)))
    elapsed = now - last_refill
    tokens = min(settings.rate_limit_rpm, tokens + elapsed * (settings.rate_limit_rpm / 60))
    if tokens < 1:
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    _rate_buckets[ip] = (now, tokens - 1)


app = FastAPI(title="Garage Sale Helper")

app.add_middleware(HmacMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "X-Timestamp", "X-Signature"],
)


@app.on_event("startup")
def startup() -> None:
    import os
    os.makedirs(settings.cache_dir, exist_ok=True)
    os.makedirs(str(_UPLOAD_DIR), exist_ok=True)
    init_db()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True)


@app.post("/upload", response_model=UploadResponse)
async def upload_image(request: Request, image: UploadFile = File(...)) -> UploadResponse:
    _check_rate_limit(request)
    data = await image.read()
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 4 MB)")
    try:
        processed, _ = preprocess_image(data)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image")
    upload_id = str(uuid.uuid4())
    (_UPLOAD_DIR / f"{upload_id}.jpg").write_bytes(processed)
    return UploadResponse(upload_id=upload_id)


@app.post("/price", response_model=PriceResponse)
async def price_item(request: Request, body: PriceRequest) -> PriceResponse:
    _check_rate_limit(request)

    if not body.upload_ids or len(body.upload_ids) > 3:
        raise HTTPException(status_code=400, detail="Send 1–3 upload IDs")

    all_processed: list[bytes] = []
    all_hashes: list[str] = []
    upload_paths: list[Path] = []
    for uid in body.upload_ids:
        path = _UPLOAD_DIR / f"{uid}.jpg"
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"Upload expired or not found: {uid}")
        data = path.read_bytes()
        all_processed.append(data)
        all_hashes.append(hashlib.sha256(data).hexdigest())
        upload_paths.append(path)

    notes_key = body.notes or ""
    combined_hash = hashlib.sha256(":".join(all_hashes).encode()).hexdigest()

    cached = get_cached_price(combined_hash, notes_key)
    if cached is not None:
        for p in upload_paths:
            p.unlink(missing_ok=True)
        return PriceResponse(cache_hit=True, request_id=cached["_request_id"], **{
            k: v for k, v in cached.items() if not k.startswith("_")
        })

    try:
        result = await identify_and_price(all_processed, body.notes)
    except Exception as exc:
        log.exception("Claude API error: %s", exc)
        raise HTTPException(status_code=503, detail="Claude API unavailable")

    for p in upload_paths:
        p.unlink(missing_ok=True)

    request_id = str(uuid.uuid4())
    store_price(combined_hash, notes_key, request_id, {**result, "_request_id": request_id})

    return PriceResponse(
        cache_hit=False,
        request_id=request_id,
        item=result["item"],
        condition_observed=result["condition_observed"],
        suggested_price_usd=result["suggested_price_usd"],
        price_range_usd=result["price_range_usd"],
        retail_price_new_usd=result.get("retail_price_new_usd"),
        rationale=result["rationale"],
    )


@app.post("/parse-sale", response_model=ParseSaleResponse)
async def parse_sale(request: Request, body: ParseSaleRequest) -> ParseSaleResponse:
    _check_rate_limit(request)
    if not body.text.strip():
        raise HTTPException(status_code=400, detail="Text is required")
    try:
        result = await parse_sale_text(body.text)
    except Exception as exc:
        log.exception("parse-sale error: %s", exc)
        raise HTTPException(status_code=503, detail="Could not parse sale description")
    return ParseSaleResponse(
        item_label=result["item_label"],
        sold_price_usd=float(result.get("sold_price_usd", 0)),
    )


@app.post("/sale", response_model=SaleResponse)
async def log_sale(request: Request, body: SaleRequest) -> SaleResponse:
    _check_rate_limit(request)
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO sales_log
               (request_id, item_label, suggested_price_usd, sold_price_usd, sold, notes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                body.request_id,
                body.item_label,
                body.suggested_price_usd,
                body.sold_price_usd,
                int(body.sold),
                body.notes,
                int(time.time()),
            ),
        )
    return SaleResponse(logged=True, id=cur.lastrowid)


@app.patch("/sale/{sale_id}", response_model=SaleResponse)
async def update_sale(request: Request, sale_id: int, body: SaleUpdateRequest) -> SaleResponse:
    _check_rate_limit(request)
    fields: dict = {}
    if body.item_label is not None:
        fields["item_label"] = body.item_label
    if body.sold_price_usd is not None:
        fields["sold_price_usd"] = body.sold_price_usd
    if not fields:
        raise HTTPException(status_code=400, detail="Nothing to update")
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    with get_conn() as conn:
        conn.execute(
            f"UPDATE sales_log SET {set_clause} WHERE id = ?",
            (*fields.values(), sale_id),
        )
    return SaleResponse(logged=True, id=sale_id)


@app.delete("/sale/{sale_id}", response_model=SaleResponse)
async def delete_sale(request: Request, sale_id: int) -> SaleResponse:
    _check_rate_limit(request)
    with get_conn() as conn:
        conn.execute("DELETE FROM sales_log WHERE id = ?", (sale_id,))
    return SaleResponse(logged=True, id=sale_id)


@app.get("/ledger", response_model=LedgerResponse)
async def get_ledger(request: Request) -> LedgerResponse:
    _check_rate_limit(request)
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, item_label, sold_price_usd, sold, created_at "
            "FROM sales_log ORDER BY created_at DESC"
        ).fetchall()
    return LedgerResponse(entries=[
        LedgerEntry(
            id=r["id"],
            item_label=r["item_label"],
            sold_price_usd=r["sold_price_usd"],
            sold=bool(r["sold"]),
            created_at=r["created_at"],
        )
        for r in rows
    ])


@app.get("/search", response_model=SearchResponse)
async def search_items(request: Request, q: str = "") -> SearchResponse:
    _check_rate_limit(request)
    q = q.strip()
    if not q:
        raise HTTPException(status_code=400, detail="Query is required")
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT response_json, notes, created_at FROM price_cache "
            "WHERE response_json LIKE ? ORDER BY created_at DESC LIMIT 50",
            (f"%{q}%",),
        ).fetchall()
    import json
    results: list[SearchHit] = []
    for r in rows:
        data = json.loads(r["response_json"])
        results.append(SearchHit(
            item=data.get("item", ""),
            condition_observed=data.get("condition_observed", ""),
            suggested_price_usd=data.get("suggested_price_usd", 0),
            price_range_usd=data.get("price_range_usd", []),
            retail_price_new_usd=data.get("retail_price_new_usd"),
            rationale=data.get("rationale", ""),
            notes=r["notes"],
            created_at=r["created_at"],
        ))
    return SearchResponse(results=results)


@app.get("/summary", response_model=SummaryResponse)
async def summary(request: Request) -> SummaryResponse:
    _check_rate_limit(request)
    with get_conn() as conn:
        total_priced = conn.execute("SELECT COUNT(*) FROM price_cache").fetchone()[0]

        row = conn.execute(
            """SELECT
                 COUNT(*) AS total_sold,
                 COALESCE(SUM(sold_price_usd), 0) AS revenue,
                 COALESCE(
                   AVG(CASE
                     WHEN suggested_price_usd > 0
                     THEN (suggested_price_usd - sold_price_usd) / suggested_price_usd
                   END), 0
                 ) AS avg_discount
               FROM sales_log WHERE sold = 1"""
        ).fetchone()

        top_rows = conn.execute(
            """SELECT item_label, sold_price_usd
               FROM sales_log WHERE sold = 1
               ORDER BY sold_price_usd DESC LIMIT 5"""
        ).fetchall()

    return SummaryResponse(
        total_items_priced=total_priced,
        total_items_sold=row["total_sold"],
        total_revenue_usd=round(row["revenue"], 2),
        avg_discount_vs_suggested=round(row["avg_discount"], 4),
        top_items=[{"item_label": r["item_label"], "sold_price_usd": r["sold_price_usd"]} for r in top_rows],
    )


@app.get("/", response_model=None)
async def root():
    index = _FRONTEND_DIR / "index.html"
    if index.exists():
        return FileResponse(str(index))
    return JSONResponse({"message": "Garage Sale Helper API — frontend not deployed"})


if _FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(_FRONTEND_DIR)), name="frontend")
