# Phase 3: Isolated Annotation API

Implemented on 2026-09-09 with offline provider fixtures. This is a localhost-only
development API and an opt-in frontend client, not an enabled automation release.
Phase 4 supplies the review screens and explicit detection action. Existing
New Build/Refurbishment editors and the email payload are unchanged.

## Boundaries And Pending Gates

- The service is under `backend/roi_app`; it imports neither `backend/app` nor
  `backend/roi_reference`. Its dependency lock and environment are independent.
- The only provider model is `gemini-3.6-flash`, at temperature `0.5`, with the
  aspect-preserving 1024-pixel maximum image side. No model substitution occurs.
- Live access requires `ROI_ALLOW_LIVE=true` and a server-side `GOOGLE_API_KEY`.
  Neither implementation nor ordinary tests invoke Gemini. Health does not
  construct a provider client or verify model access, even when reporting ready.
- Phase 1 deployment-model access, real response evaluation, category policy,
  original JPEG availability, and domain-reviewed accuracy gates remain open.
  Penetration/outlet prompts are explicitly draft policy, not verified detectors.
- `ROI_STRUCTURED_OUTPUT=false` is the compatibility default. Exact JSON or a
  single JSON code fence is strictly parsed and Pydantic-validated. Enable the
  SDK JSON schema option only after an authorized Phase 1 compatibility run.
  SDK mock transport tests prove serialization, not model support. Thinking
  settings are not sent; automatic function calling is disabled and no tools
  are supplied. Provider defaults may still include thinking.
- Do not expose this service beyond localhost, put it behind a public proxy,
  enable multiple workers, or treat its session token as user authentication.
  Production identity, retention, provider data-processing review, per-user
  budgets, shared storage, and distributed limits are separate approval gates.

## Installation And Startup

Run from the repository root with Python 3.13. The API does not need the old
backend running. The lock contains pinned transitive dependencies and hashes.

```powershell
py -3.13 -m venv backend/roi_app/.venv
& ./backend/roi_app/.venv/Scripts/python.exe -m pip install --require-hashes -r backend/roi_app/requirements.lock
& ./backend/roi_app/.venv/Scripts/python.exe -m pip check
$env:ROI_ALLOW_LIVE = "false"
$env:ROI_ALLOWED_ORIGINS = "http://127.0.0.1:8081,http://127.0.0.1:8082"
& ./backend/roi_app/.venv/Scripts/python.exe -m uvicorn backend.roi_app.main:app --host 127.0.0.1 --port 8091 --workers 1 --no-proxy-headers --no-access-log
```

Use another unused port if 8091 is occupied. Health is at
`http://127.0.0.1:8091/api/roi/v1/health`. An offline service returns
`status: not_configured`, HTTP 200, and the selected model, without a billable call.
Detection returns a structured `provider_not_configured` error while disabled.

The example environment files document settings; the server does not load
dotenv files automatically. Configure server environment variables through the
launching shell or an approved secret manager. Never place the key in a `VITE_*`
variable, command output, fixture, or committed file. Do not enable live calls
until the deployment account and a deliberate call budget are approved.

To regenerate the lock in an isolated tooling environment:

```powershell
& ./backend/roi_app/.venv/Scripts/python.exe -m pip install pip==25.2 pip-tools==7.5.2
& ./backend/roi_app/.venv/Scripts/python.exe -m piptools compile --generate-hashes --strip-extras --no-emit-index-url --no-emit-trusted-host --output-file backend/roi_app/requirements.lock backend/roi_app/requirements.in
```

The tooling pins avoid a tested pip-tools incompatibility with newer pip internals.
No broad upgrade of the frontend or reference dependencies is included.

## HTTP Contract

Every mutating request supplies `Authorization: Bearer <64 lowercase hex digits>`.
The frontend generates a cryptographically random 256-bit token per client
instance, kept only in memory. The service stores its SHA-256 digest as the owner
key. Another token cannot read, detect, or delete a page belonging to that session;
unknown, expired, and other-owner pages all return `page_not_found`. Any local
client can create a session: this is capability ownership, not authenticated users.

| Endpoint | Contract |
| --- | --- |
| `GET /api/roi/v1/health` | Nonbillable configuration readiness; no token required |
| `POST /api/roi/v1/pages` | Multipart fields `image` (PNG/JPEG) and `context` (JSON Phase 2 PageContext) |
| `POST /api/roi/v1/pages/{page_id}/detections` | Phase 2 DetectionRequest plus `accepted_rois` and optional `follow_up_of` |
| `DELETE /api/roi/v1/pages/{page_id}` | HTTP 204; remove the owner's image and cached proposals, cancel associated work |

Upload verifies actual Pillow-decoded dimensions and a hash of uploaded bytes.
Conflicting dimensions/hash or immutable page context return HTTP 409. The
browser's canonical `page_id` is retained; an independent generated `upload_id`
identifies this stored incarnation, alongside the validated context and expiry.
Client page/document identifiers are provenance, not ownership credentials.
Filenames never become storage paths. Animated files, invalid formats, corrupt
images, nontrivial EXIF orientation, and decompression/size violations are rejected.
PDF.js crop/rotation is already in the pixels and is not applied again.

Child requests must include a non-null `roi_revision`, `geometry_revision`, and
unique accepted/current parent snapshots shaped as `{id, revision, box_2d}`.
The API validates their IDs and geometry; acceptance remains a frontend decision.
Roof requests require `roi_revision: null` and no parents. Box coordinates retain
fractions in `[ymin, xmin, ymax, xmax]`, 0-1000. Boundary outlet symbols are allowed;
strict interior containment is not used as a semantic scope test.

Successful responses include envelope identity, suggested annotations, and a
Phase 2-compatible `run`. Null parent/revision fields are explicit. IDs are
application-generated; original/current boxes are separate fields. Nothing
becomes accepted or physical geometry. Run settings record the prompt hash,
image-preparation version, inference hash/dimensions, actual model settings,
attempt count, cache use, duration, and request/ROI/geometry identities. Raw
provider text and drawing filenames are not included in normal error/log output.

The response distinguishes `complete`, `no_detections`, and `partial`.
`no_detections` means only that the provider returned an empty valid array.
Refusal, authentication/model errors, malformed JSON/boxes, truncated JSON,
oversized output, and timeouts are structured errors, not empty successes:

```json
{"error":{"code":"provider_refusal","retryable":false}}
```

## Resource And Request Lifecycle

All settings below are configurable through the corresponding `ROI_*` environment
variable, subject to upper bounds in `config.py`.

| Setting | Default |
| --- | --- |
| `MAX_UPLOAD_BYTES` / `MAX_DECODED_PIXELS` | 20 MiB / 40 million pixels |
| `MAX_IMAGE_PREPARATIONS` / `MAX_HTTP_REQUESTS` | 1 decode / 8 HTTP requests |
| `MAX_RESPONSE_BYTES` / `MAX_ANNOTATIONS` | 256 KiB streamed provider output / 25 objects |
| `MAX_OUTPUT_TOKENS` / `TIMEOUT_SECONDS` | 4096 tokens / 60 seconds for the whole detection including retries |
| `UPLOAD_TIMEOUT_SECONDS` / `MAX_CONCURRENT_REQUESTS` | 30 seconds to receive a body / 2 active detections |
| `MAX_ATTEMPTS` | 2 total; SDK retries disabled |
| `MAX_CALLS_PER_SESSION` / `MAX_TOTAL_CALLS` | 12 / 100 provider attempts per process lifetime |
| `MAX_SESSIONS` / `MAX_PAGES_PER_SESSION` | 20 / 8 |
| `MAX_REQUESTS_PER_SESSION` / `MAX_STORAGE_BYTES` | 100 request IDs / 256 MiB original and inference image bytes |
| `PAGE_TTL_SECONDS` / `CACHE_TTL_SECONDS` | 900 / 300 seconds, absolute lifetimes |
| `SESSION_TTL_SECONDS` / `CLEANUP_INTERVAL_SECONDS` | 3600 / 30 seconds |

Upload body bounds apply even without Content-Length, before multipart parsing.
The parser may spool a large multipart file to the OS temporary directory; its
handle is closed and removed on leaving the upload context. Retained original
images, inference PNGs, and proposal caches live only in process memory. Decode
memory is additional to the retained-byte budget; provision it or lower the
pixel limit. There are no durable page files or public image-fetch endpoints.
OS swap, crash dumps, and underlying temporary-storage controls still need review
before production. Cleanup runs periodically and on API access; shutdown clears
storage. Expired/deleted pages cannot be resurrected by an in-flight result.

Only transient rate limits, selected 5xx responses, and transport failures get
one bounded backoff/retry. Refusals, auth/model/input/schema errors and timeouts
are not retried. Each attempt consumes the budgets. Deleting pages does not
reset session/process call counts. Tokens and process restarts can reset local
budgets, another reason this is not a public service.

Identical request IDs and payloads share the same in-flight/completed result,
including errors, without another provider call. Reusing an ID for different
inputs returns HTTP 409. Success caches include image hash, model, prompt/schema
version and content hash, settings, task, parent IDs/boxes/revisions, and geometry
revision, and are scoped to owner and uploaded page. Cached IDs remain stable and
suggested. The idempotency ledger retains responses until page expiry/deletion;
its tombstones and call counts survive until session expiry. A fresh request ID
is required for a deliberate retry after a terminal response.

A valid array at the object cap or MAX_TOKENS is `partial` with
`possible_truncation`. Invalid truncated JSON remains `truncated_output`.
An explicit new request may set `follow_up_of` to a completed partial request
with identical source/task/parent/settings. At most one follow-up is allowed per
upload. It includes prior proposals as context, consumes normal call budgets,
and remains `partial` with `follow_up_requires_reconciliation`; it is not an
automatic merge or a completeness guarantee. Rerun/review UI is Phase 4 work.

Browser AbortSignals cancel fetch and Phase 2 rejects late results. Disconnecting
does not guarantee provider cancellation: a bounded operation can finish and be
reused by its request ID. Deleting the uploaded page or service shutdown attempts
to cancel it. A provider call already sent may still incur a charge.

## Frontend Boundary

`src/integrations/roi/client.ts` exports `createRoiClient` and a default client.
`VITE_ROI_ENABLED=true` and an explicit loopback `VITE_ROI_API_BASE_URL` are
required before any request. These flags do not yet add a New Build review step.
Disabled methods fail locally without calling fetch. No upload or detection
occurs on module import, PDF render, or page selection.

The client has explicit `health`, `uploadPage`, `detect`, and `deletePage` methods.
Upload accepts only `RenderedPdfPage.source_blob`, not an editor canvas. Detection
accepts the request/signal from `useRoiSession.beginRequest` and accepted/current
ROI snapshots; it returns `{run, annotations, ...}` for the existing reducer's
`result` action. Phase 4 must upload on explicit detection, handle page expiry,
pass cancellation signals, and reconcile proposals without replacing user edits.
It must disclose that the selected-page image is sent to the service and Gemini.

Zod validates response fields, boxes, model, states and association IDs before
dispatch. Envelope/run/page/request/hash/revision mismatches are rejected. The
client bounds response bytes and time, rejects redirects, omits cookies/referrers,
stores no drawings/tokens in local storage, and does not retry automatically.

## Verification

```powershell
& ./backend/roi_app/.venv/Scripts/python.exe -m unittest discover -s backend/roi_tests -v
npm test
npm run typecheck
npm run build -- --outDir .vite/roi-phase3-check
npm run test:e2e
npm run lint
```

Verified: 32 offline backend tests, 52 frontend tests (14 new client tests), both
desktop Playwright manual flows, type-check, build and dependency consistency.
Backend tests include actual google-genai serialization via httpx MockTransport,
not just a fake adapter. No live key or private drawing is required. Pylance
syntax checks pass for the API entry point and service. Full lint has 0 errors
and the same 9 inherited warnings. The existing bundle-size warning remains.
No live Gemini evaluation, real email, mobile release, or production security
certification was performed.