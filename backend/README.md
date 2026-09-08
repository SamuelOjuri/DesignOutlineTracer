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

Default raster extraction:

```powershell
Invoke-RestMethod `
  -Method Post `
  "http://127.0.0.1:8000/api/documents/$($upload.document_id)/extract"
```

```bash
curl -X POST "http://127.0.0.1:8000/api/documents/$DOCUMENT_ID/extract"
```

Default raster preview export:

```powershell
Invoke-RestMethod `
  -Method Post `
  "http://127.0.0.1:8000/api/documents/$($upload.document_id)/export"
```

```bash
curl -X POST "http://127.0.0.1:8000/api/documents/$DOCUMENT_ID/export"
```

Explicit vector export:

```powershell
Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"pipeline":"vector","formats":["dxf","svg","geojson","mask_png","metadata_json"]}' `
  "http://127.0.0.1:8000/api/documents/$($upload.document_id)/export"
```

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"pipeline":"vector","formats":["dxf","svg","geojson","mask_png","metadata_json"]}' \
  "http://127.0.0.1:8000/api/documents/$DOCUMENT_ID/export"
```

Raster approval gate:

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
