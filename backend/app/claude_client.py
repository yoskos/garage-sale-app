import asyncio
import base64
import json
import logging
import re

import anthropic

from .settings import settings

log = logging.getLogger(__name__)

_VISION_MODEL  = "claude-sonnet-4-6"   # fast vision: identify item + condition
_PRICING_MODEL = "claude-opus-4-7"     # deep knowledge: garage + retail pricing

_VISION_SYSTEM = """\
You identify items in garage sale photos. Given one or more photos, respond ONLY \
with JSON matching this schema exactly:

{
  "item": "<concise description, max 80 chars>",
  "condition_observed": "<what you can see about the item's condition; flag visible damage>"
}

If you cannot identify the item, set item to "unidentified".
Do not include any text outside the JSON object.\
"""

_PRICING_SYSTEM = """\
You are a pricing expert for a family garage sale in suburban New Jersey, USA. \
Given an item name, its condition, and optional seller notes, respond ONLY with \
JSON matching this schema exactly:

{
  "suggested_price_usd": <integer or .50 increment>,
  "price_range_usd": [<low>, <high>],
  "retail_price_new_usd": <number or null>,
  "rationale": "<one sentence>"
}

Rules:
- Garage sale prices only. Typical: clothes $1–5, books $0.50–3, kitchenware \
$1–15, electronics $5–40, furniture $10–100.
- If item appears collectible, vintage, or branded, price higher within reason.
- If item is "unidentified", suggest $1, null for retail.
- retail_price_new_usd: approximate cost to buy new at retail today. \
Use null only if genuinely unknown or not applicable (handmade items, antiques \
with no modern equivalent, purely decorative pieces with no market).
Do not include any text outside the JSON object.\
"""

_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
    return _client


def _parse_json(text: str, label: str, stop_reason: str) -> dict:
    log.info("%s stop_reason=%s text=%r", label, stop_reason, text[:200])
    text = re.sub(r"^```(?:json)?\s*", "", text.strip(), flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    if not text:
        raise ValueError(f"Empty {label} response (stop_reason={stop_reason})")
    return json.loads(text)


async def _call(client, model: str, system: str, content: list[dict], max_tokens: int) -> dict:
    response = await client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": content}],
    )
    text = next((b.text for b in response.content if b.type == "text"), "")
    return _parse_json(text, model, response.stop_reason)


async def identify_and_price(images_bytes: list[bytes], notes: str | None) -> dict:
    client = _get_client()

    last_exc: Exception | None = None
    for attempt in range(3):
        try:
            # Pass 1: Sonnet identifies the item and assesses condition from images.
            vision_content: list[dict] = [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": base64.standard_b64encode(b).decode(),
                    },
                }
                for b in images_bytes
            ]
            if notes:
                vision_content.append({"type": "text", "text": f"Notes: {notes}"})

            identification = await _call(
                client, _VISION_MODEL, _VISION_SYSTEM, vision_content, max_tokens=256
            )

            # Pass 2: Opus prices the identified item (text-only, no image tokens).
            pricing_text = f"Item: {identification['item']}\nCondition: {identification['condition_observed']}"
            if notes:
                pricing_text += f"\nSeller notes: {notes}"

            pricing = await _call(
                client, _PRICING_MODEL, _PRICING_SYSTEM,
                [{"type": "text", "text": pricing_text}],
                max_tokens=256,
            )

            return {**identification, **pricing}

        except anthropic.APIStatusError as exc:
            last_exc = exc
            if attempt < 2:
                await asyncio.sleep(2 ** attempt)

    raise last_exc  # type: ignore[misc]
