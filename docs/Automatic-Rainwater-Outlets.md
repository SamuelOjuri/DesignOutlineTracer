# Automatic rainwater outlets

Step 5, **Add Outlets**, now offers explicit **Detect outlets** in the assisted
New Build workflow. It uses the accepted roof areas, applied insulation outlines,
manual cutouts and accepted/current Step 4 openings. The original manual workflow
and drainage-edge tools remain available.

## Review workflow

1. Accept a roof area in Step 2 and apply or draw its insulation outline in Step 3.
2. Review penetration openings in Step 4.
3. In Step 5 select **Detect outlets**. This uploads the immutable source page and
   requests detailed crops; entering the step does not call the model.
4. Review the suggested magenta inlet markers. Select a recommendation to see its
   evidence, type, assigned outline and any scope warnings. **Accept eligible**
   accepts current, geometrically valid suggestions without warnings. Other
   candidates can be corrected and accepted individually. Once a detection is
   included in the output, its review button reads **Accepted** and is disabled;
   **Reject** and **Delete** remain available. The panel counts both sources, for
   example "1 of 2 detected outlets accepted · 1 manual outlet".
5. Drag a point or enter its original-page coordinates to correct the inlet.
   **Correct position, type or size > Use symbol centre** is available when the
   detected box centre is a different, valid position. Check that the box encloses
   the roof-side inlet before accepting; the external RWP dot is the downpipe.
   Reject/delete unwanted suggestions, or use **Add manually** for missed points.
   **Undo outlet edit** restores reviewed detection state without discarding
   subsequent manual placements.
6. The final illustration and submission include current accepted detections and
   manual outlets. The outlet summary identifies unresolved suggestions and
   unconfirmed diameter defaults.

Detection does not infer outlet diameter, falls, drainage edges or hydraulic
design. The inherited 150 mm diameter is explicitly an unconfirmed application
default; users can confirm/change a detected outlet's diameter. Sumps are not
implemented and do not influence the marker.

## Marker rules

- Transparent circle and central crosshair in magenta (`#C000A0`), with a thin white halo.
- Preferred complete footprint: 24 CSS pixels across. The anchor remains in
  original-page pixels, independent of zoom and the physical diameter.
- For an interior inlet, reduce the entire painted footprint to the clearance
  from its assigned effective scope, including angled edges, concave returns and
  holes where possible. Keep a minimum complete footprint of 12 CSS pixels across
  (including the halo), even when this overlaps a boundary. A display symbol must
  never disappear because its inlet is close to an edge. This applies to suggested,
  accepted and manual outlets without moving their anchors or relaxing validation.
- Accepted and manual outlets share one footprint across every roof in the view:
  the largest that fits all of their interior anchors, subject to that visible minimum.
  This keeps circles, crosshairs and strokes
  uniform in the outlet editor, Project Details, saved-area previews and drawing
  PNG exports. Pending/stale/outside suggestions do not reduce
  that size. Near-edge anchors participate in the shared size and remain visible.
- For an inlet exactly on an exterior perimeter, allow the circle to overlap
  that perimeter with a compact 12 CSS-pixel footprint, using the same size as its
  accepted peers. Outside suggestions also use this compact footprint while
  retaining their broken-ring review style and scope warning. Never shift or clip the symbol.
  Numerical boundary tolerance is fixed in source coordinates, not screen pixels.
- Opening edges remain excluded. Invalid/outside suggestions are visible for
  correction but cannot be accepted until their association is valid.
  Marker size is visual: reducing it or changing physical diameter does not resolve
  an out-of-scope inlet centre. Correct the anchor or assigned outline instead.
- Suggested or unresolved points use a broken ring: four solid arcs centred on
  the crosshair arms with wide diagonal gaps over a continuous white halo. A
  fine dash pattern is not used because it blurs at marker size. Selection uses an inner
  ring, keeping its footprint within the same limit. Hit targets remain usable
  at a fixed screen size. **Zoom to outlet** and sidebar selection remain
  available for small markers.
- The final illustration shares the same marker renderer. Explicit outline
  ownership keeps a boundary outlet with its roof when the illustration moves.
- Confirmed opening boundaries use continuous strokes in review, the outlet
  editor, Project Details and PNG/SVG exports. Pending penetration suggestions
  retain dashed review boxes. CAD geometry and physical outlet diameters are
  independent of these display styles.
- In penetration review, the geometry layer draws confirmed openings once with
  the same screen-space stroke as the insulation boundary. Editing overlays keep
  labels and resize handles without adding a second border or selection outline.

## Detection contract

`POST /api/roi/v1/pages/{page_id}/outlets` uses `contract_version: "outlet-1"`.
Requests include page/source identity, request ID, accepted ROI revisions,
geometry revision, an effective-scope signature and per-outline source-pixel
polygons with holes. Original excluded openings are also supplied, so subtracting
a cutout that touches the perimeter cannot turn its edge into an eligible inlet.

The service uses padded crops of the original image (maximum 2,048 pixels per
side), overlapping tiles for large components and a 1,024-pixel page overview.
The model returns normalized coordinates in the first crop. Both inlet anchors
and tight symbol boxes are transformed back to the original page. The prompt
distinguishes actual rainwater inlets from SVPs, dry risers, text-only RWP labels,
and symbols serving another roof. Drawing text is evidence, not instructions.

Responses contain source-pixel inlet anchors, original anchors, normalized
page symbol boxes, subtype, roof/outline ownership, evidence and review warnings.
Deterministic validation checks actual scope geometry after inference. Exterior
boundary points are allowed; excluded openings and outside points need correction.

For blue/cyan rectangular parapet inlets, a bounded source-image pass refines the
model anchor to the visible inlet box centre before scope validation. It requires
one nearby box with at least three supported sides, corner evidence and an empty
interior. Dashed U-shaped boxes are supported. The pass does not snap to the roof
perimeter, infer a fixed inset, or substitute an external downpipe. Original
anchors and boxes are retained for reconciliation. Clipped/ambiguous boxes,
circles, arrows, unsupported colours and opening conflicts keep their model
positions for review. This uses the original upload and no additional model calls.
The algorithm version and prompt hash invalidate previous detection caches.

TP17221 illustrates why symbol positioning and marker size must be separate:
each roof-side cyan inlet box is paired with an external RWP dot. The validation
drawing likewise shows inlet/downpipe pairs; some inlet circles touch the outline.
Use the inlet centre as the stored/exported position. A screen-sized review marker
can still touch the boundary at low zoom, and changing diameter does not correct
an erroneous anchor. Existing reviewed suggestions are preserved on reruns; use
the correction controls for those points rather than expecting re-detection to
overwrite them.

Page ownership, source identity, provider concurrency, global/session call
budgets, timeouts, page expiry and cache lifetime use the existing ROI service.
Each request checks at most eight detailed crops; incomplete scans return
`partial` with warnings. Repeating an unchanged oversized scope checks the same
initial crops, so the remaining areas need manual completion. Calls are not
silently added beyond the configured budget. Cancellation prevents applying
late results; already sent provider work may still consume its call budget.

The request is bounded to 512 KiB, 25 scopes and 8,192 total vertices. The
configured annotation limit also applies. No new dependencies or environment
variables are required. Existing `VITE_ROI_ENABLED`, provider configuration and
`ROI_ALLOW_LIVE` control availability. Restart/rebuild the frontend and restart
the backend to load the new endpoint; do not restart a live pilot to bypass its
call limits.

## State and output

Accepted detected outlets are derived from reviewed annotations. Reject/delete
and undo cannot leave a second independent editor object behind. Original inlet
positions support reconciliation after user corrections. Reruns preserve prior
decisions; deleted detections retain a hidden record to prevent resurrection.
Nearby/manual matches are reconciled only within the same source-page context.

Effective-scope identity includes accepted Step 4 openings, not just the stored
outline/hole revision. Scope changes invalidate pending requests and mark
existing detections for review. Undo cannot silently restore acceptance against
an outdated scope. Unresolved detections are excluded from combined output.
The outlet payload retains page, ROI, outline, annotation and subtype metadata,
alongside the inherited position/diameter fields and diameter-confirmation flag.
The external submission receiver is not part of this repository.

Review state remains in memory. This feature does not introduce save/reload
persistence or an automatic engineering design approval.

## Verification

Source-symbol correction verified offline on 2026-11-02: all five TP17221 inlet
boxes were localised from the original PDF with deliberately seeded perimeter
anchors. These are simulated coordinate errors, not a captured live model run.
The fitted anchors remained in scope. Tests cover ambiguous boxes, opening
exclusion, unsupported colours, circles/arrows, transparency, API transforms,
original-proposal preservation and the explicit symbol-centre correction.

Verified on 2026-10-29: 227 frontend unit/component tests, 88 backend tests and
12 browser regressions pass. Type checking, lint and the production build pass;
the nine existing lint warnings and bundle-size warning remain. No live model
calls or real project submissions were made.

Offline tests cover scope subtraction, touching cutouts, boundary anchors,
coordinate transforms, crop limits, source identity, budgets/cache, malformed
responses, late requests, corrections, deduplication, rejection/delete/undo,
marker sizing and final illustration ownership. A mocked browser flow exercises
upload, outline generation, detection, acceptance, rejected out-of-scope points,
zoom, reruns, pristine source uploads and the final summary. Real model accuracy
must be evaluated on reviewed drawings; these tests do not measure recall.

```powershell
npm test -- --maxWorkers=1
npm run typecheck
npm run lint
npm run build
npm run test:e2e:roi
npm run test:e2e
& ./backend/app/.venv/Scripts/python.exe -m unittest discover -s backend/roi_tests
```
