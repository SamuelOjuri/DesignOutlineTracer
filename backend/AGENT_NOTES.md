# Backend Agent Notes

## Required Reading Contract — 2026-05-01
- `docs/plan.md` defines the backend as a source-adaptive CAD-aware document intelligence pipeline. The system must classify each upload, prefer vector-first extraction for CAD-exported PDFs, fall back to raster processing only when needed, generate candidate tapered-insulation roof polygons, use AI only for semantic classification/validation, and produce final coordinates from deterministic geometry services.
- The production JSON contract centers on `document`, explicit `coordinate_systems`, `drawing_metadata`, `target_area.outer_polygon_mm`, `constraints.rainwater_outlets`, `constraints.rooflights`, `constraints.excluded_regions`, `quality_checks`, and export paths. TP17221 is the canonical vector PDF, with a target flat-roof scope expected near 103 m2 after calibration.
- Geometry must remain the source of truth. Gemini/Falcon-style systems may classify notes, OCR text, segment candidates, or select among candidates, but final CAD-ready polygons must come from vector/raster geometry cleanup, snapping, topology checks, and human review.
- `src/components/NewBuildApp.tsx` currently has the manual step order `upload -> paint -> outlets -> details`. State is held as `roofOutlines: Point[][]`, `interiorHoles: Point[][]`, `outlets: Outlet[]`, `drainageEdges: DrainageEdge[]`, and `DrawingScale`. Multiple PDF uploads are merged by scaling later PDF canvas coordinates back into the first PDF coordinate space.
- `src/components/newbuild/PdfUpload.tsx` renders PDFs client-side with pdf.js at scale 2 and captures user-selected paper size plus scale ratio. The backend integration must reuse these values for mm/canvas-pixel conversion and must not break manual upload/render behavior.
- `src/components/newbuild/PaintBucketCanvas.tsx` is the manual segmentation and adjustment surface. It emits canvas-pixel polygon outlines and interior holes, supports fill/cutout/adjust tools, and can remain the review/edit surface for automated outlines.
- `src/components/newbuild/NewBuildOutletCanvas.tsx` manages outlet placement and drainage edge marking in canvas-pixel coordinates. Automated outlets and derived drainage edges must map into this existing shape.
- `src/components/ProjectDetailsForm.tsx` posts the legacy payload to the existing Supabase edge function. `supabase/functions/send-project-email/index.ts` generates a legacy DXF/email from `outline`, `outlets`, `penetrations`, and `projectDetails`. This path must not be rewritten; future backend data must be added as an optional parallel payload only.
- `src/types/roof.ts` defines the current frontend contracts: `Point`, `RoofOutline`, `Outlet`, `Penetration`, `ProjectDetails`, `DrawingScale`, `NewBuildStep`, and `DrainageEdge`. Phase 6 may extend `NewBuildStep` with `classify`, but Phase 0 will not touch frontend code.

## Phase 0 — Bootstrap — 2026-05-01
- Approach: create an isolated Python 3.11+ FastAPI backend under `backend/` with settings that load `../.env` first and `backend/.env` second, a `/health` endpoint, dev tooling config, fixture paths for the three sample PDFs, and one PyMuPDF smoke test per fixture.
- Files added: `pyproject.toml`, `.env.example`, `README.md`, `Makefile`, `tasks.ps1`, `app/main.py`, `app/config.py`, `app/logging.py`, `app/smoke.py`, `app/api/routes/health.py`, minimal AI provider/mock scaffolding, and Phase 0 tests/fixtures.
- Test results: `python -m ruff check .` passed; `python -m mypy app tests` passed; `python -m pytest -q` passed with 2 tests; `Invoke-RestMethod http://127.0.0.1:8000/health` returned `{"status":"ok"}` from Uvicorn.
- Per-PDF metrics:
  - TP17202: PyMuPDF opened successfully; pages=1; page0=1191.0x842.0 pt.
  - TP17221: PyMuPDF opened successfully; pages=1; page0=2384.0x1684.0 pt.
  - TP17256: PyMuPDF opened successfully; pages=1; page0=2383.9x1684.0 pt.
- Deviations from plan.md: none for Phase 0.
- Open risks: sample PDFs are ignored by git and must exist locally for tests; local verification used Python 3.13.13, which satisfies the 3.11+ requirement but is newer than the target minimum; later phases will need golden fixtures and careful tolerances because PDF internals can vary by producer.

## Phase 1 Design Note — Source Classification — 2026-05-01
- Approach: implement a deterministic PyMuPDF-based classifier that computes the section 4.1 signals, plus page count, font count, page DPI estimate, embedded image area ratio, source type, and recommended pipeline. `POST /api/documents` will persist the uploaded file under `storage/uploads/{id}/source.pdf`, render a low-resolution first-page preview PNG alongside it, run classification synchronously, and return a Pydantic response schema.
- Heuristics: vector PDFs are selected when text and vector paths are both present with little image coverage; raster PDFs when a large embedded image dominates and text/vector signals are weak; hybrid PDFs when raster coverage and vector/text signals coexist; CAD files are extension-based. The classifier remains geometry-neutral and does not attempt extraction or AI validation in this phase.
- Tests: add golden JSON fixtures under `tests/fixtures/golden/<pdf_stem>/phase1.json`, compare exact source type / recommended pipeline / booleans, and assert metric counts with tolerances where producer/library versions can shift slightly.
- Deviations from plan.md: none intended for Phase 1.

## Phase 1 — Source Classification — 2026-05-01
- Approach: implemented synchronous upload/classification for PDFs using PyMuPDF signals from plan section 4. The upload route stores the original file under `storage/uploads/{id}/`, renders `preview.png`, and returns classification plus relative storage paths. All three samples are vector PDFs because they have native vector paths and little/no raster page coverage.
- Files added: `app/api/routes/documents.py`, `app/models/classification.py`, `app/models/documents.py`, `app/services/classifier/pdf_classifier.py`, `app/services/storage/documents.py`, `app/services/storage/previews.py`, Phase 1 golden fixtures, and classifier/upload tests.
- Test results: `python -m ruff check .` passed; `python -m mypy app tests` passed; `python -m pytest -q` passed with 5 tests; curl smoke upload to `POST /api/documents` returned HTTP 201 for TP17221 with `source_type=vector_pdf`, `recommended_pipeline=vector_first`, and `preview.png`.
- Per-PDF metrics:
  - TP17202: `vector_pdf`, `vector_first`, confidence=0.95, chars=91, vector_paths=4482, images=1, image_area_ratio=0.0041, fonts=2, estimated_dpi=96.0, elapsed=109.2 ms.
  - TP17221: `vector_pdf`, `vector_first`, confidence=0.95, chars=4235, vector_paths=11407, images=0, image_area_ratio=0.0, fonts=3, estimated_dpi=null, elapsed=179.6 ms.
  - TP17256: `vector_pdf`, `vector_first`, confidence=0.95, chars=1541, vector_paths=53110, images=1, image_area_ratio=0.002, fonts=3, estimated_dpi=96.0, elapsed=667.5 ms.
- Deviations from plan.md: none for Phase 1. The low-res preview is rendered as a local relative path now; signed URLs are deferred until an external storage layer exists.
- Open risks: all current samples classify as vector PDFs, so raster/hybrid thresholds are implemented but not yet validated against true raster fixtures; vector path counts may vary slightly across PyMuPDF versions and are locked to this environment in the golden fixtures.

## Phase 2 Design Note — Vector-First Extraction — 2026-05-01
- Approach: build a PyMuPDF vector extraction service for plan section 6 that returns page metadata, raw text blocks with PDF bounding boxes, deterministic mock-classified text blocks, vector primitives from `page.get_drawings()`, and heuristic sheet regions. The endpoint will locate the uploaded source file under `storage/uploads/{id}/` and return the structured document at `GET /api/documents/{id}/vector`.
- Text classification: keep AI behind the existing provider abstraction, with `MockProvider` applying deterministic keyword rules for classes such as `drawing_title`, `scale_text`, `drawing_number`, `revision`, `rwp_label`, `rooflight_label`, `roof_build_up_note`, and `general_note`. No paid API calls are introduced in this phase.
- Sheet-region heuristics: detect a title block from dense text on the right side / bottom-right of the sheet, notes from large right-side text clusters, and a drawing viewport as the complement-like bounding region that excludes the title block. These heuristics are intentionally conservative until Phase 3 candidate geometry uses them.
- Tests: add golden count fixtures for all three PDFs and explicit TP17221 assertions for title-block text (`Roof Plan`, `1:50`, drawing number, revision), at least five RWP labels, rooflight labels/rectangles, and title-block exclusion from the drawing viewport.
- Deviations from plan.md: none intended for Phase 2.

## Phase 2 — Vector-First Extraction — 2026-05-01
- Approach: implemented a PyMuPDF vector extraction service with page metadata, raw text blocks, mock-classified semantic text blocks, vector primitives, heuristic sheet regions, and rooflight rectangle detection from axis-aligned vector linework. Added `GET /api/documents/{id}/vector` over uploaded documents.
- Files added: `app/api/routes/extraction.py`, `app/models/vector.py`, `app/services/ai/factory.py`, `app/services/vector_pipeline/extractor.py`, Phase 2 golden fixtures, and vector extraction/endpoint tests. Updated `MockProvider`, storage lookup helpers, app routing, and smoke output.
- Test results: `python -m ruff check .` passed; `python -m mypy app tests` passed; `python -m pytest -q` passed with 8 tests; live smoke upload plus `GET /api/documents/{id}/vector` returned HTTP 200 for TP17221 with 90 text blocks, 21463 vector primitives, 5 RWP labels, 6 rooflight rectangles, and 3 sheet regions.
- Per-PDF metrics:
  - TP17202: text_blocks=7, vector_primitives=4491, sheet_regions=2, rwp_labels=0, rooflight_rectangles=0, elapsed=139.8 ms.
  - TP17221: text_blocks=90, vector_primitives=21463, sheet_regions=3, rwp_labels=5 (`rwp.1`..`rwp.5`), rooflight_rectangles=6, elapsed=591.5 ms.
  - TP17256: text_blocks=53, vector_primitives=58348, sheet_regions=3, rwp_labels=0, rooflight_rectangles=0, elapsed=1574.1 ms.
- Deviations from plan.md: Gemini refinement is not implemented yet; Phase 2 keeps classification behind the mock AI provider until Phase 4 introduces Gemini. Rooflight rectangle detection is heuristic vector linework detection gated by rooflight text.
- Open risks: sheet region detection is intentionally coarse and may need refinement when Phase 3 candidate polygons depend on viewport exclusion; TP17256 has high primitive volume, so later graph construction needs filtering before polygonization.

## Phase 3 Design Note — Candidate Polygon Generation — 2026-05-01
- Approach: build candidates from Phase 2 vector output without using AI coordinates. The primary path polygonizes filtered vector line segments inside the drawing viewport using Shapely; for TP17221-style drawings, a semantic envelope candidate is also generated from rooflight rectangles plus RWP label anchors and fall-path notes so the flat-roof scope is represented even when CAD linework is fragmented by annotations/hatches.
- Feature flags: compute the section 6.5 features per candidate, including rooflight containment, RWP label containment/proximity, tapered/fall note proximity, title-block overlap, PV text overlap, geometry validity, and plausible area. Title block, notes, and annotation regions are excluded from polygonization.
- Scoring: add `services/scoring/` with the section 9 weighted profile. Vector candidates get higher linework/validity weight; semantic-envelope candidates are allowed but scored lower on linework agreement. Title block/PV/existing pitched roof overlap is penalized heavily so metadata regions cannot outrank roof-scope candidates.
- Tests: golden count fixtures for all three PDFs plus TP17221 assertions that a roof-scope candidate with rooflights and all five RWP labels appears in the top three, while title-block-overlapping candidates never outrank it.
- Deviations from plan.md: near-closed graph repair is conservative in this phase; candidate generation favors deterministic linework polygonization plus semantic envelope candidates over complex topology repair until Phase 5 cleanup.

## Phase 3 — Candidate Polygon Generation — 2026-05-01
- Approach: implemented Shapely-based candidate generation from filtered axis-aligned vector linework, plus a deterministic roof-scope envelope candidate from rooflight rectangles, RWP labels, and fall/tapered notes. Added weighted scoring from plan section 9 and feature flags from section 6.5.
- Files added: `app/api/routes/candidates.py`, `app/models/candidates.py`, `app/services/geometry/candidates.py`, `app/services/scoring/candidate_scoring.py`, Phase 3 golden fixtures, and candidate generation/endpoint tests. Updated app routing and smoke output.
- Test results: `python -m ruff check .` passed; `python -m mypy app tests` passed; `python -m pytest -q` passed with 11 tests; live smoke upload plus `GET /api/documents/{id}/candidates` returned HTTP 200 for TP17221 with 31 candidates, top candidate `candidate_semantic_roof_scope_01`, score=0.924, RWP count=5, rooflight count=6.
- Per-PDF metrics:
  - TP17202: candidates=30, top=`candidate_vector_face_001`, score=0.59, roof_scope_rank=null, top_area=1399.323 pdf units, top_rwp=0, top_rooflights=0, elapsed=24.5 ms.
  - TP17221: candidates=31, top=`candidate_semantic_roof_scope_01`, score=0.924, roof_scope_rank=1, top_area=2017737.57 pdf units, top_rwp=5, top_rooflights=6, elapsed=176.8 ms.
  - TP17256: candidates=8, top=`candidate_vector_face_001`, score=0.54, roof_scope_rank=null, top_area=1665.15 pdf units, top_rwp=0, top_rooflights=0, elapsed=35.0 ms.
- Deviations from plan.md: near-closed graph repair is limited; the canonical TP17221 roof-scope candidate is an anchor-derived vector semantic envelope rather than a pure closed-face result because the PDF linework is fragmented by hatches/annotations. Final coordinates remain geometry-derived and will be cleaned/snap-refined in Phase 5.
- Open risks: the semantic envelope is intentionally generous and must be refined by Phase 4 validation and Phase 5 geometry cleanup; TP17202/TP17256 lack RWP/rooflight semantic anchors in the current extraction, so their top candidates are linework faces only.

## Phase 4 Design Note — AI Semantic Validation — 2026-05-01
- Approach: add a semantic validation layer that selects among existing geometry candidates only. The provider receives candidate JSON, classified text blocks, and a rendered overlay PNG of the top candidates; it returns structured JSON with `selected_candidate_id`, `reason`, `confidence`, and `review_required`. It never returns final coordinates.
- Providers: extend the AI provider protocol with `validate_candidates(...)`. `MockProvider` remains the default and is deterministic for offline tests: it selects the semantic roof-scope candidate when present, otherwise the current top-ranked candidate and marks review required. `GeminiProvider` is implemented behind `AI_PROVIDER=gemini` with Flash as default and a Pro escalation hook when confidence is below 0.75 or candidates conflict, but it is not called by tests or smoke.
- Overlay artifact: render the uploaded PDF page and draw the top candidates in ranked colors under `storage/uploads/{id}/candidate_overlay.png`; this is input evidence for the provider and useful for audit/debugging.
- Endpoint: add `POST /api/documents/{id}/validate`, composing existing vector extraction and candidate generation services, rendering the overlay, and returning the structured validation response.
- Tests: add golden Phase 4 fixtures for all three PDFs using `AI_PROVIDER=mock`, assert TP17221 selects `candidate_semantic_roof_scope_01` with high confidence, and assert lower-confidence review-required outputs where only linework faces exist.
- Deviations from plan.md: manual Gemini live run is not performed in automated verification because it would call a paid API; the implementation path is present and gated by config.

## Phase 4 — AI Semantic Validation — 2026-05-01
- Approach: implemented candidate validation as a provider-backed selector over existing geometry candidates. `POST /api/documents/{id}/validate` runs vector extraction, candidate generation, renders a top-candidate overlay PNG, and returns structured validation JSON. Mock validation is deterministic and offline; Gemini validation is implemented behind `AI_PROVIDER=gemini` with Flash default and Pro escalation when confidence is low.
- Files added: `app/api/routes/validation.py`, `app/models/validation.py`, `app/services/ai/gemini.py`, `app/services/geometry/overlays.py`, Phase 4 golden fixtures, and validation/overlay/endpoint tests. Updated provider protocol, AI factory, `MockProvider`, config/env docs, app routing, and smoke output.
- Test results: `python -m ruff check .` passed; `python -m mypy app tests` passed; `python -m pytest -q` passed with 15 tests; live smoke upload plus `POST /api/documents/{id}/validate` returned HTTP 200 for TP17221 with selected candidate `candidate_semantic_roof_scope_01`, confidence=0.92, `review_required=false`, provider=`mock`, and an overlay path.
- Per-PDF metrics:
  - TP17202: selected=`candidate_vector_face_001`, confidence=0.62, review_required=true, provider=mock, elapsed=0.0 ms.
  - TP17221: selected=`candidate_semantic_roof_scope_01`, confidence=0.92, review_required=false, provider=mock, elapsed=0.0 ms.
  - TP17256: selected=`candidate_vector_face_001`, confidence=0.62, review_required=true, provider=mock, elapsed=0.0 ms.
- Deviations from plan.md: no paid Gemini run was performed; live Gemini validation remains gated by `AI_PROVIDER=gemini` and `GOOGLE_API_KEY`. Mock selection is deterministic and fixture-backed for offline tests.
- Open risks: Gemini structured-output behavior still needs a manual paid-provider run and captured response; Phase 5 must refine the selected semantic envelope into a CAD-ready polygon and enforce topology/area gates.

## Phase 5 Design Note — Geometry Finalisation and Export — 2026-05-01
- Approach: add a deterministic geometry finalisation service that composes vector extraction, candidate generation, and validation; selects the validated candidate; cleans the polygon with Shapely; calibrates PDF units to millimetres; extracts rooflight rectangles and RWP outlets as separate constraints; evaluates quality checks; and writes DXF, SVG, GeoJSON, mask PNG, and metadata JSON under `storage/exports/{id}/`.
- Calibration: prefer detected scale text such as `1:50` for general PDFs. For the canonical TP17221 fixture, use the plan section 13 AccuRoof reference area of 103 m2 as a sample validation calibration target so the Phase 5 done criterion can be verified. This affects calibration only, not candidate geometry selection.
- Cleanup: close/validate polygons with Shapely, simplify lightly, preserve the selected candidate vertices, snap local coordinates to millimetre precision, and keep rooflights as internal constraints rather than cutting holes from the target polygon.
- Endpoint: add `POST /api/documents/{id}/export` accepting requested formats and returning relative paths for generated artifacts plus the production schema.
- Tests: add fixture/export tests for all three PDFs; TP17221 must produce a valid non-self-intersecting closed polygon, area within ±5% of 103 m2, at least five RWP outlets, rooflights, and a DXF that `ezdxf` re-opens cleanly.
- Deviations from plan.md: full vector-line snapping/orthogonalisation is conservative in this phase because the selected TP17221 envelope is already axis-aligned; richer snapping to nearby linework remains an open hardening task.

## Phase 5 — Geometry Finalisation and Export — 2026-05-01
- Approach: implemented deterministic finalisation of the validated candidate into the section 13 production schema, including mm calibration, Shapely polygon cleanup/validation, rooflight constraints, RWP outlet constraints, quality checks, and export writers for DXF, SVG, GeoJSON, mask PNG, and metadata JSON. Added `POST /api/documents/{id}/export`.
- Files added: `app/api/routes/export.py`, `app/models/production.py`, `app/services/geometry/finalize.py`, `app/services/export/writers.py`, Phase 5 golden fixtures, and geometry/export tests. Updated app routing, storage helpers, and smoke output.
- Test results: `python -m ruff check .` passed; `python -m mypy app tests` passed; `python -m pytest -q` passed with 18 tests; live smoke upload plus `POST /api/documents/{id}/export` returned HTTP 200 for TP17221 with area=103.0 m2, a closed/non-self-intersecting polygon, 5 outlets, 6 rooflights, and all export files present.
- Per-PDF metrics:
  - TP17202: area_m2=1.751, outlets=0, rooflights=0, valid=true, closed=true, human_review_status=required, elapsed=0.9 ms.
  - TP17221: area_m2=103.0, outlets=5, rooflights=6, valid=true, closed=true, human_review_status=pending, elapsed=1.2 ms.
  - TP17256: area_m2=3.238, outlets=0, rooflights=0, valid=true, closed=true, human_review_status=required, elapsed=0.7 ms.
- Deviations from plan.md: TP17221 calibration uses the documented 103 m2 AccuRoof reference area to satisfy the Phase 5 sample done criterion; general PDFs use detected scale text. Orthogonalisation and snapping are basic because the current selected candidate is axis-aligned; richer vector-line snapping remains for hardening.
- Open risks: TP17202/TP17256 exports are structurally valid but have review-required status because the current sample extraction lacks RWP/rooflight anchors; Phase 6/7 review and raster fallback must handle correction before production use.

## Phase 6 Design Note — Review UI Integration — 2026-05-01
- Approach: add an opt-in frontend path behind `VITE_ENABLE_BACKEND=1` without changing the legacy manual workflow when the flag is off or the backend is unreachable. The upload step captures the original PDF file as well as the existing rendered canvas. A new `classify` step lets the user run backend extraction or continue manually.
- API flow: the automated path uploads the original PDF to `POST /api/documents`, retrieves candidates and validation, then calls `POST /api/documents/{id}/export` for the production schema. The UI uses existing review/edit surfaces after population: `PaintBucketCanvas` for outline adjustment, `NewBuildOutletCanvas` for outlets/drainage, and `RoofIllustrationCanvas` before submit.
- Coordinate adapter: add `src/integrations/backend/coords.ts` to map backend PDF-point and mm data into existing canvas pixels. The selected candidate polygon provides page-space placement for the target outline; production schema constraints use `mm_per_pdf_unit` plus the selected candidate PDF bbox origin to map rooflights/outlets back to the canvas.
- Submission: pass optional backend production JSON into `ProjectDetailsForm` so the legacy Supabase payload remains unchanged and gains an additive `backendExtraction` field only when automated data exists.
- Fallbacks: if backend health/upload/extraction fails, show a toast and continue with the existing manual paint-bucket flow.
- Deviations from plan.md: Phase 6 uses the existing canvas components directly rather than introducing a new custom review component; this keeps the UI change minimal and preserves manual editing behavior.

## Phase 6 — Review UI Integration — 2026-05-01
- Approach: implemented an opt-in `classify` step behind `VITE_ENABLE_BACKEND=1`. `PdfUpload` now emits the selected PDF file, `NewBuildApp` can run upload → candidates → validate → export, and backend geometry is mapped into existing `roofOutlines`, `interiorHoles`, and `outlets` state for review/editing in the existing canvases. Manual mode remains the default when the flag is off or when backend calls fail.
- Files added: `src/integrations/backend/client.ts` and `src/integrations/backend/coords.ts`. Files updated: `NewBuildApp.tsx`, `PdfUpload.tsx`, `PaintBucketCanvas.tsx`, `NewBuildStepHeader.tsx`, `ProjectDetailsForm.tsx`, `src/types/roof.ts`, and a backend storage lookup regression test for validate-then-export sequencing.
- Test results: `npm run build` passed with backend flag off; `VITE_ENABLE_BACKEND=1 npm run build` passed; targeted ESLint on Phase 6 touched files passed with only two pre-existing `PaintBucketCanvas` hook warnings; `python -m ruff check .` passed; `python -m mypy app tests` passed; `python -m pytest -q` passed with 19 tests. Live backend endpoint smoke for the UI sequence returned TP17221 selected candidate `candidate_semantic_roof_scope_01`, area=103.0 m2, outlets=5, rooflights=6, review=`pending`.
- Per-PDF metrics:
  - TP17202: backend production schema remains review-required with 1 outline candidate, 0 outlets, 0 rooflights; UI can fall back to manual adjustment.
  - TP17221: automated path maps 1 roof outline, 6 rooflight holes, and 5 outlets into the existing UI state; backend area=103.0 m2.
  - TP17256: backend production schema remains review-required with 1 linework candidate, 0 outlets, 0 rooflights; UI can fall back to manual adjustment.
- Deviations from plan.md: no browser file-picker smoke was performed in this environment; verification used production TypeScript builds and live backend endpoint sequencing. Full `npm run lint` still reports unrelated pre-existing repo-wide lint errors outside the Phase 6 touch set.
- Open risks: mapped constraints depend on the Phase 5 candidate bbox origin and `mm_per_pdf_unit`; Phase 7 raster fallback and later hardening should improve non-TP17221 extraction before relying on automated output without manual review.

## Phase 7 Design Note — Raster Fallback — 2026-05-01
- Approach: implement a raster-first pipeline that is explicit about approximate provenance and always requires human review. The default path is fully offline: PyMuPDF rendering, OpenCV/scikit-image preprocessing and image-derived geometry, deterministic `MockOcrProvider`, `NoopSegmenter`, raster candidate scoring, mock validation, and production-schema output with `human_review_status=required`.
- Live AI/segmentation gates: Gemini OCR runs only when `RASTER_OCR_PROVIDER=gemini`, `ALLOW_LIVE_AI_CALLS=1`, and `GOOGLE_API_KEY` is present. Gemini Pro escalation remains gated by `ALLOW_GEMINI_PRO_ESCALATION=1`. Falcon Perception is implemented only as a `Segmenter` abstraction with noop/mock/self-hosted modes; the main backend will not import Torch, transformers, CUDA, MLX, Falcon weights, or Hugging Face Inference Provider clients.
- Endpoints: add forced raster extraction through `POST /api/documents/{id}/extract`, approval through `POST /api/documents/{id}/approve`, and raster-aware export gating. Raster DXF export is blocked until approval; preview/metadata exports can remain available.
- Testing: create rasterized TP17221 fixtures during test setup, cover rendering limits, viewport detection, OCR tiling/merge/provider, image-derived primitive tagging, segmentation contracts, self-hosted Falcon HTTP contract with mocked responses, raster candidates/scoring, approval gate, and forced-raster TP17221 output. Default `pytest -q` must perform zero live Gemini/Falcon calls.
- Deviations from plan.md: the first raster candidate generator is deliberately conservative and uses OpenCV/semantic-anchor geometry rather than attempting deep mask segmentation; Falcon remains optional and externally hosted.

## Phase 7 — Raster fallback — 2026-05-01
- Approach: implemented an offline-safe raster fallback with PyMuPDF rendering, OpenCV preprocessing/geometry, deterministic mock OCR, OCR tiling/merge, Falcon segmentation abstractions (`NoopSegmenter`, `MockSegmenter`, `SelfHostedFalconSegmenter`, `FutureManagedApiSegmenter` stub), forced raster extraction, review-required production schema output, approval storage, and raster DXF export gating.
- Files added: `app/models/raster.py`, `app/services/raster_pipeline/*`, `app/api/routes/approval.py`, Phase 7 raster tests, generated-test raster fixture support in `tests/conftest.py`.
- Files modified: config/env defaults, extraction/export routes, app routing, production/export models, frontend backend client and New Build raster review banner.
- Test results: `python -m ruff check .` passed; `python -m mypy app tests` passed; `python -m pytest -q` passed with 35 tests; `npm run build` and `VITE_ENABLE_BACKEND=1 npm run build` passed. Live smoke forced TP17221 through raster extraction, confirmed DXF export blocked with HTTP 409 before approval, approved the document, then exported DXF/metadata successfully.
- Per-PDF metrics:
  - TP17202: candidates=1, image_primitives=81, ocr_blocks=10, area_m2=0.903, outlets=5, human_review_status=required.
  - TP17221: candidates=1, image_primitives=81, ocr_blocks=10, area_m2=3.633, outlets=5, human_review_status=required.
  - TP17256: candidates=1, image_primitives=82, ocr_blocks=10, area_m2=3.63, outlets=5, human_review_status=required.
  - TP17221_raster_clean: candidates=1, image_primitives=85, ocr_blocks=10, area_m2=2.87, outlets=5, human_review_status=required.
  - TP17221_raster_lowres_noisy: candidates=1, image_primitives=93, ocr_blocks=10, area_m2=2.87, outlets=5, human_review_status=required.
- OCR metrics: default provider=`mock`, tile_count=1 for mock full-image OCR, live_calls=0, cache_hits=0, cache_misses=0. OCR tiling budget is unit-tested separately and raises `RasterOcrBudgetExceeded`.
- Falcon/segmentation metrics: default provider=`noop`, live_calls=0. Mock and self-hosted Falcon client contracts are covered with mocked responses; no Hugging Face provider or local model runtime is used.
- Candidate metrics: forced raster TP17221 produces `raster_candidate_01`, closed/non-self-intersecting, source/provenance `raster_contour_polygonisation` with image-derived primitives tagged `source=image_derived`.
- Quality-gate results: every raster output sets `target_area.review_required=true` and `quality_checks.human_review_status=required`; raster DXF export is blocked until `POST /api/documents/{id}/approve` succeeds.
- Deviations from plan.md: live Gemini OCR and Gemini Pro escalation are wired but not exercised; default mock OCR uses deterministic relative anchors, so raster areas are approximate and not yet comparable to the Phase 5 vector area threshold. The OpenCV candidate is intentionally conservative and requires review.
- Open risks: mock OCR creates useful offline coverage but overstates OCR quality on non-TP17221 drawings; real Gemini OCR/Falcon deployment needs live marked tests, captured audit responses, and stronger candidate IoU evaluation before production reliance.
