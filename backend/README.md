# Design Outline Tracer Backend

FastAPI service for the production roof-plan extraction pipeline described in `../docs/plan.md`.

Phase 0 provides the service shell only: settings, logging, `/health`, development tasks, and sample-PDF test fixtures. Later phases add upload classification, vector/raster extraction, candidate scoring, validation, geometry finalisation, export, and review UI integration.

## Setup

```powershell
cd backend
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .[dev]
uvicorn app.main:app --reload --port 8000
```

`GET /health` returns:

```json
{
  "status": "ok"
}
```

The backend loads environment values from the repo root `.env` first and `backend/.env` second, so local backend overrides win. Copy `.env.example` to `.env` only for backend-specific overrides.

## Useful Commands

```powershell
.\tasks.ps1 Test
.\tasks.ps1 Lint
.\tasks.ps1 Typecheck
.\tasks.ps1 Smoke
```

GNU Make equivalents are also available:

```bash
make test
make lint
make typecheck
make smoke
```

## Planned API Contract

The minimum frontend integration will call an opt-in backend path without changing the legacy Supabase email function. Automated results will map onto the existing `NewBuild` state:

- `target_area.outer_polygon_mm` maps to `roofOutlines` after mm-to-canvas conversion.
- `constraints.rooflights[].polygon_mm` maps to `interiorHoles`.
- `constraints.rainwater_outlets[]` maps to `outlets`.
- Fall arrows or parapet-derived drainage edges map to `drainageEdges` when available.

The production response shape follows `docs/plan.md` section 13:

```json
{
  "document": {
    "document_id": "823-UA-CD-02-DR-A-102-P2",
    "drawing_type": "roof_plan",
    "source_type": "vector_pdf",
    "source_file": "TP17221_25.01_input.pdf"
  },
  "coordinate_systems": {
    "pdf": {
      "units": "pdf_points",
      "page_width": 2384,
      "page_height": 1684
    },
    "cad": {
      "units": "mm",
      "scale": "1:50",
      "calibration_source": "dimension_or_user_verified"
    }
  },
  "drawing_metadata": {
    "title": "Roof Plan",
    "scale": "1:50",
    "drawing_number": "823-UA-CD-02-DR-A-102",
    "revision": "P2",
    "status": "Preliminary",
    "confidence": 0.98
  },
  "target_area": {
    "id": "target_tapered_scope_01",
    "type": "tapered_insulation_scope",
    "outer_polygon_mm": [[0, 0], [1000, 0], [1000, 1000]],
    "holes": [],
    "area_m2_estimated": 103.0,
    "area_source": "computed_from_polygon",
    "geometry_source": "vector_pdf_polygonization",
    "semantic_validation_source": "gemini_2_5_flash",
    "confidence": 0.94,
    "review_required": false
  },
  "constraints": {
    "rainwater_outlets": [
      {
        "id": "rwp.1",
        "type": "rainwater_downpipe",
        "point_mm": [0, 0],
        "confidence": 0.91
      }
    ],
    "rooflights": [
      {
        "id": "rooflight_01",
        "polygon_mm": [[0, 0], [100, 0], [100, 100]],
        "treatment": "upstand_or_penetration",
        "confidence": 0.89
      }
    ],
    "excluded_regions": [
      {
        "type": "pv_array",
        "reason": "outside_tapered_insulation_scope"
      },
      {
        "type": "title_block",
        "reason": "sheet_metadata"
      },
      {
        "type": "existing_pitched_roof",
        "reason": "not_part_of_flat_roof_tapered_scope"
      }
    ]
  },
  "quality_checks": {
    "polygon_closed": true,
    "self_intersections": false,
    "contains_rooflights": true,
    "contains_or_borders_rwp": true,
    "excludes_title_block": true,
    "excludes_legend": true,
    "scale_calibrated": true,
    "human_review_status": "pending"
  },
  "exports": {
    "dxf": "roof_scope_outline.dxf",
    "svg": "roof_scope_overlay.svg",
    "geojson": "roof_scope.geojson",
    "mask_png": "roof_scope_mask.png",
    "metadata_json": "roof_scope_metadata.json"
  }
}
```

## Endpoint Examples

Run the server first:

```powershell
uvicorn app.main:app --reload --port 8000
```

Health:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

```bash
curl http://127.0.0.1:8000/health
```

Upload and classify:

```powershell
$upload = curl.exe -s -X POST `
  -F "file=@../docs/TP17221_25.01_input.pdf;type=application/pdf" `
  http://127.0.0.1:8000/api/documents | ConvertFrom-Json
$upload.classification
```

```bash
curl -X POST \
  -F "file=@../docs/TP17221_25.01_input.pdf;type=application/pdf" \
  http://127.0.0.1:8000/api/documents
```

Vector extraction:

```powershell
Invoke-RestMethod "http://127.0.0.1:8000/api/documents/$($upload.document_id)/vector"
```

```bash
curl "http://127.0.0.1:8000/api/documents/$DOCUMENT_ID/vector"
```

Candidate generation:

```powershell
Invoke-RestMethod "http://127.0.0.1:8000/api/documents/$($upload.document_id)/candidates"
```

```bash
curl "http://127.0.0.1:8000/api/documents/$DOCUMENT_ID/candidates"
```

Semantic validation:

```powershell
Invoke-RestMethod `
  -Method Post `
  "http://127.0.0.1:8000/api/documents/$($upload.document_id)/validate"
```

```bash
curl -X POST "http://127.0.0.1:8000/api/documents/$DOCUMENT_ID/validate"
```

Vector export:

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"formats":["dxf","svg","geojson","mask_png","metadata_json"]}' `
  "http://127.0.0.1:8000/api/documents/$($upload.document_id)/export"
```

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"formats":["dxf","svg","geojson","mask_png","metadata_json"]}' \
  "http://127.0.0.1:8000/api/documents/$DOCUMENT_ID/export"
```

Raster extraction (the default for PDFs):

`POST /api/documents/{id}/extract` now uses raster-first extraction for PDFs unless
`force_pipeline` is explicitly `vector_first`. Upload classification still reports
the source characteristics; its recommendation does not override this default.
DWG/DXF CAD-first extraction remains unsupported.

For raster extraction, `page_index` is zero-based and defaults to `0`. For example,
send `page_index: 1` to process page 2. Negative, non-integer, and out-of-range page
indices return HTTP 422. The selected page is used for rendering and OCR, and is
reported in `render.page_index` and the raster extraction audit event. The original
multi-page PDF remains stored unchanged.

New Build sends the successfully rendered preview page and consumes the raster
production schema directly; it does not call the vector candidate, validation, or
export endpoints during automated extraction. Raster geometry still requires
human review before CAD export. Explicit vector extraction and the dedicated
`GET /api/documents/{id}/vector` endpoint retain their document-wide behavior.

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"force_pipeline":"raster_first","page_index":0}' `
  "http://127.0.0.1:8000/api/documents/$($upload.document_id)/extract"
```

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"force_pipeline":"raster_first","page_index":0}' \
  "http://127.0.0.1:8000/api/documents/$DOCUMENT_ID/extract"
```

### Live Raster Providers

Gemini OCR and Gemini ER grounding are implemented using `google-genai` structured
responses. To enable them, configure the backend environment:

```dotenv
RASTER_OCR_PROVIDER=gemini
SEGMENTATION_PROVIDER=gemini_er
ALLOW_LIVE_AI_CALLS=1
GEMINI_ER_MODEL=gemini-robotics-er-2-preview
GEMINI_ER_MAX_IMAGE_DIMENSION=2048
GEMINI_ER_CACHE_DIR=cache/gemini_er
OCR_CACHE_DIR=cache/ocr
OCR_TILE_SIZE_PX=2048
OCR_TILE_OVERLAP_PX=256
OCR_MAX_TILES=12
RASTER_MAX_TILE_PIXELS=5000000
```

Set `GOOGLE_API_KEY` through your local environment or secret manager, and set
`GEMINI_OCR_MODEL` to an image-capable structured-output model enabled for your
Google project. `GEMINI_ER_MODEL` is also configurable. Model availability, quota,
and account access must be verified separately; the automated tests use fake SDK
clients and do not contact Google. Restart the backend after changing settings.
For offline development, use `RASTER_OCR_PROVIDER=mock`,
`SEGMENTATION_PROVIDER=noop`, and `ALLOW_LIVE_AI_CALLS=0`. Unknown provider names
are rejected instead of silently selecting a mock/no-op implementation.

OCR covers the selected page with overlapping tiles. If the configured tile grid
would exceed `OCR_MAX_TILES`, source tiles are enlarged to fit that budget, then
each request image is resized as needed to respect `RASTER_MAX_TILE_PIXELS`.
`OCR_TILING_ADAPTED` warns when this happens: coverage is preserved, but downscaling
can reduce small-text accuracy. Increase the tile budget to retain more detail
at the cost of more requests. OCR boxes are reprojected from request-image pixels
to full-page pixels before overlap deduplication. OCR errors stop extraction and
return HTTP 422 with a sanitized model/error description in the JSON `detail`.
Inspect that response body when the server access log only shows a status code.

ER supplies roof search boxes, not final geometry. OpenCV finds image-supported
contours within those search regions and returns review-required candidates.
The model's boxes are never directly converted into roof polygons. If ER fails,
the response retains its call/error audit and emits `SEGMENTATION_UNAVAILABLE`;
if no supported contour is found, it emits `GEMINI_ER_NO_CONTOUR`. The pipeline
continues with its existing fallback candidates, which require manual review.

Both providers cache validated JSON using image content, model, and prompt version
as the cache key. Relative cache directories resolve under `STORAGE_ROOT`; the
legacy `OCR_CACHE_DIR=storage/cache/ocr` is also accepted when `STORAGE_ROOT=storage`.
OCR caches contain drawing text and ER caches contain spatial hints. Protect and
retain these local files according to your document-data policy. API responses
report `ocr_audit`, `segmentation_audit`, and generic segmentation call/cache counts
in `raster_audit`; Falcon-specific counters remain separate.

These provider changes do not make raster output CAD-ready: the current production
schema still contains approximate calibration and placeholder rooflight geometry.
Review dimensions, outlines, openings, and outlets before approving any export.

### Raster Approval Gate

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"pipeline":"raster","formats":["dxf"]}' `
  "http://127.0.0.1:8000/api/documents/$($upload.document_id)/export"
# Returns 409 until approved.

Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"approved_by":"user","target_area":{"outer_polygon_mm":[[0,0],[1,0],[1,1]],"holes":[]},"constraints":{"rainwater_outlets":[],"rooflights":[],"excluded_regions":[]}}' `
  "http://127.0.0.1:8000/api/documents/$($upload.document_id)/approve"
```

Audit logs are written locally to:

```text
storage/uploads/<document_id>/audit.json
```

## Phase Mapping

- Phase 0: bootstrap, health, settings, sample fixture smoke tests.
- Phase 1: source classification and `POST /api/documents`.
- Phase 2: vector document extraction and `GET /api/documents/{id}/vector`.
- Phase 3: candidate polygon generation and scoring.
- Phase 4: AI semantic validation behind mock/Gemini providers.
- Phase 5: final geometry and export.
- Phase 6: optional frontend review integration.
- Phase 7: raster fallback with Gemini OCR and OpenCV geometry.
- Phase 8: quality gates, audit logs, and integration hardening.
