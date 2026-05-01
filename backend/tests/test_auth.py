import hashlib
import hmac
import time

import pytest
from fastapi.testclient import TestClient


def _make_headers(body: bytes, secret: str, drift: int = 0) -> dict:
    ts = str(int(time.time()) + drift)
    body_hash = hashlib.sha256(body).hexdigest()
    msg = f"{ts}:{body_hash}".encode()
    sig = hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()
    return {"x-timestamp": ts, "x-signature": sig}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("SHARED_SECRET", "testsecret")

    from app.settings import settings
    from app.main import app
    from app.db import init_db

    monkeypatch.setattr(settings, "database_path", str(tmp_path / "test.db"))
    monkeypatch.setattr(settings, "cache_dir", str(tmp_path / "cache"))
    monkeypatch.setattr(settings, "shared_secret", "testsecret")
    init_db()
    return TestClient(app, raise_server_exceptions=False)


def test_valid_signature_accepted(client):
    body = b"{}"
    headers = _make_headers(body, "testsecret")
    resp = client.post("/sale", content=body, headers={**headers, "content-type": "application/json"})
    # 422 (validation) means auth passed; 401 means it didn't
    assert resp.status_code != 401


def test_bad_signature_rejected(client):
    body = b"{}"
    headers = _make_headers(body, "wrongsecret")
    resp = client.post("/sale", content=body, headers={**headers, "content-type": "application/json"})
    assert resp.status_code == 401


def test_stale_timestamp_rejected(client):
    body = b"{}"
    headers = _make_headers(body, "testsecret", drift=-120)
    resp = client.post("/sale", content=body, headers={**headers, "content-type": "application/json"})
    assert resp.status_code == 401


def test_health_needs_no_auth(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
