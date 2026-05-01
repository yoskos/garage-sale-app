# Backend Specification — Garage Sale Helper

## Purpose

Receive item photos from the Android app, ask Claude to identify the item and suggest a fair garage-sale price, return the result, and log every sale outcome to a small SQLite database. Optimized for speed and one-day use.

## Stack

- **Language / framework:** Python 3.12, FastAPI, Uvicorn
- **HTTP client:** `anthropic` official SDK
- **DB:** SQLite (single file, `garage_sale.db`)
- **Image cache:** local filesystem under `./image_cache/`
- **Hosting:** DigitalOcean droplet (smallest tier, $6/mo, Ubuntu 24.04)
- **TLS:** Caddy reverse proxy with automatic Let's Encrypt cert (or self-signed if no domain)
- **Process manager:** `systemd` unit

## Security model

This app runs for ~24 hours and holds no PII. Keep security simple but real:

1. **Transport:** HTTPS only. Caddy handles TLS termination on port 443; FastAPI listens on `127.0.0.1:8000`.
2. **Authentication:** HMAC-SHA256 shared-secret auth. Every request from the Android app includes:
   - `X-Timestamp: <unix epoch seconds>`
   - `X-Signature: hex(HMAC_SHA256(secret, timestamp + ":" + sha256(body)))`
   - Server rejects requests with timestamp drift > 60 seconds (replay protection).
   - Server rejects requests with bad signature.
3. **No user accounts.** The shared secret is provisioned once into all 2-3 phones via QR code or copy/paste before the sale.
4. **Rate limit:** 30 requests/minute per IP (in-memory token bucket). Sufficient for 3 helpers.
5. **CORS:** disabled (no browser clients).
6. **API key:** `ANTHROPIC_API_KEY` lives in `.env`, loaded via `pydantic-settings`. Never logged.

## Endpoints

All endpoints require HMAC auth headers. All responses are JSON.

### `POST /price`

Identify an item and suggest a price.

**Request body** (multipart/form-data):
- `image`: JPEG/PNG, max 4 MB, max 2048×2048 (the app should downscale before sending)
- `notes` (optional): short free-text hint, e.g. "works, missing remote"

**Response 200:**
```json
{
  "item": "Vintage Pyrex mixing bowl, ~2qt, blue",
  "condition_observed": "good, minor scuff on rim",
  "suggested_price_usd": 8,
  "price_range_usd": [5, 12],
  "rationale": "Pyrex is collectible; blue patterns sell faster than white. Garage sale typical $5-12.",
  "cache_hit": false,
  "request_id": "01HXXXX..."
}
```

**Errors:**
- `401` bad signature / stale timestamp
- `413` image too large
- `429` rate limited
- `503` Claude API unreachable (after 2 retries with backoff)

### `POST /sale`

Log a sale outcome. Called when a helper marks an item as sold (or unsold-end-of-day).

**Request body** (JSON):
```json
{
  "request_id": "01HXXXX...",   // ties back to a /price call (nullable)
  "item_label": "Pyrex bowl",
  "suggested_price_usd": 8,
  "sold_price_usd": 6,
  "sold": true,
  "notes": "haggled down"
}
```

**Response 200:** `{"logged": true, "id": 42}`

### `GET /summary`

End-of-day summary. No request body.

**Response 200:**
```json
{
  "total_items_priced": 87,
  "total_items_sold": 54,
  "total_revenue_usd": 312.50,
  "avg_discount_vs_suggested": 0.18,
  "top_items": [...]
}
```

### `GET /health`

Liveness probe. No auth required. Returns `{"ok": true}`.

## Claude API integration

### Model

`claude-opus-4-7` (or whatever the system surfaces as the latest Opus). Fast enough for photo + short prompt, smart enough for unusual items.

### Prompt strategy

System prompt (cached via prompt caching):

```
You are a pricing assistant for a family garage sale in suburban New Jersey,
USA. Given a photo of an item (and optional notes), respond ONLY with JSON
matching this schema:

{
  "item": "<concise description, max 80 chars>",
  "condition_observed": "<what you can see; flag damage>",
  "suggested_price_usd": <integer or .50 increments>,
  "price_range_usd": [<low>, <high>],
  "rationale": "<one sentence>"
}

Rules:
- Garage sale prices, not retail or eBay. Typical: clothes $1-5, books
  $0.50-3, kitchenware $1-15, electronics $5-40, furniture $10-100.
- If item appears collectible/vintage/branded, price higher within reason.
- If you cannot identify the item, set item to "unidentified" and suggest $1.
- Do not include any text outside the JSON object.
```

Mark this system block with `cache_control: {"type": "ephemeral"}` so subsequent
requests within 5 minutes reuse the prefix at reduced cost.

### Caching layer (server-side)

Before calling Claude:
1. Compute `sha256` of the image bytes.
2. Look up `image_hash` in the `price_cache` table.
3. If hit and `notes` field also matches: return cached response with `cache_hit: true`. No API call.
4. Otherwise, call Claude, store result keyed by `(image_hash, notes)`, return.

This handles the common case of someone re-photographing the same item.

### Input image preprocessing

- Convert to JPEG quality 80 if not already.
- Resize so the longer edge is ≤ 1568 px (Claude vision sweet spot).
- Strip EXIF.

## Database schema

SQLite, created on first boot.

```sql
CREATE TABLE price_cache (
  image_hash TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (image_hash, notes)
);

CREATE TABLE sales_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  item_label TEXT NOT NULL,
  suggested_price_usd REAL,
  sold_price_usd REAL,
  sold INTEGER NOT NULL,
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_sales_created ON sales_log(created_at);
```

## Project layout

```
backend/
├── app/
│   ├── __init__.py
│   ├── main.py            # FastAPI app, route definitions
│   ├── auth.py            # HMAC verify dependency
│   ├── claude_client.py   # Anthropic SDK wrapper, prompt caching
│   ├── cache.py           # image-hash → response lookup
│   ├── db.py              # SQLite connection + schema init
│   ├── images.py          # downscale, hash, EXIF strip
│   ├── settings.py        # pydantic-settings, loads .env
│   └── schemas.py         # pydantic request/response models
├── tests/
│   ├── test_auth.py
│   ├── test_price.py      # mock Claude
│   └── test_sale.py
├── requirements.txt
├── .env.example
├── Caddyfile.example
├── garage-sale.service    # systemd unit
└── deploy.sh              # provisioning script for fresh droplet
```

## Deployment to DigitalOcean

`deploy.sh` should be idempotent and runnable on a fresh Ubuntu 24.04 droplet:

1. Install python3.12, caddy, git.
2. Clone repo to `/opt/garage-sale-app`.
3. Create venv, `pip install -r requirements.txt`.
4. Prompt for `ANTHROPIC_API_KEY` and `SHARED_SECRET`, write to `.env`.
5. Install `garage-sale.service` to `/etc/systemd/system/`, enable + start.
6. Install `Caddyfile` (TLS via Let's Encrypt if a domain is set, otherwise self-signed on the droplet IP).
7. `ufw allow 443; ufw allow 22; ufw enable`.
8. Print the URL and the first-time setup QR for the phones.

## Acceptance criteria

- Cold-start `/price` returns within 5 seconds for a typical photo (~500 KB after downscale).
- Cached `/price` returns within 100 ms.
- HMAC auth rejects forged requests in unit tests.
- `/summary` correctly computes totals from `sales_log`.
- `deploy.sh` brings up a working server from a blank droplet in under 10 minutes.

## Out of scope

- User accounts, roles, login pages
- Multi-day persistence, backups, replication
- Image storage beyond local cache
- Web UI (Android only)
- Payments
