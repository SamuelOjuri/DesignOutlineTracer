# Phase 0 Frontend Checkpoint

Date: 2026-09-09. Branch: `region-of-interest`.

The regression harness is implemented and the Phase 0 functional gates pass.
The recovered frontend and harness are prepared as an explicitly staged
checkpoint. A reviewed commit is still pending; no commit, branch creation,
push, backend cleanup, or live external submission was performed by this task.
Gemini integration has not started.

## Checkpoint Scope

The branch started at `28f33d3` (Initial blank main), with the restored frontend
untracked. Recovery provenance is recorded in [the README](../README.md).
Phase 0 adds test code and configuration, not new production application logic.
React 18, Vite 5, the existing manual tools, and the local PDF.js worker remain.
The existing npm lockfile was updated by npm, not discarded or recreated from
an unconstrained manifest.

The staging set is limited to:

- `src/` and `public/`: reviewed recovered frontend plus the unit tests/setup.
- Existing root HTML, npm, TypeScript, Tailwind, PostCSS, component and ESLint
  configuration; new Vitest, Playwright, and test TypeScript configuration.
- `.gitignore`, `README.md`, this record, and the ROI implementation plan.
- `tests/e2e/` and `tests/fixtures/roofPlan.ts`: new synthetic regression harness.

No `backend/`, Supabase function source, local environment file, real drawing,
notebook, private reference image, or generated test/build output is staged.
The prototype Python export remains an unchanged local reference, outside this
checkpoint. Existing files and previous `dist/` output were not deleted.

Review `git diff --cached --stat` and `git diff --cached --name-only` before
committing. Do not replace the deliberate staging set with `git add .`.

## Regression Coverage

| Test | Assertions |
| --- | --- |
| New Build owner state (RTL) | No Next without a PDF; no Next for a two-point outline; roof, cutout, moved outlet, drainage, and details survive navigation; New Build physical penetrations stay empty |
| Additional PDF transforms (RTL) | A doubled raster dimension yields half-sized coordinates; new outlines, holes and outlets receive the existing horizontal gap; drainage indices are offset; revisiting details does not merge twice |
| New Build browser flow | Real local PDF.js worker; two distinct page renders and switching back; manual fill and undo; visible colored canvas pixels; zoom changes display size without changing source pixels; outlet placement and retained edits; details and intercepted legacy submission |
| Refurbishment browser flow | Four dimensioned segments; visible roof pixels; manual outlet; penetration-step navigation; project details without services |

The PDF fixture is generated in memory by `pdf-lib` from two simple rectangles
on 300 by 200 point pages. PDF.js renders these at 600 by 400 pixels. The shape
is deliberately located differently on each page. This is synthetic interaction
evidence, not roof-domain ground truth or model detection accuracy evidence.

Unit tests mock child renderers to isolate `NewBuildApp` state and transforms.
The browser suite exercises the real renderers and uses measured canvas bounds
for clicks. It does not mock PDF.js or replace application geometry logic.

Every browser test installs a context-wide network guard before navigation,
blocks service workers, fails on unexpected requests and browser errors, and
fulfills the existing email route locally. The mock checks the legacy payload;
it does not verify email delivery or any future annotation handoff contract.

## Reproduction And Results

Run from the repository root on Node.js 24.20.0 (the verified runtime).
Stop the workspace's dev server before a clean install on Windows to release
Rollup's native-module file lock. Browser binaries require a one-time download.

| Command | Result |
| --- | --- |
| `npm ci` | Passed after stopping the existing Vite process that locked Rollup |
| `npx playwright install chromium` | Chromium installed for the pinned Playwright package |
| `npm test` | 2 tests passed |
| `npm run test:e2e` | 2 desktop Chromium flows passed, including after clean install |
| `npm run typecheck` | Application, tests and test configs passed |
| `npm run build -- --outDir .vite/frontend-baseline-check` | Passed; local worker emitted; existing large-chunk warning remains |
| `npm run lint:tests` | Passed with no new harness diagnostics |
| `npm run lint` | Existing 26 errors and 17 warnings, unchanged |

The browser server binds only to `127.0.0.1:4180`, does not reuse other servers,
and sets `VITE_ROI_ENABLED=false`. Set `PLAYWRIGHT_PORT` to another free port
when needed. The flag is preparatory configuration, not an implementation of
the later ROI feature. No ROI or legacy backend is required.

Normal assertions have a 10-second bound; initial PDF rendering has a
30-second bound because a captured cold local worker response took 9.4 seconds.
Tests use condition-based waits, no fixed sleeps, and no automatic retries.
`npx playwright show-report` opens attached step screenshots; failed runs retain
a trace and failure screenshot under ignored report/output directories.

## Known Debt And Boundaries

- Full lint failures were not fixed or suppressed. ESLint ignores were extended
  only for generated build, coverage, and browser-report directories.
- The recovery lockfile had 13 advisory reports. The Phase 0 lockfile has 15:
  1 low, 7 moderate, 7 high. The two additional moderate package reports are
  `vitest` and `@vitest/mocker`, both for
  [GHSA-82fw-gwwq-j7x9](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).
  Vitest 3 is used with Vite 5. The advisory reports a fix in Vitest 4.1.11;
  that toolchain change needs separate compatibility review. Do not expose
  development/test servers or enable Vitest browser mode for untrusted access.
  These additional reports are new tooling debt, not inherited production debt.
- Production build output still warns about the large application chunk.
- The inherited narrow-screen overflow remains. This checkpoint supports a
  desktop smoke-test baseline only, not a mobile release claim.
- Full cutout/edge editing combinations, all PDF variants, live email, model
  quality, authentication, persistence, and ROI networking are not certified
  by these smoke tests. Later phases must add their own targeted checks.
- Finalizing the staged checkpoint as a commit remains a deliberate user action.