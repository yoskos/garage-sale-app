import json
import time

from .db import get_conn


def get_cached_price(image_hash: str, notes: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT response_json FROM price_cache WHERE image_hash = ? AND notes = ?",
            (image_hash, notes),
        ).fetchone()
    return json.loads(row["response_json"]) if row else None


def store_price(image_hash: str, notes: str, request_id: str, response: dict) -> None:
    with get_conn() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO price_cache
               (image_hash, notes, request_id, response_json, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (image_hash, notes, request_id, json.dumps(response), int(time.time())),
        )
