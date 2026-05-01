import contextlib
import sqlite3

from .settings import settings

_DDL = """
CREATE TABLE IF NOT EXISTS price_cache (
    image_hash TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    request_id TEXT NOT NULL,
    response_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (image_hash, notes)
);

CREATE TABLE IF NOT EXISTS sales_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT,
    item_label TEXT NOT NULL,
    suggested_price_usd REAL,
    sold_price_usd REAL,
    sold INTEGER NOT NULL,
    notes TEXT,
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_created ON sales_log(created_at);
"""


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(_DDL)


@contextlib.contextmanager
def get_conn():
    conn = sqlite3.connect(settings.database_path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
