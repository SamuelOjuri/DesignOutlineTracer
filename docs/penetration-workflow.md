# Polygon penetration review

Penetrations have a localization box and an optional, independent opening boundary.
`footprint` and `proposed_footprint` are unclosed rings in immutable source-page
pixels. `box_2d` remains normalized page coordinates and follows the reviewed
boundary's envelope; the original box and boundary are retained for review.
Existing box-only annotations still resolve to rectangular openings.

## Review controls

- **Add opening**, **Reject** and **Delete penetration** stay pinned above
  **Previous / Next** while the sidebar details and list scroll independently.
  The action bar identifies the selected penetration and shows how many remain
  to review. Ordinary **Add opening** preserves the selection and drawing view.
- **Add opening & next** accepts the selected opening and selects, centres and
  zooms to the next unreviewed penetration in list order, wrapping at the end.
  Already added and rejected items are skipped; accepted openings that need
  confirmation remain in the queue. These use **Confirm opening & next**.
  The final acceptance stays on the same item and shows **All penetrations
  reviewed**. Undo remains available in the drawing toolbar. Both acceptance
  actions use the same boundary, type and parent-roof validation.
- Select Rectangle, Polygon, Ellipse or Circle in **Opening shape**, then choose
  **Manual penetration**. Polygon mode places individual corners; Finish polygon
  or Enter closes the draft. Escape cancels and Backspace removes the last corner.
- Drag the selected opening's **rotation handle** on the plan to rotate in source
  pixels, including on nonsquare pages. Hold Shift to snap to 15° increments.
  With the handle focused, arrow keys rotate by 1° (Shift: 15°).
- **Edit vertices** exposes square corners and round midpoint insertion handles.
  **Zoom to Penetration** also activates vertex editing and exits pan mode so
  the selected opening's corners are ready to edit. Use **Edit vertices** to turn
  it off again; zooming changes no geometry or review decisions.
  Click a square corner or focus it with Tab to select it: the active corner has
  a thin red outline with a transparent centre, keeping the PDF corner visible
  for both mouse and keyboard input. Drag or use arrow keys to move it; Delete or
  Backspace removes it. Clicking another control
  clears the corner highlight. Corner handles take priority over overlapping
  midpoint handles. Alt disables PDF vector snapping.
- Classify uncertain candidates and select their roof area before **Add opening**.
  An `unknown` object cannot create an exclusion until classified.
- The opening preview shows subtraction restricted to actual insulation scope and
  existing cutouts. Crossing boundaries triggers a clipping notice. Undo restores
  geometry and its review decision together.
- Leaving **Review Penetrations** warns when previously accepted openings need
  confirmation again. **Review openings** selects the first affected penetration;
  **Continue without these openings** explicitly proceeds with those openings
  excluded from the final drawing and export. Confirming an opening restores it.

Simple polygons may be concave and have up to 128 vertices. Self-intersections,
self-touching boundaries, collapsed rings and coordinates outside the source page
are rejected. Circles and ellipses use polygon approximations for clipping/export.

## Detection and fitting

Penetration prompt v2 recognizes rooflights, vents, flues, access hatches, risers,
lift overruns, other upstands and uncertain candidates. PV, walkways and plant
without an established upstand remain excluded from automatic proposals.
Object detection and acceptance of an insulation exclusion remain separate steps.

The client sends accepted roof outlines, their manual exclusions and bounded PDF
stroke evidence. The backend scans overlapping source-resolution detail crops
with a page overview. It maps proposals back to source pixels and fits supported
nearby closed vector paths or raster edges without imposing horizontal/vertical
axes or converting concave boundaries into convex hulls. Unsupported boundaries
remain visibly marked for review. A missing polygon retains a provisional box.

Each scan is limited to eight 2048-pixel detail crops and 25 unique annotations.
Provider calls and retries use the existing session budgets and timeouts; reaching
a crop, call, time or annotation limit produces a partial result. **Find missed
penetrations** offers one additional pass, including after a completed or empty
scan. Completed coverage is not a guarantee that every object was detected.
Scope/vector hashes, prompt and algorithm versions participate in cache identity.

Independent detail crops run in waves of four by default. Initial calls are
reserved in crop order and committed together before dispatch. A shared provider
semaphore limits simultaneous model requests across all detection operations.
Replies are reconciled in crop order, so timing cannot choose which duplicate or
annotation-limit result wins. A failed crop leaves successful crops available as
a partial result; retries consume the same durable session and global budgets.
Queued waves stop once 25 unique annotations are reached. Calls already sent in
the current wave still consume budget, including when an earlier crop fills the
annotation limit. Each call has its own 120-second timeout within the scan's
overall deadline. `ROI_PENETRATION_CROP_CONCURRENCY`, `ROI_MAX_PROVIDER_CALLS` and
`ROI_PENETRATION_CALL_TIMEOUT_SECONDS` control these limits independently.

The source PNG is decoded once per scan and retained as one RGB page while crops
are prepared sequentially. Only the current wave's crop rasters are retained.
Vector bounds are indexed once, preserving the exact stroke selection and order
used by footprint fitting. Each crop's proposals share one geometry worker and
scope polygon. Resolution, overlap, model settings and fitting thresholds remain
unchanged.

`run.settings` records planned/completed crops, failed crop indices/codes and
`timings_ms` for source decoding, vector indexing, crop preparation, durable
reservation/flush, provider-slot waiting, model calls, geometry and scan elapsed
time. Per-crop records include attempts and timing diagnostics. Model, queue and
geometry totals add time across concurrent crops and can exceed elapsed wall
time. Cached results retain the original scan diagnostics; `run.cached` and
`run.duration_ms` describe the replay itself. Pixels and annotation contents are
not logged.

The client reuses an uploaded-page receipt only for the same immutable source
blob and complete page identity, within the server's remaining lifetime. Deleting
a page or receiving `page_not_found` invalidates that receipt. An ordinary scan
can recover once by uploading again and starting a fresh request ID; follow-ups
require their original upload and report expiry instead. Completion feedback
shows elapsed detection time or that previous recommendations were reused.

## Geometry and exports

The reviewed ring drives association checks, preview, acceptance, area subtraction,
outlet exclusions and exported polygons. Clipping records explicit roof ownership
and retains one penetration identity across separate pieces. Export totals count
objects, while each piece remains a separate polygon. Boolean subtraction avoids
double deduction for overlapping cuts. GeoJSON represents the resulting insulated
Polygon or MultiPolygon, including concavity and perimeter-touching cuts.

## Verification and remaining drawing validation

Automated regressions cover rotated hatches, irregular/concave footprints,
circles, invalid drafts, translation, rotation, vertex edits, original proposals,
Undo, scope clipping, split identities, export areas and bounded mocked scans.
They make no live model calls.

Performance regressions additionally verify concurrent crop calls, crop-order
deduplication, shared provider capacity, durable batched reservations across
restart, budgeted retries, partial failures, deadlines and worker cleanup under
repeated cancellation. Crop equivalence checks compare PNG bytes and grayscale
fitting pixels, including transparent PNGs, and preserve indexed vector order.

A local offline probe of TP17256 at render scale 2 (six full-page example crops,
not the user's accepted outline) measured median preparation of 1.854 seconds
before reuse and 1.412 seconds including the reusable decode. Building the vector
index and fitting 25 synthetic proposals against 30,000 segments took 0.049
seconds versus 0.176 seconds with linear filtering. A six-crop run with fixed
0.2-second empty model replies took 2.585 seconds with one worker and 1.680 with
four, with the same six calls and completed coverage. These figures isolate local
work and scheduling; they do not measure live model latency or detection accuracy.

TP17256's supplied validation drawing contains 15 distinct target footprints:
four rotated hatches, eight rectangular risers, one pentagonal riser, one concave
six-sided riser and one lift overrun. Its eight plant rectangles are absent from
the reference. Input and validation use different drawing scales (1:125 and
1:150), so source coordinates require registration before comparison.

A live run against that drawing remains necessary to measure detection recall,
false positives, polygon overlap, boundary displacement and excluded-area error.
The implementation does not claim that mocked tests establish model accuracy or
that every displayed equipment symbol is a physical deck opening.
