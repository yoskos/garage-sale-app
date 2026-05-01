# Android App Specification — Garage Sale Helper

## Purpose

Hand a phone to a family helper at the garage sale. They tap one big button, point at an item, and within a few seconds see "Vintage Pyrex bowl — $8 (range $5-12)". After the sale, they tap "Sold $6" or "Skip". That's the whole app.

## Stack

- **Language:** Kotlin
- **UI:** Jetpack Compose (Material 3)
- **Min SDK:** 26 (Android 8.0)
- **Target SDK:** 35
- **Camera:** CameraX
- **HTTP:** OkHttp + kotlinx-serialization
- **DI:** none (manual; the app is tiny)
- **Build:** Gradle (Kotlin DSL)

## UX flow

The app has 3 screens, navigated via Compose Navigation.

### Screen 1 — Setup (first launch only)

- Big text: "Paste server URL and shared secret"
- Two text fields: `Server URL`, `Shared Secret`
- Or: tap "Scan QR" — uses CameraX + ML Kit barcode scanning to read a QR encoding `{"url":"...", "secret":"..."}`
- "Test connection" button → calls `/health`, shows ✓ or ✗
- "Save" stores values via EncryptedSharedPreferences and navigates to Screen 2.

### Screen 2 — Capture (the main screen)

Layout, top to bottom:

1. **CameraX preview** filling ~70% of screen.
2. **Optional notes field** (single line, collapsible, default collapsed).
3. **Big circular shutter button** at the bottom.

On shutter tap:

1. Capture frame (CameraX `ImageCapture`).
2. Downscale to longer-edge 1568 px, JPEG quality 80, strip EXIF — all on a background thread.
3. Compute HMAC headers using `EncryptedSharedPreferences` secret.
4. POST to `/price`. Show a determinate loading spinner with elapsed seconds.
5. On response, navigate to Screen 3 with the result.
6. On error, show a snackbar ("server unreachable / 401 / 503") and stay on Screen 2.

Top-right corner: small icon → opens History (lightweight list of today's prices).

### Screen 3 — Result + Log Sale

Card layout:

- Item name (large)
- Suggested price in big bold (e.g. **$8**)
- Range below it (e.g. "Range $5-12")
- Condition + rationale (smaller, gray)
- Cache-hit badge if `cache_hit: true`

Three buttons:

- **Sold** — opens a small dialog: "Sold for $___" (numeric input, prefilled with suggested price). On confirm, POSTs to `/sale` with `sold: true`. Returns to Screen 2.
- **Skip / Not sold** — POSTs to `/sale` with `sold: false`. Returns to Screen 2.
- **Re-shoot** — discards result, returns to Screen 2 without logging.

### Hidden screen — History

- Reverse-chronological list of today's `/price` and `/sale` events stored in a local Room DB (independent of the server log; serves as offline reference).
- Pull-to-refresh calls `/summary` and shows totals at the top.

## Project layout

```
android/
├── app/
│   ├── build.gradle.kts
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/example/garagesale/
│       │   ├── MainActivity.kt
│       │   ├── ui/
│       │   │   ├── SetupScreen.kt
│       │   │   ├── CaptureScreen.kt
│       │   │   ├── ResultScreen.kt
│       │   │   ├── HistoryScreen.kt
│       │   │   └── theme/
│       │   ├── data/
│       │   │   ├── ApiClient.kt          # OkHttp + HMAC interceptor
│       │   │   ├── HmacSigner.kt
│       │   │   ├── ImagePrep.kt          # downscale + EXIF strip
│       │   │   ├── SecureStore.kt        # EncryptedSharedPreferences
│       │   │   ├── LocalDb.kt            # Room database
│       │   │   └── models/               # @Serializable data classes
│       │   └── viewmodel/
│       │       ├── CaptureViewModel.kt
│       │       └── ResultViewModel.kt
│       └── res/
├── build.gradle.kts
└── settings.gradle.kts
```

## HMAC signing implementation

Pseudocode for the OkHttp interceptor:

```kotlin
val ts = (System.currentTimeMillis() / 1000).toString()
val bodyBytes = request.body?.bytes() ?: ByteArray(0)
val bodyHash = sha256Hex(bodyBytes)
val toSign = "$ts:$bodyHash"
val sig = hmacSha256Hex(secret, toSign)

val signed = request.newBuilder()
    .header("X-Timestamp", ts)
    .header("X-Signature", sig)
    .method(request.method, RequestBody.create(request.body?.contentType(), bodyBytes))
    .build()
```

## Local DB (Room)

```kotlin
@Entity
data class LocalEvent(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val type: String,             // "price" or "sale"
    val itemLabel: String,
    val suggestedPrice: Double?,
    val soldPrice: Double?,
    val sold: Boolean?,
    val requestId: String?,
    val createdAt: Long
)
```

## Permissions

In `AndroidManifest.xml`:

- `CAMERA` (required)
- `INTERNET` (required)

No location, no storage, no contacts.

Use runtime permission flow on first camera use (Compose `rememberPermissionState` from accompanist or the platform equivalent).

## Performance targets

- Time from shutter-tap to result on screen: ≤ 6 s on a mid-tier phone over LTE.
- Image upload payload: ≤ 400 KB after downscale.
- App cold start to camera ready: ≤ 2 s.

## Error handling

- **Network error** → snackbar with retry action.
- **401** → toast "Bad signature, re-check setup" and route to Setup screen.
- **413** → snackbar "Image too large — try again" (shouldn't happen after downscale, but defensive).
- **429** → snackbar "Slow down a sec".
- **5xx** → snackbar with `request_id` if present.

All errors keep the captured photo in memory so the user can retry without re-shooting.

## Distribution

- Build a release APK (`./gradlew assembleRelease`) signed with a debug keystore — fine for one day, internal use.
- Sideload to the 2-3 family phones via USB or `adb install`.
- No Play Store submission.

## Acceptance criteria

- Fresh install → Setup → Capture flow takes under 60 seconds.
- Three phones can use the same shared secret simultaneously without conflict.
- App works offline-tolerant for History (reads local DB) but `/price` and `/sale` clearly require network.
- Killing and reopening the app preserves setup state.

## Out of scope

- Light/dark theme switching (default Material You)
- Localization (English only)
- Tablet layout
- Background sync / queueing of failed `/sale` calls
