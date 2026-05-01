import hashlib
import hmac
import time

from fastapi import Header, HTTPException, Request

from .settings import settings

_TIMESTAMP_TOLERANCE = 60  # seconds


async def verify_hmac(
    request: Request,
    x_timestamp: str = Header(...),
    x_signature: str = Header(...),
) -> None:
    try:
        ts = int(x_timestamp)
    except ValueError:
        raise HTTPException(status_code=401, detail="Invalid timestamp")

    if abs(time.time() - ts) > _TIMESTAMP_TOLERANCE:
        raise HTTPException(status_code=401, detail="Stale timestamp")

    body = await request.body()
    body_hash = hashlib.sha256(body).hexdigest()
    message = f"{x_timestamp}:{body_hash}".encode()

    expected = hmac.new(
        settings.shared_secret.encode(),
        message,
        hashlib.sha256,
    ).hexdigest()

    if not hmac.compare_digest(expected, x_signature):
        raise HTTPException(status_code=401, detail="Invalid signature")
