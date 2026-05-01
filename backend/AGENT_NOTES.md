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
