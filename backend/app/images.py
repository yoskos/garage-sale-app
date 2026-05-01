import hashlib
import io

from PIL import Image

_MAX_EDGE = 1568
_JPEG_QUALITY = 80


def preprocess_image(data: bytes) -> tuple[bytes, str]:
    """Resize to ≤1568px on the long edge, strip EXIF, encode JPEG q80.

    Returns (processed_bytes, sha256_hex).
    """
    img = Image.open(io.BytesIO(data))

    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")

    w, h = img.size
    if max(w, h) > _MAX_EDGE:
        ratio = _MAX_EDGE / max(w, h)
        img = img.resize((int(w * ratio), int(h * ratio)), Image.LANCZOS)

    buf = io.BytesIO()
    # Saving without exif= strips EXIF metadata
    img.save(buf, format="JPEG", quality=_JPEG_QUALITY)
    result = buf.getvalue()

    image_hash = hashlib.sha256(result).hexdigest()
    return result, image_hash
