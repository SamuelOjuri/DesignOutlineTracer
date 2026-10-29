# Automatic insulation-scope outlines

The assisted New Build workflow now offers **Generate outline** in Step 3,
**Set Outlines**, after a roof ROI has been accepted. It proposes exterior roof
polygons, fits them conservatively to source linework, and keeps the result
separate from the editable drawing until **Use outline** is selected.

## Using the feature

1. Upload the PDF and select its drawing scale. Accept or manually draw the
   required roof region in Step 2.
2. In Step 3, select the roof region and boundary convention. The default is
   **Insulation edge / inner parapet face**. **Roof deck edge** and **Outer roof
   edge** are alternatives. Optional boundary guidance records job-specific
   exceptions. This is an explicit user choice; the default is not a claim that
   all projects or reference drawings use that convention.
3. Select **Generate outline**. This explicitly uploads the pristine page and
   requests model interpretation. Blue shows the proposed scope, while orange
   dashed edges identify weak or ambiguous evidence. Generation does not enable
   progression until an outline is applied or manually drawn.
4. Review the proposal. If replacing existing geometry, explicitly select the
   outlines to replace. Unselected roofs are preserved and overlapping additions
   are rejected. **Use outline** installs the polygons directly, without passing
   them through the manual fill tool's dilation/contour cleanup.
5. **Undo generated outline** restores the preceding drawing in one action,
   while that application remains the latest page edit. Further manual edits
   use the existing canvas Undo. Existing adjustment tools remain available.
6. Review rooflights and other openings separately in Step 4. Changing or undoing
   the base scope invalidates dependent opening decisions; it does not silently
   restore stale accepted openings.

An ROI that cuts off the proposed scope must be corrected before use. Cropping
supplies context and never turns the ROI rectangle into a roof perimeter.
Generation failure, cancellation, navigation and stale responses leave existing
geometry intact. Changing the region, policy, guidance, page or scope invalidates
the pending proposal. Review and drawing state still live only in the open
New Build screen; this feature does not add persistence.

## Pipeline

- PDF.js renders the immutable page at the existing scale. Public PDF operator
  lists additionally supply bounded straight stroke segments in source-page
  coordinates, respecting page bounds and supported convex quadrilateral/Form
  clips. Curves, dashed strokes and unsupported clipping fall back to raster
  evidence. No original PDF is uploaded for vector extraction.
- The client sends up to 2,000 nearby vector segments, prioritising longer
  strokes, together with the accepted ROI and chosen boundary convention.
- The backend crops the **original** uploaded pixels with a 6% context margin
  (at least four pixels), then reduces the crop to a maximum side of 2,048 pixels.
  Gemini also receives the pristine 1,024-pixel full-page overview for context.
  The model is instructed to use the first image's crop coordinates only.
- A separate outline system/task prompt requests up to eight exterior rings,
  each with 3-128 ordered fractional points normalised to the crop. Interior
  holes and building-design calculations are excluded. Drawing content and
  boundary notes cannot override the response contract or trigger actions.
- Crop coordinates are mapped back to the source page. Invalid, intersecting,
  touching or nested components are rejected. Scope beyond the accepted ROI
  returns `roi_too_tight`, rather than silently clipping the roof.
- Vector segments supply candidate supporting lines; high-resolution raster
  contrast is the fallback. Collinear fragments contribute joint edge support.
  Small movements and consistent rotated directions are allowed. Equally
  plausible parallel faces retain the initial edge and produce a review warning.
  Adjacent fitted lines determine corners. The complete ring is checked again
  for topology, area change, displacement and containment before fitting is used.
- No mask dilation, convex hull, blanket orthogonalisation or inferred rooflight
  holes are applied. Evidence scores measure line support, not calibrated model
  confidence or construction accuracy.

The algorithm intentionally uses local, bounded fitting, not unrestricted CAD
reconstruction. A proposal far from the true edge can remain approximate and
requires review. Unsupported sides, dense dimensions, parallel parapets, pale
lines and curves remain important evaluation cases. The model determines scope;
the geometric fitter cannot independently establish the correct business meaning
of a roof boundary. No sample-specific coordinates or colours are encoded.

## API and integration

`POST /api/roi/v1/pages/{page_id}/outlines` has its own `outline-1` contract. It
does not change the existing box annotation schema or add polygon meaning to
`box_2d`. Requests include page/source identity, request ID, ROI and geometry
revisions, one accepted parent ROI, boundary policy/notes and optional vectors.

Responses include source-pixel proposed/fitted points, per-edge evidence,
warnings, crop transforms, model/prompt/algorithm versions and generation
settings. Only `complete` and `needs_review` responses with valid polygons can
be applied. `no_outline` and `roi_too_tight` preserve the manual workflow.

Ownership, local-origin checks, request IDs, session/page lifetimes, provider
concurrency, retry deadlines and global/session call budgets are shared with
the ROI service. Outline requests are bounded to 512 KiB. Cache identity includes
the source, ROI/revisions, boundary notes, vector data, prompt, algorithm and
model settings. Source and review revisions are checked again before applying.
Cancellation prevents browser application; a provider call already sent can
still consume the shared budget and incur charges.

The frontend's atomic application reconciles existing cutouts against the new
scope, preserves unrelated roofs/outlets, and removes drainage-edge assignments
belonging to replaced outlines. The current editor, penetration processing,
illustration and project form consume the resulting `PagePolygon` records.

No new dependency or environment variable is required. Existing
`VITE_ROI_ENABLED=true`, provider configuration and `ROI_ALLOW_LIVE` govern
availability. Restart the backend to load the new endpoint/prompts; restart or
rebuild the frontend to load these changes. Do not reset budgets merely to retry
a failed detection.

## Verification and remaining evaluation

Offline tests cover crop transforms, stepped and rotated geometry, line fitting,
ambiguous faces, topology rejection, ROI containment, request ownership, shared
budgets, caching, provider image/system-prompt contracts, frontend stale-result
guards, explicit replacement, opening invalidation and atomic undo. The browser
regression uses a synthetic stepped PDF and mocked annotation service to check
native vector extraction, overlay alignment, notch preservation and source-image
immutability. No real project email or live model call is required.

```powershell
& ./backend/app/.venv/Scripts/python.exe -m unittest discover -s backend/roi_tests
npm test -- --maxWorkers=1
npm run typecheck
npm run test:e2e:roi
npm run test:e2e
npm run build -- --outDir .vite/outline-build-check
```

These checks verify implementation and geometric safeguards. They do not
establish live model accuracy on TP17221 or other private drawings. Evaluate
source-aligned reference polygons on varied held-out jobs, measuring missing and
excess scope, boundary-distance errors, retained returns/components and user
correction time. Use agreed boundary conventions and verified scale before
converting errors to physical units. Keep reference answers out of model inputs
when measuring accuracy.
