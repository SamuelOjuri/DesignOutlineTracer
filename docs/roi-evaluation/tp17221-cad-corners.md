# TP17221 CAD corner validation

The supplied `TP17221_25.01_outline.pdf` is a one-page TRICS drawing. Its green
exterior comprises 12 straight segments. At the hip-roof junction, the two long
sides meet at one angular vertex; the source plan's small rounded transition is
not reproduced as a curve or a chain of short polygon edges.

## Implementation

`source-supported-outline-v6` normalizes short corner transitions before line
fitting. It identifies the long adjoining sides, removes small near-collinear
tracing bends immediately beside a short transition, and intersects those sides.
The run may contain many sampled points. Length and distance limits depend on
the existing source-pixel snapping radius, not this drawing's coordinates.

The resulting corner follows the actual side directions. Rotated and oblique
geometry is supported; the algorithm does not force every corner to 90 degrees.
Larger returns, shallow bends away from corner transitions, substantial curves
and intersections outside the accepted ROI are preserved. The existing validity,
component-separation and shared 4% area-change checks remain in force.
Successful normalization adds no corner-review warning. Independent weak or
ambiguous boundary evidence can still produce review warnings.

## Validation

- A fixture extracted from the supplied CAD perimeter reproduces its exact
  12-vertex geometry after adding short rounded transitions with 3, 7, 24 or 48
  samples. The original proposal remains available before normalization.
- Additional regressions cover convex and concave corners, rotated and reversed
  rings, oblique sides, nearby tracing bends, distant bottom-edge recovery, real
  returns, shallow bends, ROI containment and the combined area-change limit.
- All 149 backend tests and 39 reference-tool tests pass.
- Offline replay covers 22 parsed responses across four projects. Comparing the
  previous corner rule with the new rule changes four TP17221 geometries and
  leaves the other 18 geometries unchanged. No new model requests are involved.
- The previously problematic response captured at `2026-11-02T00:50:06.707208+00:00`
  changes from 15 vertices to 12. It no longer reports `local_fitting_limited` or
  `fitting_rejected`. All five usable TP17221 responses have a single angular
  vertex at the junction and reach the supported bottom edge at source y=2618.96.
  One response retains two separate shallow tracing bends farther up the long
  side; no fixed 12-point template is imposed on arbitrary model responses.

The reference PDF has a different page layout and scale from the source plan.
Its coordinates are used only in validation fixtures. The checks establish
corner behavior and source-line fitting, not exact agreement of every generated
roof with the complete CAD drawing or physical design accuracy.

Local diagnostic artifacts are `tmp/cad-corner-verification.json` and
`tmp/pdfs/tp17221-corner-validation.png`. The image compares enlarged crops of
the supplied reference, the previous result and the new result.
