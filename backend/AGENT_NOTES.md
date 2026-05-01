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
