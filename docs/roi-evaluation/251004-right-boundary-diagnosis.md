# 251004 right-boundary diagnosis

Investigated and implemented 2026-11-02. The diagnosis below describes the v2
pipeline; implementation and verification results for v3 are recorded at the end.

## Finding

The small step on the right side is a boundary-selection error already present
in a captured model reply. It is a valid, non-self-intersecting polygon, so
ordinary polygon repair cannot identify the error. The model follows the inner
terrace/balustrade line above the terrace/green-roof junction, then switches to
the roof-edge line below it. The roof-edge line itself is continuous.

The supplied Downloads PDF and `docs/251004 WD03 C7.pdf` have identical SHA256:
`f0685959462376e7766adf9aad40845688e586be44338bab4818ae294a5afef7`.
The screenshot's exact live session was not inspected. An existing captured
reply for this same PDF reproduces the same defect at the same junction.

## Reproduction

Replayed the nine parseable replies among the twelve saved `251004-terrace`
captures through the current production geometry pipeline, with Shapely enabled.
No new model calls were made. One reply contains the extra right-side step:

`docs/roi-evaluation/private/outline/captures/251004-terrace/20261102T005114141595.json`

Coordinates below are source-page pixels at render scale 2, not screen pixels
or construction dimensions:

| Feature | x | y span |
| --- | ---: | --- |
| Model upper right edge | 1637.365 | 1239.563-2141.125 |
| Model lower right edge | 1660.191 | 2141.125-2439.165 |
| PDF inner terrace line | 1640.400 | 1251.920-2149.040 |
| PDF second terrace line | 1646.160 | 1246.160-2154.800 |
| PDF continuous inner roof-edge line | 1656.000 | 1241.840-2448.080 |
| PDF continuous outer roof-edge line | 1661.760 | 1236.080-2453.600 |

The model's step is 22.826 px wide. Its upper run is 18.635 px away from the
continuous inner roof edge. The connector has zero raster support in the
production result; the upper run is marked ambiguous and unsupported.

The existing reference uses x=1656 for the full right boundary. That reference
is still `awaiting_review`: its exact insulation convention remains provisional.
Both of the continuous roof-edge faces nevertheless contradict the model's
switch between the terrace and roof perimeters.

## Why the v2 pipeline preserved it

- `backend/app/outline_geometry.py::_max_shift` caps the local search at 12 px.
  The continuous roof edge is outside the upper run's search window.
- `_fit_ring` scores each edge separately. It retains the original edge when
  parallel alternatives are ambiguous. It does not compare the continuity of
  the whole side or change the number of edges to repair a false step.
- `_collapse_corner_steps` explicitly preserves offsets along a straight side.
  It relies on intersecting the flanking lines; these two flanking runs are
  parallel, so they have no corner intersection.
- `outline_cleanup.clean_ring` repairs topology and thin spikes/slots. A shallow
  step between two long side runs is neither an invalid ring nor a thin spike.
- `src/utils/roofRender.ts::drawRoofIllustration` draws the supplied vertices.
  The Project Details canvas does not introduce the step. The same shape also
  exists before frontend rendering in the offline replay.

The service returns `needs_review`, `ambiguous_parallel_edges` and
`unsupported_boundary_segments`. After accepting a proposal, the stored
`PagePolygon` does not retain its per-edge evidence; the final illustration
therefore renders these edges like the rest of the perimeter.

## Offline comparisons

| Experiment on the same captured reply | Result |
| --- | --- |
| v2 production + Shapely | Retains the 8-vertex outline and the 22.826 px step |
| Existing OpenCV side-aware experiment | Moves the lower run to x=1656 but retains the upper run and an 18.635 px step |
| Production with snapping radius doubled to 24 px | Retains the step and moves its connector onto another horizontal line |
| Hand-selected candidate: join both runs onto x=1656 | Valid 6-vertex outline; L-shaped scope retained; area changes by +1.47% |

The hand-selected candidate is a diagnostic demonstration, not an implemented
general repair algorithm. Against the draft reference, its boundary F1 at 2 px
changes from 0.553 to 0.795, and maximum boundary error from 18.64 to 5.87 px.
Other boundary errors remain; these figures do not establish general accuracy.

Local replay script: `tmp/diagnose_right_boundary.py`.
Detailed results: `tmp/right-boundary-comparison.json`.
Source overlay: `tmp/pdfs/251004-right-boundary-diagnosis.png`.

## Repair design

Add a source-supported boundary-continuity pass before ordinary edge fitting:

1. Detect two long, almost parallel, same-direction runs separated by a short
   transverse connector. Treat this as a possible switch of boundary faces,
   not automatically as an error.
2. Search for a common drawn line spanning both runs, including evidence on
   both sides of the junction. Expand this search locally based on the observed
   separation; keep the normal 12 px search for other edges. A long dimension
   line alone must not qualify: check adjoining roof corners and the selected
   boundary convention as well.
3. Pass `boundary_policy` into refinement. It currently reaches the model
   prompt, but refinement receives neither the policy nor semantic guidance.
   Rank continuous candidates using the policy and inside/outside evidence;
   do not assume that the innermost visible line is always the insulation edge.
4. Merge the runs and remove the two redundant vertices only when the common
   line is supported and the connector lacks credible evidence of a real step.
   Recheck validity, winding, ROI containment, area/displacement limits and
   separation from other components. Recompute evidence for the resulting edges.
5. If the face remains ambiguous, retain the geometry and highlight this
   specific junction for review, ideally with a proposed straightening action.
   Report any automatic change and retain the original proposal for comparison.

Add this captured case as a regression, alongside genuine shallow steps with
drawn connectors, rotated boundaries, raster-only ambiguity, disconnected
components and all three boundary policies. Replay the complete existing
capture corpus before changing defaults, and bump the algorithm/cache version.

Prompt guidance should also explicitly distinguish internal terrace, paving,
balustrade and vegetation transitions from the roof perimeter. That can reduce
the error rate, but does not replace the continuity check.

For this specific drawing, the practical correction is to align the upper and
lower right segments to the same continuous roof-edge face, then remove the
two vertices at the false junction. Keep that selected face consistent with
the rest of the insulation perimeter.

## Implemented in source-supported-outline-v3

The production fitter now performs the continuity check before ordinary edge
fitting. It uses the selected boundary policy, accepts only vector-supported
lines joined to both adjoining corners, and verifies support separately on each
run and across the junction. A drawn connector protects a genuine step. Nearby
inner/outer faces require geometric and raster-side agreement; `roof_deck`,
more than two plausible faces and raster-only proposals stay uncertain. The
local search can extend to the observed step width plus the normal snap radius,
capped at 36 px. Ordinary fitting remains capped at 12 px.

Accepted repairs keep their chosen line during fitting and retain the original
proposal. Topology, winding, ROI, component separation, total area change (4%)
and displacement are checked. Failed continuity checks retain the step and mark
its two runs and connector as ambiguous. The review panel explains
`boundary_steps_straightened` and `boundary_continuity_ambiguous`. Prompt guidance
also distinguishes internal surface transitions from the roof perimeter. No new
dependencies or document-specific coordinates were added to production code.

The saved failing capture now produces six vertices with one continuous right
edge at x=1656. Replaying all 26 saved captures against the committed v2 fitter
changes only that outline: the other 21 usable replies are identical and the
four existing parse failures remain failures. Overall boundary F1 at 2 px
changes from 0.4704 to 0.4797; these remain provisional draft-reference metrics.
The prompt change was not evaluated with new live calls.

Verification includes geometry regressions using the captured coordinates,
inner/outer/deck policies through the API and its cache, genuine vector/raster
steps, fragmented lines, unsupported gaps, unconnected lines, reversed winding,
rotations, ROI limits and component conflicts. The complete backend and
reference suites, focused frontend tests, TypeScript checks and test lint pass.

Restart a backend without auto-reload and generate a new proposal to use v3.
Existing accepted outlines are not rewritten; select the old outline for
replacement when applying the corrected proposal.
