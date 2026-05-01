import hashlib
import hmac
import time

from starlette.types import ASGIApp, Receive, Scope, Send

from .settings import settings

_TIMESTAMP_TOLERANCE = 60  # seconds
_EXEMPT_PREFIXES = ("/health", "/static", "/")


def _is_exempt(path: str) -> bool:
    if path == "/":
        return True
    return path.startswith("/health") or path.startswith("/static")


class HmacMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or _is_exempt(scope.get("path", "/")):
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        x_timestamp = headers.get(b"x-timestamp", b"").decode()
        x_signature = headers.get(b"x-signature", b"").decode()

        if not x_timestamp or not x_signature:
            await _send_401(send, "Missing auth headers")
            return

        try:
            ts = int(x_timestamp)
        except ValueError:
            await _send_401(send, "Invalid timestamp")
            return

        if abs(time.time() - ts) > _TIMESTAMP_TOLERANCE:
            await _send_401(send, "Stale timestamp")
            return

        # Read the entire body before FastAPI's form parser consumes the stream.
        body = await _read_body(receive)

        body_hash = hashlib.sha256(body).hexdigest()
        message = f"{x_timestamp}:{body_hash}".encode()
        expected = hmac.new(
            settings.shared_secret.encode(),
            message,
            hashlib.sha256,
        ).hexdigest()

        if not hmac.compare_digest(expected, x_signature):
            await _send_401(send, "Invalid signature")
            return

        # Replay the body so downstream (form parser) can read it.
        replay_done = False

        async def replay_receive() -> dict:
            nonlocal replay_done
            if not replay_done:
                replay_done = True
                return {"type": "http.request", "body": body, "more_body": False}
            return {"type": "http.disconnect"}

        await self.app(scope, replay_receive, send)


async def _read_body(receive: Receive) -> bytes:
    chunks: list[bytes] = []
    while True:
        msg = await receive()
        chunks.append(msg.get("body", b""))
        if not msg.get("more_body", False):
            break
    return b"".join(chunks)


async def _send_401(send: Send, detail: str) -> None:
    import json
    body = json.dumps({"detail": detail}).encode()
    await send({
        "type": "http.response.start",
        "status": 401,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ],
    })
    await send({"type": "http.response.body", "body": body})
