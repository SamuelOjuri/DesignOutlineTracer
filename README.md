# TaperedPlus Frontend Baseline

The `region-of-interest` branch restores the original React 18, TypeScript,
Vite 5, Tailwind, and shadcn/ui frontend. Opt-in ROI review and detection
orchestration are implemented; live model and domain-quality gates remain open.

## Run Locally

Run these commands from the repository root. Recovery was verified with
Node.js 24.20.0 and the restored npm lockfile.

```powershell
npm ci
npm run dev -- --host 127.0.0.1 --port 8081 --strictPort
```

Open <http://127.0.0.1:8081/> or <http://127.0.0.1:8081/new-build>.
Choose another port if 8081 is occupied. No Python service or Gemini API key
is needed for the manual editing workflow. The PDF.js worker is served
locally from the installed dependency rather than a CDN.

## Available Workflow

- `/`: project-type selection.
- `/new-build`: PDF upload and page selection, manual roof-area selection,
  cutouts and outline adjustment, outlet/drainage editing, and project details.
- `/refurbishment`: the original dimension-based roof drawing interface.

New Build offers roof ROI recommendations when explicitly enabled. Penetration
and outlet suggestions are not wired. The cutout tool remains manual.

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

The original project-details form still submits to an external Supabase email
function. It is not required for editing, and no Supabase server code was
restored. Live email delivery was not tested; submitting real data invokes that
existing external service.

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

No experimental Python backend or Supabase function source was recovered.
Existing backend files, local environment files, ROI references, sample PDFs,
and previous `dist/` output were preserved, not deleted. The frontend does not
import or invoke the old extraction backend. Existing backend files are not
part of the restored baseline; review paths before staging, rather than adding
the whole workspace indiscriminately.

## Verification

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
- `npm run lint:tests`: focused lint gate for the new harness. Full application
  lint remains a separate, unsuppressed inherited-debt report.

Playwright starts and stops its own loopback Vite server on port 4180 with
ROI disabled. It never reuses an existing server. If that port is occupied:

```powershell
$env:PLAYWRIGHT_PORT = "4181"
npm run test:e2e
```

All browser tests use a network guard that blocks unexpected external/backend
requests and mocks the existing email endpoint. The New Build test submits
synthetic data only to that mock; no real project email is sent. Keep browser
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
and ownership independently. Phase 4 now supplies opt-in ROI review and explicit
detection orchestration, verified offline. The next implementation phase is
penetration review after this ROI slice is reviewed. Phase 1 model-access and
domain-review gates remain open; ordinary CI never calls the live model.

Use the references in `docs/roi-logic/` for the new Gemini 3.6 Flash annotation
workflow. Introduce reviewable ROI recommendations first, followed by
ROI-associated penetration and outlet suggestions. Do not interpret a suggested
bounding box as an exact roof perimeter or inherit the old backend's geometry
and CAD-export assumptions.