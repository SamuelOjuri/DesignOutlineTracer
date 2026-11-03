# TP17202 generated insulation outline assessment

Assessed 2026-11-03. Read-only investigation of the current Chrome result, the supplied input and validation PDFs, and the current `source-supported-outline-v8` pipeline. No production changes or new model calls.

## Finding

Roof area 2 is located correctly, but its perimeter does not match the supplied validation polygon. The live accepted SVG has eight vertices. The validation PDF has a four-sided rectangle, dimensioned 1569 x 3136 mm. Extra returns occur at both the top-right and bottom-right; the upper return is partly concealed by the ROI label. The right side follows details of the adjacent construction rather than the continuous side in the validation layout. The left and most of the top edge align closely; the bottom is also slightly displaced.

Roof area 1 remains an accepted ROI without an outline. The Generate outline action operates on one selected ROI, so this is a separate coverage/UI issue, not evidence that one call failed to produce both roofs. The selected dropdown item currently uses the generic label `roof_roi`, which is less clear than the numbered canvas labels.

[Comparison figure](../../tmp/pdfs/tp17202-assessment/comparison.png)

The validation PDF is a separate 1:50 drawing, not an overlay in input-page coordinates. Its four finite perimeter strokes were inspected directly. The orange overlay uses the existing dimension-registered draft in `outline-manifest.json`, whose 1569 x 3136 mm dimensions agree with the supplied PDF. Consequently pixel metrics below are approximate registration measurements, not independently certified physical dimensions.

| Measure | Current lower-roof result |
|---|---:|
| Vertices | 8, reference 4 |
| IoU against registered reference | 0.9702 |
| Area shortfall against registered reference | 2.98% |
| Boundary F1 within 2 source pixels | 0.9088 |
| Maximum boundary distance | 6.55 source pixels |

High area overlap does not imply the perimeter is correct. The new vertices and short returns are the principal failure.

## Evidence and cause

1. The exact displayed points and ROI were read from the live page's DOM using Chrome's Elements inspector. The source page is 2382 x 1684 pixels. The lower ROI is `[530,228,654,279]`. It contains the registered validation polygon with room to spare, so ROI clipping is not the cause of these returns.
2. The top-right detail contains segments of 6.24 and 9.95 pixels. The lower rightward-to-leftward transition is 5.34 pixels, followed by a 32.54 pixel run. These are actual vertices, not antialiasing or a green ROI border.
3. Four saved TP17202-south model replies were replayed offline through current production fitting using the live ROI. All four raw replies already contain eight vertices with the same two returns, and all four final outputs retain them. The closest replay is within 0.72 source pixels of the current result. This supports a recurring scope-interpretation error that the fitter preserves. The raw reply from this particular live request was not recovered, so its exact stage-by-stage history is not asserted.
4. `_max_shift` in `backend/app/outline_geometry.py` computes `min(12, max(2, ROI_diagonal * .008))`. Here it is 2 pixels. Shapely cleanup uses half of this for opening/closing. Applying that cleanup to the exact live ring leaves it unchanged. The corner-collapse tolerance is twice the snapping radius (4 pixels); these transitions exceed it. Side-chain repair also limits transverse transitions to twice the radius; the live shape produces no eligible chains.
5. The top notch and long abutment side have full finite-vector support. They are real lines in the input drawing. Strong line support therefore cannot establish that they represent the desired insulation boundary. Some bottom edges also have raster support despite weak finite-vector connectivity. Two historical replays retain the wrong topology with no warnings. This is primarily a semantic boundary choice, not simply an edge-detection failure.
6. The ordinary fitter adjusts existing sides; perimeter verification also preserves side count/order. It cannot generally change an eight-sided semantic interpretation into a four-sided rectangle. The continuity repairs can alter topology only when their stricter evidence and size checks succeed.

The current geometric safeguards protect real returns, narrow roof portions and neighbouring components. Their conservatism is useful; broadening their thresholds to make this one example rectangular would be an unsafe general remedy.

## General fix to evaluate

Add an evidence-gated comparison of alternate boundary interpretations before final source fitting. Keep the current proposal as the fallback.

- Generate a continuous-side alternative only when a short excursion appears to trace adjacent wall/column/abutment detail. Work in the roof's local orientation, not screen-horizontal/vertical axes. Do not assume all small roofs are rectangles.
- Require corroboration: correctly associated printed dimension endpoints, long-side alignment on either side of the obstruction, consistent boundary-face selection, and evidence that the interruption belongs to adjacent construction. Dimensions may be read as evidence; measurements must not be invented. The existing prompt's prohibition on inferring measurements should be clarified accordingly.
- Compare the original and continuous-side candidates. A line through an occluding detail needs dimension/semantic justification, not a fabricated claim of visible line support. Keep genuine connected changes of the roof boundary. If evidence conflicts or dimensions are missing/ambiguous, retain the original and mark the affected side for review.
- Preserve validity, winding, ROI containment, component separation and bounded total displacement/area-change checks. Apply a separate, explicitly reviewed allowance to this semantic correction; do not globally increase ordinary snapping or Shapely smoothing.
- Preserve the raw response, mapped pre-cleanup ring, cleaned ring, final points, edge evidence and decision reasons for each run. The current `proposed_points` is built from rings after cleanup/simplification, so it is not a complete raw-stage audit.
- Retain generation warnings and edge evidence after Use outline. `PagePolygon` currently stores points and identifiers, and `AcceptedOutlineOverlay` renders every accepted side in solid blue. Acceptance is a user action, not proof that an uncertain edge became correct.

The validation PDF must remain test evidence. Its filename, coordinates and known rectangle must not become special cases in the runtime detector.

## Regression evaluation

First save this exact eight-vertex output and the four existing raw replies as explicit shape-failure cases. Require both erroneous returns to disappear under the validation convention; do not accept high IoU alone.

Evaluate candidates on the same stored replies from TP17202 north/south, TP17221's genuine stepped perimeter and 251004's parallel-face/terrace cases. Compare per-case boundary distance/F1, vertex/turn structure, component count, failure rate, area error and time. Check individual replies as well as aggregate averages.

Add paired counterexamples where a visually similar small return really is part of the roof. Cover rotation, reversed winding, rescaling, raster-only pages, missing/conflicting dimensions, nearby dimension lines, clipped ROIs, concave/diagonal boundaries and narrow returns. Existing corner, continuity and perimeter-verification tests already cover several of these geometric protections, but they do not fully resolve this semantic ambiguity.

Baseline verification: `venv/Scripts/python.exe -m pytest backend/roi_tests/test_outline_corners.py backend/roi_tests/test_outline_continuity.py backend/roi_tests/test_outline_verification.py -q` passed all 45 tests in 43.21 seconds. This verifies the current safeguards, not a proposed fix; no production fix was implemented in this assessment.

Finally evaluate on held-out drawings with reviewed references. The current four-case manifest remains draft and has no held-out cases; it cannot establish generalization or guarantee zero regressions. Enable the new correction only after these checks, with the conservative fallback available.

## Reproduction

`venv/Scripts/python.exe tmp/assess_tp17202_outline.py replay`

This diagnostic reads local PDFs/captures, runs geometry offline, and writes only local assessment artifacts. It does not change the live drawing or call a model.

- [Detailed geometry evidence](../../tmp/pdfs/tp17202-assessment/geometry-assessment.json)
- [Validation PDF render](../../tmp/pdfs/tp17202-assessment/outline.png)
- [Input PDF render](../../tmp/pdfs/tp17202-assessment/input.png)

Source PDFs: `TP17202_25.01_input.pdf` and `TP17202_25.01_outline.pdf` in the user-supplied `Roof Plan Docs/Example 1 - TP17202` directory. Drawing notes were treated as document content, not task instructions.
