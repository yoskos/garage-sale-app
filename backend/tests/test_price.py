import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image


def _make_jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (100, 100), color=(128, 64, 32)).save(buf, format="JPEG")
    return buf.getvalue()


FAKE_RESPONSE = {
    "item": "Test mug",
    "condition_observed": "good",
    "suggested_price_usd": 2,
    "price_range_usd": [1, 3],
    "rationale": "Common kitchen item.",
}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("SHARED_SECRET", "testsecret")

    from app.settings import settings
    from app.main import app
    from app.db import init_db
    from app.auth import verify_hmac

    monkeypatch.setattr(settings, "database_path", str(tmp_path / "test.db"))
    monkeypatch.setattr(settings, "cache_dir", str(tmp_path / "cache"))
    monkeypatch.setattr(settings, "shared_secret", "testsecret")
    monkeypatch.setitem(app.dependency_overrides, verify_hmac, lambda: None)
    init_db()
    return TestClient(app, raise_server_exceptions=True)


def test_price_cache_miss_then_hit(client, monkeypatch):
    import app.main as app_main

    call_count = 0

    async def fake_identify(image_bytes, notes):
        nonlocal call_count
        call_count += 1
        return FAKE_RESPONSE

    monkeypatch.setattr(app_main, "identify_and_price", fake_identify)

    jpeg = _make_jpeg()

    # First call — cache miss, hits Claude
    resp = client.post("/price", files={"image": ("item.jpg", jpeg, "image/jpeg")})
    assert resp.status_code == 200
    data = resp.json()
    assert data["item"] == "Test mug"
    assert data["cache_hit"] is False
    assert "request_id" in data
    assert call_count == 1

    # Second call with same image — cache hit
    resp2 = client.post("/price", files={"image": ("item.jpg", jpeg, "image/jpeg")})
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["cache_hit"] is True
    assert call_count == 1  # Claude not called again


def test_price_too_large(client):
    big = b"X" * (4 * 1024 * 1024 + 1)
    resp = client.post("/price", files={"image": ("big.jpg", big, "image/jpeg")})
    assert resp.status_code == 413
