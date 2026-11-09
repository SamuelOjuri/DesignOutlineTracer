# TaperedPlus XPress

TaperedPlus XPress provides roof-plan editing and reviewable roof-region and
penetration recommendations. The frontend uses React 18, TypeScript, Vite 5,
Tailwind, and shadcn/ui.

**The active backend is [`backend/app`](backend/app).** It is a FastAPI
annotation service using `ROI_MODEL` to select `gemini-4-argon` (default) or
`gemini-3.7-flash`. It has its own dependency lock and tests. All new
application-backend work belongs in this package. It contains
the ROI implementation; the former extraction backend has been retired and is
not imported or called by the ROI workflow.

The ROI service defaults to localhost development. Public deployment supports
a Netlify frontend and a single-worker Render API with Supabase Postgres/private
Storage (or a persistent SQLite fallback) and
anonymous page ownership, without a user login. See
[production deployment](docs/Production-Deployment.md) for the required settings.
Live model access and domain-quality evaluation remain separate from offline verification.

## Repository Layout

| Path | Purpose |
| --- | --- |
| [`src/`](src) | Frontend screens, drawing tools, page sessions, and review workflows. |
| [`src/integrations/roi/`](src/integrations/roi) | ROI HTTP client and response validation. |
| [`backend/app/`](backend/app) | Active annotation API, provider integration, prompts, and configuration. |
| [`backend/roi_tests/`](backend/roi_tests) | Offline tests for the active API and provider contract. |
| [`backend/roi_reference/`](backend/roi_reference) | Separate reference runner and evaluation tooling; not required to start the API. |
| [`backend/roi_reference_tests/`](backend/roi_reference_tests) | Offline tests for the reference runner. |
| [`tests/e2e/`](tests/e2e) | Browser regression tests with mocked external services. |

Legacy extraction tests under `backend/tests` may remain in an existing local
checkout, but they are ignored by Git and are not part of the tracked
application. The active backend's tests are under `backend/roi_tests`.

## Run Locally

Run these commands from the repository root. Recovery was verified with
Node.js 24.20.0 and the restored npm lockfile. The optional ROI backend uses
Python 3.13 and a separate virtual environment.

### Frontend With Manual Editing

```powershell
npm ci
$env:VITE_ROI_ENABLED = "false"
npm run dev -- --host 127.0.0.1 --port 8081 --strictPort
```

Open <http://127.0.0.1:8081/> or <http://127.0.0.1:8081/new-build>.
Choose another port if 8081 is occupied. No Python service or Gemini API key
is needed for the manual editing workflow. The PDF.js worker is served
locally from the installed dependency rather than a CDN.

### Active Backend Setup

Create the ROI environment once, then install its locked dependencies from the
repository root:

```powershell
py -3.13 -m venv backend/app/.venv
& ./backend/app/.venv/Scripts/python.exe -m pip install --require-hashes -r backend/app/requirements.lock
& ./backend/app/.venv/Scripts/python.exe -m pip check
```

In a backend terminal, start the service with live model calls disabled:

```powershell
$env:ROI_MODEL = "gemini-4-argon"
$env:ROI_ALLOW_LIVE = "false"
$env:ROI_ALLOWED_ORIGINS = "http://127.0.0.1:8081"
& ./backend/app/.venv/Scripts/python.exe -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8080 --workers 1 --no-proxy-headers --no-access-log
```

The application entry point is `backend.app.main:app`, and all annotation
endpoints are under `/api/roi/v1`. In another terminal, check the service:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/api/roi/v1/health
```

With live calls disabled, health returns HTTP 200 with `status: not_configured`,
`model: gemini-4-argon`, and `mode: localhost_only`. Detection requests return
`provider_not_configured`; the offline service does not fabricate detections.
Health never calls Gemini, and `status: ready` only indicates local provider
configuration, not verified model access.

### Frontend With ROI Review

After installing the frontend dependencies, start or restart Vite in a separate
terminal with the ROI client enabled:

```powershell
$env:VITE_ROI_ENABLED = "true"
$env:VITE_ROI_API_BASE_URL = "http://127.0.0.1:8080"
npm run dev -- --host 127.0.0.1 --port 8081 --strictPort
```

Open <http://127.0.0.1:8081/new-build>. The API base URL points to the Python
service on port 8080; the allowed origin points to the frontend on port 8081.
If either port changes, update the corresponding setting. `localhost` and
`127.0.0.1` are different origins, so use the exact frontend URL in
`ROI_ALLOWED_ORIGINS`. Stop an existing frontend on port 8081 before restarting.

### Configuration And Live Detection

| Setting | Where it is read | Purpose |
| --- | --- | --- |
| `VITE_ROI_ENABLED` | Frontend | Set to `true` to show ROI/penetration review and enable ROI requests. |
| `VITE_ROI_API_BASE_URL` | Frontend | Loopback API origin, such as `http://127.0.0.1:8080`, without the `/api/roi/v1` suffix. |
| `VITE_ROI_DETECTION_TIMEOUT_MS` | Frontend | Detection deadline in milliseconds; defaults to `930000` (15 minutes plus 30 seconds). Health, upload and delete retain their 70-second deadlines. |
| `VITE_ENABLE_SEND_TO_TAPEREDPLUS` | Frontend | Set to `true` to re-enable **Send to TaperedPlus** on Project Details; off by default. |
| `ROI_MODEL` | Backend | `gemini-4-argon` (default) or `gemini-3.7-flash`. |
| `ROI_THINKING_LEVEL` | Backend | Argon reasoning level: `low`, `medium` (default), or `high`. Not sent to Flash. |
| `ROI_TEMPERATURE` | Backend | Flash sampling temperature, from `0` to `2`; defaults to `0.5`. Omitted for Argon. |
| `ROI_MAX_OUTPUT_TOKENS` | Backend | Thinking and output token budget; defaults to `32768`, with a maximum of `65536`. |
| `ROI_TIMEOUT_SECONDS` | Backend | Overall detection deadline, including retries; defaults to `900`, with a maximum of `900`. |
| `ROI_OUTLET_CALL_TIMEOUT_SECONDS` | Backend | Deadline for each outlet-detection model call; a stalled call is abandoned and retried once within `ROI_TIMEOUT_SECONDS`. Defaults to `120`, with a maximum of `900`. |
| `ROI_PENETRATION_CALL_TIMEOUT_SECONDS` | Backend | Deadline for each penetration model call, excluding provider-slot wait; defaults to `120` seconds. Retries share the overall scan deadline and call budget. |
| `ROI_PENETRATION_CROP_CONCURRENCY` | Backend | Penetration crops dispatched per wave, from `1` to `8`; defaults to `4`. Queued waves stop at the annotation limit. |
| `ROI_MAX_PROVIDER_CALLS` | Backend | Shared simultaneous model-call limit across ROI, outline, outlet and penetration operations; defaults to `4`, with a maximum of `16`. |
| `ROI_PAGE_TTL_SECONDS` | Backend | Uploaded-page lifetime; defaults to `1800` seconds to allow room for long detections. |
| `ROI_ALLOW_LIVE` | Backend | Set to `true` to permit model requests; defaults to `false` in code. |
| `GOOGLE_API_KEY` | Backend | Server-side credential required for live detection. |
| `ROI_ALLOWED_ORIGINS` | Backend | Comma-separated frontend origins allowed to call the API. |
| `ROI_STORAGE_BACKEND` | Backend | `auto` selects Supabase when all credentials are present, otherwise SQLite when `ROI_STATE_PATH` is set, otherwise local memory. Public mode requires a durable store. |
| `SUPABASE_URL` | Backend | Supabase project HTTPS origin, without a trailing slash. |
| `SUPABASE_SECRET_KEY` | Backend | Server-only Supabase secret key for private Storage. |
| `DATABASE_URL` | Backend | PostgreSQL direct or session-pooler connection on port 5432; transaction poolers cannot hold the store's advisory lock. |
| `ROI_STORAGE_BUCKET` | Backend | Private Storage bucket name; defaults to `roi-pages`. |

Vite reads frontend environment settings at startup/build time; restart the
development server or rebuild after changing them. The Python application reads
the launching process's environment and does not automatically load either the
root `.env` or `backend/app/.env`. If using a backend environment file, load
it explicitly with Uvicorn's `--env-file .env` option for a root file, or
`--env-file backend/app/.env` for the backend file. Do not read or print its
credentials in diagnostics. See [Supabase setup](docs/Supabase-Setup.md) for
the migration, private bucket and Render settings.
See [`backend/app/.env.example`](backend/app/.env.example) for additional
limits and settings. That example sets `ROI_ALLOW_LIVE=true`; the startup command
above explicitly disables live calls for initial setup.

For live detection, supply `GOOGLE_API_KEY` through the backend environment or
an untracked backend environment file, set `ROI_ALLOW_LIVE=true`, and restart
the API. Keep the key out of `VITE_*` variables and tracked files. An explicit
detection action sends the selected page image to the API and Gemini; it can
incur provider charges. Confirm model access and review limits before live use.

To use the settings in `backend/app/.env`, start the API from the repository root:

```powershell
& ./backend/app/.venv/Scripts/python.exe -m uvicorn backend.app.main:app --env-file backend/app/.env --host 127.0.0.1 --port 8080 --workers 1 --no-proxy-headers --no-access-log
```

If the Supabase settings are in the root `.env`, use `--env-file .env` instead.
`SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `DATABASE_URL` must all be supplied;
partial Supabase configuration fails startup rather than choosing another store.
Keep the database URL and both provider/storage credentials on the backend.

Environment variables already set in that terminal take precedence over the file.
Remove an old terminal `ROI_MODEL` override when switching models through `.env`.
Keep the browser detection deadline longer than the backend deadline, and the
page/session lifetimes long enough to finish detection. Responses and cached runs
record the selected model and the effective generation settings.

Argon omits sampling parameters and uses the larger token/time budgets recommended
in [Google's migration guide](https://ai.google.dev/gemini-api/docs/latest-model#migration-checklist).
The offline `backend/roi_reference` package retains its original Flash baseline;
it does not configure the application service.

Local mode checks loopback client addresses, hosts, and frontend origins.
Public mode accepts configured HTTPS frontend origins and configured API hosts;
the browser calls the Render HTTPS API directly. Keep one API worker and one
instance. The production configuration stores metadata and call budgets in
Supabase Postgres and uploaded page images in private Supabase Storage.
Apply the checked-in [migration](supabase/migrations/20261104180000_roi_private_state.sql)
and follow [Supabase setup](docs/Supabase-Setup.md) before starting that backend.
An explicit `ROI_STORAGE_BACKEND=sqlite` with `ROI_STATE_PATH` on a persistent
disk remains supported. Both durable stores retain unexpired pages, completed
operations and call budgets across restarts; active Gemini calls cannot resume.
The browser-generated session token represents anonymous ownership of uploaded
pages, not authenticated user identity. There is no user login. An interrupted
detection must be started again after a backend restart; completed results can
be replayed without another provider call. See the
[production deployment guide](docs/Production-Deployment.md).
See the [annotation API runbook](docs/Phase-3-Annotation-API.md) for endpoint
contracts, request limits, and lifecycle details.

## Available Workflow

- `/`: project-type selection.
- `/new-build`: PDF upload and page selection, manual roof-area selection,
  cutouts and outline adjustment, outlet/drainage editing, and project details
  with a downloadable TRICS package.
- `/refurbishment`: the original dimension-based roof drawing interface.

### Roof Boundary Editing

With ROI review enabled, **Set Outlines** now includes **Generate outline**.
Choose an accepted roof region and the boundary convention, then review the
suggested perimeter. The service uses a detailed crop and full-page context,
followed by conservative fitting to PDF vector strokes or raster linework.
Orange dashed edges need closer review. **Use outline** applies editable
polygons; existing outlines are replaced only when selected explicitly.
**Undo generated outline** restores the prior drawing while it remains the
latest page edit. Rooflights remain a separate penetration-review step.
See [Automatic roof outlines](docs/Automatic-Roof-Outlines.md) for the pipeline,
API, verification and remaining live accuracy evaluation. Restart the backend
and refresh/rebuild the frontend to use the new endpoint and controls.

In Define Roof Area, **Adjust** moves edges or individual red vertices. Drop a
vertex onto an adjacent vertex on the same roof to merge them. A green ring marks
a valid merge target within 8 screen pixels; release removes the dragged vertex.
Vertex drags also snap to PDF vector endpoints and intersections within 10 screen
pixels, falling back to the nearest point on a PDF line. A teal marker and label
identify the target; release applies the move as one Undo action. Hold Alt to move
freely without PDF snapping or merging. Scanned pages without PDF vectors use
free movement. Existing outline merge targets take priority over PDF snapping.
Hold Shift during a vertex drag to align a valid horizontal/vertical corner.
Shift alignment takes priority over PDF snapping and does not merge vertices or
collapse intermediate points. Invalid moves remain blocked.

To add a missing outline corner, hover a blue edge in **Adjust** and use its
small **+** handle (**Add vertex on this edge**). Click to split the edge at its
midpoint, then drag the new red-ringed vertex to a PDF endpoint or intersection;
you can also drag directly from **+**. The insertion and first placement share one
Undo step. Automatic merging is suppressed during that placement, keeping close
corners distinct while PDF snapping remains available. Only the hovered edge
shows a handle, and only with sufficient space: zoom in to edit short edges.
Existing vertices take priority. A straight edge split preserves drainage marks
and accepted opening/outlet reviews; a changed boundary retains the usual review
requirements. Placement cannot cross another roof or change a cutout/opening.
Esc cancels a live drag; a vertex already added by clicking remains undoable.

**Straighten** is separate: click or tap a near-horizontal or near-vertical side
to align it, including its intermediate vertices. The side is placed halfway
between its endpoints on the aligned axis. It keeps the vertices and does not
convert arbitrary roofs into rectangles. Clearly diagonal sides are rejected.

**Snap to line** (also under Adjust) fits a side to a line on the plan. Hover a
blue side to see the section that will be replaced (short steps along it are
included), press it and drag towards the drawing line to follow. The nearest
line running alongside is highlighted, other nearby lines show faintly, and a
dashed outline previews the result. Release to apply it as one Undo step.
Releasing away from a line, or on a line whose fit would touch another roof
area, change a cutout or leave the page, changes nothing. Esc cancels a drag.
The tool stays on so further sides can be snapped; Esc, **Exit snap** or the
Snap to line button turns it off. To review before applying, click a side (or
its two end corners) instead, click a line, optionally use **Next line** or
**Other path**, then **Apply fit**. Lines come from the PDF's vector strokes, or
from dark linework in the page image when the PDF has none nearby.

**Redraw** (under Adjust) replaces a local section of an existing outline with
a polyline. Click an outline edge or corner to start, then click each new corner.
Nearby PDF vector endpoints, intersections and lines snap the cursor and are
highlighted; hold Alt to place a point freely or connect close to an existing
corner without snapping onto it. On scanned pages without vector lines, corners
can still be placed manually. Click near a different edge or vertex of the same
blue outline to choose where to reconnect. The last clicked point supplies the
reconnection; it does not have to match a PDF endpoint. Review the dashed result
and orange section being replaced, then click **Finish redraw** to apply it.
Moving the cursor to the button keeps the selected reconnection and preview.
You can also continue placing corners: PDF-snapped and free draft points stay
where you placed them, even near the blue boundary. Clicking an outline point
never applies the redraw automatically. **Finish redraw** becomes available only
when the last clicked point reconnects to the same outline and produces a valid
boundary. Invalid completions show a reason and keep the draft editable.
**Other path** switches to the other route around the boundary. **Back** or
Backspace removes the last draft point; **Clear** starts over, and Esc or
**Exit redraw** cancels. Applying is one Undo action, including
outline identity, roof-region links and drainage markings. Retained boundary
portions keep their drainage marks; newly drawn sides need their drainage marks
reviewed. Crossings, touching roofs, page overshoot and changes to cutouts or
openings are blocked. The tool remains active after applying a redraw.

Applying a redraw changes the drawing, which would cancel an outline that is
still generating or discard a generated proposal awaiting review. While either
is pending you can keep drafting and review a reconnection, but **Finish redraw**
stays disabled until the generation is cancelled or completes and its proposal
is used or discarded. A redraw that adds roof area inside an accepted roof area that has
not been outlined yet shows a warning naming that area before applying:
its generated outline could later be rejected as overlapping. Area the outline
already covered does not trigger the warning, and **Finish redraw** remains
available for an intended extension.

Dragging an edge inward trims the area swept by that edge and its adjoining
edges, then rebuilds the boundary. It can pass narrow returns and meet existing
edges exactly without adding insulation area. Any separated fragments remain
selected and editable; trim a fragment away completely to remove it. At least
one roof area must remain. Vertex drags and outward edge drags still reject new
crossings, touching roofs and collapsed boundaries.

All remaining outlines must be valid, with at least three distinct vertices.
Shrinking the insulation scope removes fully excluded cutouts;
partially excluded cutouts become boundary notches (or separate roof areas when
necessary). Cutouts still inside the scope and other roofs remain unchanged.
An existing retraced/self-touching boundary is repaired when an edit leaves its
defects unchanged or reduces them; new or worsened defects are blocked with a
specific reason. Each completed edit, including cutout reconciliation, is one
**Undo** action restoring the original outlines, cutouts and selection masks.
Escape, pointer cancellation, changing tools or changing zoom cancels a drag.
Mouse, pen and touch use the same adjustment behavior.

New Build offers roof ROI and conditioned penetration recommendations when
explicitly enabled. Outlet suggestions are not wired. The cutout tool remains manual.

Phase 2 now preserves manual work per document/page for the lifetime of the open
New Build screen. Re-uploading the same PDF bytes and selecting the same page
restores that page's work. Additional-PDF uploads allow page selection before
Next; combined illustration movement does not change original page coordinates.
Sessions are not saved across reloads. See the
[Phase 2 record](docs/Phase-2-Page-Sessions.md) for source-image, annotation,
coordinate and review-state contracts.

Phase 3 adds an isolated localhost-only annotation API and a feature-flagged,
cancellable client. Live calls are disabled by default; model/project and
domain-review gates remain pending. See the
[Phase 3 record](docs/Phase-3-Annotation-API.md) for the independently locked Python
environment, startup, limits, ownership contract, and offline tests.

Phase 4 adds `upload -> roi -> paint -> outlets -> details` behind
`VITE_ROI_ENABLED=true`. Explicit detection, reviewable boxes, manual regions,
corrections, undo, and failure fallbacks preserve page-specific work. Accepted
boxes are context, not filled roof geometry. See the
[Phase 4 record](docs/Phase-4-ROI-Review.md) for startup, verification and limits.
With the flag disabled, the original manual workflow requires no ROI service.

Phase 5 extends the enabled sequence to
`upload -> roi -> paint -> penetrations -> outlets -> details`. Penetration review
supports parent/subtype corrections, manual additions, scope warnings and explicit
acceptance. In Step 4, select a detection and **Add opening** to cut it out of the
insulation scope. Review actions stay pinned above **Previous / Next**, with the
selected penetration and remaining review count visible while the sidebar scrolls.
**Add opening & next** accepts it and brings the next unreviewed penetration into
view, skipping added and rejected items and wrapping at the end. Ordinary
**Add opening** keeps the current selection and drawing view.
Drag its box or corner handles to move or resize the opening;
**Reject**, **Delete** and **Undo** also update the cutout. **Manual penetration**
supports drawing a new box and then adding it. Openings are clipped to the Step 3
scope and appear in Steps 3, 5 and 6. Project Details includes their polygons and
physical dimensions in the existing penetration payload, alongside the review
summary. Changing the base roof scope requires confirming the openings again. See the
[Phase 5 record](docs/Phase-5-Penetration-Review.md) for commands, verification and
the remaining live-evaluation/category-policy gates.

Phase 6 adds a **Download package (.zip)** action to Project Details. Optionally
attach the CRM performance specification PDF; it is packaged exactly as provided
and never copied into the form. The form no longer asks for target U-value,
product, deck or waterproofing type, because the specification covers them. The
zip also contains the form entries as CSV,
the original roof plan PDF(s), the roof drawing (DXF, SVG, GeoJSON, PNG, mask and
metadata, in millimetres), marked-up plan pages and a TRICS design prompt. See the
[Phase 6 record](docs/Phase-6-Project-Package.md) for the package, CSV and geometry
contracts.

**Send to TaperedPlus** is inactive unless `VITE_ENABLE_SEND_TO_TAPEREDPLUS=true`.
When enabled, the form submits to an external Supabase email function. It is not
required for editing, and no Supabase server code was restored. Live email
delivery was not tested; submitting real data invokes that existing external service.

## Recovery Provenance

Frontend files were selectively recovered from
`1543ee90daf466dc5410b61141d640f830e9a961` (the initial application snapshot,
before backend development). Recovery includes `src/`, `public/`, the root
HTML entry, npm manifest and lockfile, and frontend configuration files.

Small changes made during recovery:

- Bundle the matching PDF.js worker locally.
- Remove a duplicate `outlets` switch label without changing the workflow.
- Remove an unused import pointing to an absent Supabase client module.
- Add `npm run typecheck` and this README.
- Ignore local environment files, dependency/build caches, virtual
  environments, and generated backend storage artifacts.

The initial frontend recovery did not restore the legacy Python extraction
backend or Supabase function source. Local legacy backend files, environment
files, ROI references, sample PDFs, and previous `dist/` output were preserved.
The ROI service and its tests were added in later phases. The service now
occupies the tracked `backend/app` package, replacing the former extraction
implementation. Legacy `backend/tests` remains excluded by `.gitignore`;
review paths before staging local files.

## Verification

Run the active backend's offline suite using its own environment:

```powershell
& ./backend/app/.venv/Scripts/python.exe -m unittest discover -s backend/roi_tests -v
```

These tests use synthetic inputs and mocked providers, requiring no live API
key or running service. For reference-runner changes, also run
`backend/roi_reference_tests` using the separate environment described in the
[reference evaluation runbook](docs/roi-evaluation/README.md).

Frontend checks:

```powershell
npm ci
npx playwright install chromium
npm test
npm run test:e2e
npm run test:e2e:roi
npm run typecheck
npm run build -- --outDir .vite/frontend-baseline-check
npm run lint:tests
npm run lint
```

Stop this workspace's Vite server before `npm ci` on Windows: the running
process can lock Rollup's native module. Restart it with `npm run dev` afterward.
On Linux CI, use `npx playwright install --with-deps chromium` to provision
the browser's system dependencies as well.

The alternate build directory preserves any pre-existing `dist/` output.
The normal `npm run build` command instead regenerates `dist/`.

### Phase 0 Regression Harness

- `npm test`: Vitest/React Testing Library state and additional-PDF transform
  tests. `npm run test:watch` runs the same unit tests interactively.
- `npm run test:e2e`: real Chromium manual-flow tests for New Build and
  Refurbishment, using an in-memory, synthetic two-page PDF. No private drawing
  or backend service is required.
- `npm run test:e2e:ui`: interactive Playwright runner.
- `npm run test:e2e:roi`: opt-in ROI review browser suite with mocked API
  responses, source-pixel checks and desktop/mobile review screenshots.
- `npm run typecheck`: checks application code, tests, and test configuration.
- `node tests/check-polygon-adjust.mjs`: focused desktop/mobile canvas
  checks with synthetic geometry, real mouse/touch input, pixel assertions and
  screenshots under `.vite/`. Start Vite on port 4183 first, set `FRONTEND_URL`, or
  pass your running server URL: `node tests/check-polygon-adjust.mjs http://127.0.0.1:8084`.
- `npm run lint:tests`: focused lint gate for the new harness. Full application
  lint remains a separate, unsuppressed inherited-debt report.

Playwright starts and stops its own loopback Vite server on port 4180 with
ROI disabled. It never reuses an existing server. If that port is occupied:

```powershell
$env:PLAYWRIGHT_PORT = "4181"
npm run test:e2e
```

All browser tests use a network guard that blocks unexpected external/backend
requests and mocks the existing email endpoint. Send to TaperedPlus is inactive,
so the New Build test checks the disabled button and that nothing is submitted,
then downloads and inspects the project package instead. Keep browser
tests importing `test` from [tests/e2e/fixtures.ts](tests/e2e/fixtures.ts), so
the guard stays active. Run test servers locally, not on a public interface.

Open the latest screenshots and results with `npx playwright show-report`.
Successful flows attach screenshots; failures also retain traces and a failure
screenshot. Reports, traces, coverage, and build outputs are ignored by Git.
These are desktop Chromium smoke tests, not mobile or detection-accuracy tests.

See [Phase 0 checkpoint](docs/Phase-0-Frontend-Checkpoint.md) for the reviewed
scope, command results, advisory changes, and pending commit boundary.

Verified during recovery on 2026-09-09:

- Clean installation with `npm ci`, application type-check, and production build.
- Landing page, brand images, and refurbishment route load.
- New Build renders the sample roof-plan PDF using the local worker.
- Manual region selection produces a visible outline and enables progression.
- Outlet placement adds an outlet; navigation reaches Project Details.
- Switching pages on the seven-page reference PDF changes the preview.
- Browser checks did not submit project data or call Gemini.

This is a working desktop development baseline, not a production certification.
Inherited limitations recorded during recovery:

- `npm run lint` reports 26 errors and 17 warnings in the original frontend.
- `npm ci` reports 13 dependency advisories: 1 low, 5 moderate, and 7 high.
  Dependency upgrades require a separate review; no audit-fix rewrite was run.
- The production build warns about its large application chunk.
- The original fixed-width layout overflows narrow/mobile viewports.
- Live email delivery and all combinations of editing tools are not verified.

Phase 0 re-verification on 2026-09-09 passed clean install, 2 unit tests,
2 browser tests, application/test type-check, production build, and focused
test lint. At that checkpoint, full lint reported 26 errors and 17 warnings.
The updated lockfile reports 15 advisories (1 low, 7 moderate, 7 high), including
two new moderate package reports in the Vitest toolchain. These are documented
in the checkpoint record; no dependency warnings or lint rules were suppressed.

### Post-Checkpoint Cleanup

The focused cleanup on 2026-09-09 reduces full lint to **0 errors and 9 warnings**.
It fixes stale upload callbacks after parent rerenders, cutout-only outlet
redraws, and New Build drawing dependencies without coupling redraws to canvas
initialization. Geometry/submission types, step lookups, and small lint errors
are also corrected. The existing email payload and dependency lockfile are unchanged.

Verification passes: 6 unit tests, 2 browser flows, type-check, production build,
and focused test lint. New tests cover the upload callback, cutout redraws,
source-page replacement, illustration legend changes, and zoom retention.
`npm run lint:tests` includes every frontend unit-test file.

The remaining warnings are two Refurbishment `DrawingCanvas` hook-dependency
warnings and seven shared UI Fast Refresh export warnings. They remain visible,
not suppressed; Refurbishment lifecycle changes are deferred to a separately
tested cleanup. Dependency advisories, bundle size and mobile overflow remain
outside this pass. See the checkpoint record for the original results and the
separate cleanup review boundary.

## Next Development Scope

Phase 1 now includes an isolated, offline-first Python reference runner and
evaluation tooling. See the [Phase 1 runbook](docs/roi-evaluation/README.md) for
the pinned environment, tests, explicit single-call live command, input variants,
and domain-review protocol. No Gemini call was made during implementation;
model/project access and a domain-reviewed real evaluation set remain pending.
The tool does not enable frontend recommendations or import the old backend.

Phase 2 frontend contracts and page-session integration and the Phase 3 isolated
API/client are implemented. The API validates uploaded bytes, image dimensions,
and ownership independently. Phases 4-5 supply opt-in ROI and penetration review
and explicit detection orchestration, verified offline. The next implementation
phase is outlet recommendations with an explicit editor adapter. Phase 1
model-access, full-page recall and domain-review gates remain open; ordinary CI
never calls the live model.

Use the references in `docs/roi-logic/` for the new Gemini 3.7 Flash annotation
workflow. Introduce reviewable ROI recommendations first, followed by
ROI-associated penetration and outlet suggestions. Do not interpret a suggested
bounding box as an exact roof perimeter or inherit the old backend's geometry
and CAD-export assumptions.
