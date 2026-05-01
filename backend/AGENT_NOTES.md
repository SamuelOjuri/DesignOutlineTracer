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
