import pytest
from fastapi.testclient import TestClient


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
    return TestClient(app)


def test_log_sale_and_summary(client):
    payload = {
        "request_id": "abc-123",
        "item_label": "Pyrex bowl",
        "suggested_price_usd": 8.0,
        "sold_price_usd": 6.0,
        "sold": True,
        "notes": "haggled down",
    }
    resp = client.post("/sale", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["logged"] is True
    assert isinstance(data["id"], int)

    resp2 = client.get("/summary")
    assert resp2.status_code == 200
    summary = resp2.json()
    assert summary["total_items_sold"] == 1
    assert summary["total_revenue_usd"] == 6.0
    assert abs(summary["avg_discount_vs_suggested"] - 0.25) < 1e-6


def test_log_unsold(client):
    payload = {
        "item_label": "Broken lamp",
        "suggested_price_usd": 5.0,
        "sold_price_usd": None,
        "sold": False,
    }
    resp = client.post("/sale", json=payload)
    assert resp.status_code == 200

    resp2 = client.get("/summary")
    summary = resp2.json()
    assert summary["total_items_sold"] == 0
    assert summary["total_revenue_usd"] == 0.0
