import asyncio
import base64
import json

import anthropic

from .settings import settings

_SYSTEM_PROMPT = """\
You are a pricing assistant for a family garage sale in suburban New Jersey, \
USA. Given a photo of an item (and optional notes), respond ONLY with JSON \
matching this schema:

{
  "item": "<concise description, max 80 chars>",
  "condition_observed": "<what you can see; flag damage>",
  "suggested_price_usd": <integer or .50 increments>,
  "price_range_usd": [<low>, <high>],
  "rationale": "<one sentence>"
}

Rules:
- Garage sale prices, not retail or eBay. Typical: clothes $1-5, books \
$0.50-3, kitchenware $1-15, electronics $5-40, furniture $10-100.
- If item appears collectible/vintage/branded, price higher within reason.
- If you cannot identify the item, set item to "unidentified" and suggest $1.
- Do not include any text outside the JSON object.\
"""

_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
    return _client


async def identify_and_price(image_bytes: bytes, notes: str | None) -> dict:
    client = _get_client()
    image_b64 = base64.standard_b64encode(image_bytes).decode()

    user_content: list[dict] = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": image_b64,
            },
        }
    ]
    if notes:
        user_content.append({"type": "text", "text": f"Notes: {notes}"})

    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            response = await client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=512,
                system=[
                    {
                        "type": "text",
                        "text": _SYSTEM_PROMPT,
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
                messages=[{"role": "user", "content": user_content}],
            )
            text = next(
                b.text for b in response.content if b.type == "text"
            )
            return json.loads(text)
        except anthropic.APIStatusError as exc:
            last_exc = exc
            if attempt < 2:
                await asyncio.sleep(2**attempt)  # 1s, then 2s

    raise last_exc  # type: ignore[misc]
