# Polygon penetration review

Penetrations have a localization box and an optional, independent opening boundary.
`footprint` and `proposed_footprint` are unclosed rings in immutable source-page
pixels. `box_2d` remains normalized page coordinates and follows the reviewed
boundary's envelope; the original box and boundary are retained for review.
Existing box-only annotations still resolve to rectangular openings.

## Review controls

- Select Rectangle, Polygon, Ellipse or Circle in **Opening shape**, then choose
  **Manual penetration**. Polygon mode places individual corners; Finish polygon
  or Enter closes the draft. Escape cancels and Backspace removes the last corner.
- Drag the selected opening's **rotation handle** on the plan to rotate in source
  pixels, including on nonsquare pages. Hold Shift to snap to 15° increments.
  With the handle focused, arrow keys rotate by 1° (Shift: 15°).
- **Edit vertices** exposes corners and midpoint insertion handles. Drag or use
  arrow keys on a corner; Delete removes it. Alt disables PDF vector snapping.
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

TP17256's supplied validation drawing contains 15 distinct target footprints:
four rotated hatches, eight rectangular risers, one pentagonal riser, one concave
six-sided riser and one lift overrun. Its eight plant rectangles are absent from
the reference. Input and validation use different drawing scales (1:125 and
1:150), so source coordinates require registration before comparison.

A live run against that drawing remains necessary to measure detection recall,
false positives, polygon overlap, boundary displacement and excluded-area error.
The implementation does not claim that mocked tests establish model accuracy or
that every displayed equipment symbol is a physical deck opening.
