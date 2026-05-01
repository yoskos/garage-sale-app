# Frontend Specification — Garage Sale Helper (Web)

## Purpose

Replace the Android app with a mobile web app served directly from the FastAPI backend.
Helpers open `https://garage.yoskos.com` on any phone, enter the shared secret once, and get
the same tap-photo → price → sold/skip flow. No APK, no install.

## Architecture change vs Android

| Concern | Android | Web |
|---|---|---|
| Distribution | APK sideload via USB/adb | Open URL in browser |
| Camera | CameraX live preview | OS camera via `<input capture>` |
| HMAC signing | Kotlin / `javax.crypto` | Browser `SubtleCrypto` (async) |
| Secret storage | `EncryptedSharedPreferences` | `localStorage` (see security note) |
| Local history | Room DB | None — server `/summary` only |
| Build | Gradle | None — static files, no build step |
| CORS | N/A | Same-origin (frontend served by FastAPI) |

The frontend is served as static files by FastAPI itself, making all `/price`, `/sale`, and
`/summary` calls same-origin. No CORS headers are required.

## Stack

- **HTML5 + vanilla JS (ES2022)** — no framework. The app is ~3 screens and has a one-day
  lifespan; a framework would add more complexity than it removes.
- **No build step.** Three files: `index.html`, `app.js`, `style.css`. Deploy by copying to the
  droplet alongside the backend.
- **Web Crypto API** (`SubtleCrypto`) for HMAC-SHA256 — available in all modern browsers over
  HTTPS. No third-party crypto library needed.
- **Fetch API** for HTTP.
- **Canvas 2D API** for image downscaling and EXIF stripping.
- **`localStorage`** for persisting server URL and shared secret across page reloads.

## Security model

### What's the same as Android
- HMAC-SHA256 auth on every request: `X-Timestamp` + `X-Signature` headers, same algorithm.
- Replay protection via 60-second timestamp window — enforced server-side, unchanged.
- HTTPS only — Caddy/Let's Encrypt, unchanged.
- Rate limit 30 req/min/IP — unchanged.

### What changes

**Secret in `localStorage` instead of `EncryptedSharedPreferences`.**
`localStorage` is not encrypted at rest, but:
- It is scoped to the exact origin (`https://garage.yoskos.com`). No other site can read it.
- The droplet hosts no other web content, so there is no cross-origin or XSS vector.
- The secret authorises pricing requests for one day, contains no PII, and has no monetary
  value beyond a 30 req/min API budget.
- Risk accepted: device theft during the sale window. Acceptable for this use case.

**CORS must be enabled on the backend.** Even though API calls are same-origin in production,
enabling CORS for the frontend origin lets the app work when running locally during development
(`http://localhost:5500`). Restrict to the production origin only:

```
Access-Control-Allow-Origin: https://garage.yoskos.com
```

Add this to `backend/app/main.py` via FastAPI's `CORSMiddleware`. Update the backend spec
`CORS: disabled` note accordingly.

**No QR scanner.** The browser camera API can scan QR codes via `BarcodeDetector` but it is
not supported in Firefox or Safari as of 2024. Instead: the deploy script prints the shared
secret as plain text and as a QR code (for the URL + secret JSON). Helpers paste the secret
manually — this happens once before the sale and takes 10 seconds.

**`SubtleCrypto` requires HTTPS.** `crypto.subtle` is `undefined` on plain HTTP. This is
enforced by the browser, not the app. Any accidental HTTP load will show a clear error banner
rather than silently failing HMAC.

## UX flow

The app is a single HTML page with four views. Views are shown/hidden with CSS; there is no
client-side router.

### View 1 — Setup

Shown when `localStorage` has no saved config, or when the user taps "Settings".

- Two inputs: **Server URL** (`https://garage.yoskos.com`) and **Shared Secret**.
- **Test** button — calls `/health`, shows ✓ or ✗ inline.
- **Save** button — writes both values to `localStorage`, switches to Capture view.
- If `SubtleCrypto` is unavailable (plain HTTP), show a red banner: "Must be opened over HTTPS".

### View 2 — Capture (main screen)

- Large **"Take Photo"** button (full-width, prominent). Tapping it triggers:
  ```html
  <input type="file" accept="image/*" capture="environment">
  ```
  The OS camera opens; the user takes a shot; the file is returned to the page.
- **Notes** field (single line, collapsed by default, toggled by a small link).
- After the file is received:
  1. Downscale + JPEG-encode via canvas (see Image Processing below).
  2. Compute HMAC headers (see Signing below).
  3. POST to `/price` as `multipart/form-data`.
  4. Show a loading overlay with elapsed seconds ("Identifying… 3s").
  5. On success → switch to Result view.
  6. On error → show inline error message with a Retry button (photo kept in memory).
- Top-right: small **"History"** link → switches to History view.
- Top-left: small **"Settings"** link → switches to Setup view.

### View 3 — Result

- **Item name** (large).
- **Suggested price** in large bold (e.g. **$8**).
- **Range** below (e.g. "Range $5 – $12").
- **Condition** and **rationale** in smaller gray text.
- **"Cached"** badge if `cache_hit: true`.
- Three buttons:
  - **Sold** — reveals an inline numeric input prefilled with the suggested price and a
    **Confirm** button. On confirm, POSTs to `/sale` with `sold: true`. Returns to Capture.
  - **Not sold** — POSTs to `/sale` with `sold: false`. Returns to Capture.
  - **Re-shoot** — discards result, returns to Capture without any POST.

### View 4 — History

- Calls `GET /summary` on load. Displays:
  - Items priced, items sold, total revenue, average discount.
  - Top items list.
- A **Refresh** button re-calls `/summary`.
- **Back** link returns to Capture.
- No local storage of events. The server is the source of truth.

## Image processing

Done client-side in JS before upload, using `<canvas>`. This strips EXIF automatically
(canvas redraw does not copy EXIF metadata).

```javascript
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const maxEdge = 1568;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = new OffscreenCanvas(
    Math.round(bitmap.width * scale),
    Math.round(bitmap.height * scale),
  );
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
}
```

`OffscreenCanvas` is supported in all modern mobile browsers. If unavailable, fall back to a
regular `<canvas>` element.

## HMAC signing

```javascript
async function sha256Hex(data /* ArrayBuffer */) {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sign(secret, bodyBytes /* Uint8Array */) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = await sha256Hex(bodyBytes);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${bodyHash}`));
  const sig = [...new Uint8Array(sigBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { ts, sig };
}
```

For `multipart/form-data` requests: the body to sign is the raw `Uint8Array` of the
`FormData`-encoded bytes, same as the server receives. Because `fetch` serialises `FormData`
internally (not accessible before sending), sign the raw image `Blob` bytes and notes string
concatenated with a fixed separator — **matching whatever the backend verifies**.

> **Implementation note:** The simplest approach that avoids re-implementing multipart
> serialisation is to move signing to a JSON wrapper: send image as base64 inside a JSON body
> for `/price`. This makes the body bytes deterministic on both sides. Document the deviation
> from the multipart spec in the implementation if this approach is taken.

## Backend changes required

1. **Serve static files:** Mount `frontend/` as static files in `main.py`:
   ```python
   from fastapi.staticfiles import StaticFiles
   from fastapi.responses import FileResponse

   app.mount("/static", StaticFiles(directory="frontend"), name="static")

   @app.get("/")
   async def root():
       return FileResponse("frontend/index.html")
   ```
2. **Enable CORS** for the production origin (and optionally localhost for dev):
   ```python
   from fastapi.middleware.cors import CORSMiddleware
   app.add_middleware(
       CORSMiddleware,
       allow_origins=["https://garage.yoskos.com"],
       allow_methods=["GET", "POST"],
       allow_headers=["X-Timestamp", "X-Signature", "Content-Type"],
   )
   ```
3. **`/price` endpoint:** If the base64-JSON approach is chosen for signing simplicity, add a
   `POST /price/json` variant that accepts `{"image_b64": "...", "notes": "..."}` and decodes
   before passing to the same processing pipeline.

## Project layout

```
frontend/
├── index.html      # single page; all views present, hidden via CSS class
├── app.js          # all app logic (~300 lines)
└── style.css       # mobile-first, minimal
```

Deployed to `/opt/garage-sale-app/frontend/` on the droplet alongside `backend/`.
`deploy.sh` should `cp -r frontend/ /opt/garage-sale-app/frontend/` or include it in the git
clone (already handled if the repo is cloned to `/opt/garage-sale-app`).

## Performance targets

- Time from shutter-tap (OS camera return) to result on screen: ≤ 6 s on LTE.
- Image upload payload: ≤ 400 KB after canvas downscale.
- Page load to camera-ready: ≤ 1 s (no framework, no bundler).

## Error handling

| Condition | Behaviour |
|---|---|
| `SubtleCrypto` unavailable (HTTP) | Red banner on page load; all buttons disabled |
| Network error | Inline error + Retry button; photo kept in memory |
| 401 | Error message "Bad signature — re-check setup" + link to Settings |
| 413 | "Image too large — try again" (defensive; canvas should prevent this) |
| 429 | "Slow down a sec" |
| 5xx | "Server error" + `request_id` if present in response body |

## Distribution

None. Helpers open `https://garage.yoskos.com` in their phone browser. Add to home screen
(PWA-lite: add a `<meta name="mobile-web-app-capable">` tag) for a more app-like experience.
No App Store, no sideloading, no Gradle.

## Acceptance criteria

- Fresh open → Setup → first photo submitted in under 90 seconds.
- Three phones can use the same shared secret simultaneously.
- Closing and reopening the browser tab preserves setup state (via `localStorage`).
- `/health` test in Setup shows ✓ before saving.
- Image sent to server is ≤ 400 KB.
- HMAC signature is accepted by the server (same algorithm as the backend `auth.py` verifies).

## Out of scope

- PWA offline mode / service worker
- QR code scanning for setup (paste is sufficient)
- Dark mode
- Localization
- Tablet layout
