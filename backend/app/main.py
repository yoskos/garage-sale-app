import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .auth import HmacMiddleware
from .cache import get_cached_price, store_price
from .claude_client import identify_and_price
from .db import get_conn, init_db
from .images import preprocess_image
from .schemas import HealthResponse, PriceResponse, SaleRequest, SaleResponse, SummaryResponse
from .settings import settings

_MAX_IMAGE_BYTES = 4 * 1024 * 1024  # 4 MB
_FRONTEND_DIR = Path(__file__).parent.parent.parent / "frontend"

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
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Timestamp", "X-Signature"],
)


@app.on_event("startup")
def startup() -> None:
    import os
    os.makedirs(settings.cache_dir, exist_ok=True)
    init_db()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(ok=True)


@app.post("/price", response_model=PriceResponse)
async def price_item(
    request: Request,
    image: UploadFile = File(...),
    notes: str | None = Form(None),
) -> PriceResponse:
    _check_rate_limit(request)

    data = await image.read()
    if len(data) > _MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 4 MB)")

    try:
        processed, image_hash = preprocess_image(data)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image")

    notes_key = notes or ""
    cached = get_cached_price(image_hash, notes_key)
    if cached is not None:
        return PriceResponse(cache_hit=True, request_id=cached["_request_id"], **{
            k: v for k, v in cached.items() if not k.startswith("_")
        })

    try:
        result = await identify_and_price(processed, notes)
    except Exception:
        raise HTTPException(status_code=503, detail="Claude API unavailable")

    request_id = str(uuid.uuid4())
    store_price(image_hash, notes_key, request_id, {**result, "_request_id": request_id})

    return PriceResponse(
        cache_hit=False,
        request_id=request_id,
        item=result["item"],
        condition_observed=result["condition_observed"],
        suggested_price_usd=result["suggested_price_usd"],
        price_range_usd=result["price_range_usd"],
        rationale=result["rationale"],
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
