# Trusted Preview & HTML Sandboxing

Sangam allows previewing rich HTML, interactive widgets, and rendered Markdown documents. To prevent cross-site scripting (XSS) or malicious scripts from accessing Sangam session tokens or database endpoints, previews are isolated inside a dedicated sandboxed iframe on an isolated origin.

## Sub-features

- `preview-origin-isolation`: Ensures preview assets are served from `SANGAM_TRUSTED_PREVIEW_HOST` (e.g., `preview.localhost`).
- `preview-csp`: Validates Content Security Policy (CSP) headers restricting script execution, frame ancestors, and parent communication origins.
- `preview-render`: Confirms that previewing an HTML note produces the expected DOM tree inside the sandboxed preview iframe.

## How to get to it (user POV)

- Open a document in the Sangam browser UI and toggle the "Preview" tab.
- Send `GET /api/v1/documents/<DOC_ID>/preview` or access `/trusted-preview/`.

## Driving it with control-sangam

Preconditions:
- Instance is healthy via `./scripts/control-sangam.sh doctor`.
- `SANGAM_TRUSTED_PREVIEW_HOST` and `SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS` are set (configured automatically by `control-sangam.sh`).

### 1. Verify Preview Headers
Fetch the preview endpoint and assert security headers:
```bash
curl -I "http://127.0.0.1:8765/api/v1/health"
```
Ensure proper CORS and frame ancestor restrictions exist between `127.0.0.1` and `preview.localhost`.

### 2. Browser Verification (Playwright)
Run the dedicated Playwright spec exercising preview isolation:
```bash
pnpm --dir frontend exec playwright test e2e/html-javascript.spec.ts
```
Expected: All preview sandboxing tests pass without leaking cookies or auth headers to iframe content.

## Gotchas

- Local DNS for `preview.localhost` must resolve to `127.0.0.1` (standard in modern macOS / Linux resolvers).
- Previews must never be served directly on the primary API origin without sandboxing.
