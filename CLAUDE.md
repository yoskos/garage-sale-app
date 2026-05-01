# CLAUDE.md

Project context for Claude Code.

## What this is

A throwaway, one-day-use internal app for managing a family garage sale. An Android app sends photos to a DigitalOcean-hosted FastAPI backend, which calls the Anthropic API for item identification and price suggestions, and logs sale outcomes to SQLite.

## Hard constraints

- **No PII, no real users, no accounts.** Don't add login pages, password reset flows, or "user" tables.
- **One-day lifespan.** Don't add migrations, backup schedules, or replication.
- **Two repos in one tree:** `backend/` (Python) and `android/` (Kotlin). Don't cross-contaminate.
- **API key is local only.** Never log it, never put it in error messages, never check it into git.
- **Authentication is HMAC-SHA256 with a shared secret + timestamp.** Don't reach for OAuth, JWTs, or mTLS.

## Where things live

- `docs/backend-spec.md` — authoritative spec for the FastAPI service.
- `docs/android-spec.md` — authoritative spec for the Android app.
- `README.md` — environment setup and deploy notes.

When implementing, read the relevant spec first, then build to it. If the spec is ambiguous, ask before guessing.

## Style

- Backend: Python 3.12, type hints everywhere, `pydantic` models for request/response, `ruff` for lint.
- Android: Kotlin, Jetpack Compose, manual DI (no Hilt — overkill here).
- Keep files small. If a file exceeds 200 lines, consider splitting.

## Don't do

- Don't add features not in the spec without asking.
- Don't add Docker, Kubernetes, or CI/CD. This deploys via a single shell script to one droplet.
- Don't add web frontends, admin panels, or dashboards.
- Don't add analytics, telemetry, or crash reporting.
