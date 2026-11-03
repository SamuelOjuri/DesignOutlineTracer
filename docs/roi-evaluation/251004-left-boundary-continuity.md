# Whole-side boundary continuity (v7)

The supplied `251004 WD03 C7.pdf` matches the existing development fixture's
SHA256 `f0685959462376e7766adf9aad40845688e586be44338bab4818ae294a5afef7`.
Its continuous left-side vector is x=385.92, y=1719.44..2448.08 at render scale 2.
Nearby terrace vectors at x=395.76 and x=401.28 terminate at the green-roof
junction. These source-pixel coordinates are evaluation data, never runtime rules.

The screenshot's exact model reply was not captured. A deliberately constructed
8-vertex proposal follows x=395.76 above y=2154.8 and x=385.92 below it. Replaying
that proposal on the actual PDF raster and the app's own 2,000 ROI vectors
demonstrates the limitation and repair without a new provider request.

| Result | v6 | v7 |
| --- | --- | --- |
| Left-side step | 9.84 px | Removed |
| Exterior vertices | 8 | 6 |
| Left supporting line | Two different lines | x=385.92 throughout |
| Original proposal | Preserved | Preserved |
| Review | Continuity ambiguous | Automatic straightening reported; other ambiguities remain |

The corner was another limiting condition: the adjoining source line starts at
x=388.8 and is interrupted further along by architectural details. Checking local
corner strokes, with a bounded 2.88 px endpoint gap in this case, establishes the
connection without requiring 70% coverage of the entire adjoining side. The
common perimeter line itself must remain continuously supported. Anchors do not
move one endpoint of an adjoining side independently and introduce a new slope.

The fitter now groups a complete side before selecting a common line. It checks
each run, every gap in the common line, both corners and junction connectivity.
A connected turn with terminating flanks remains a genuine step. A detail that
continues into the roof can be an internal T junction instead. Multiple nearby
faces still need the boundary policy and consistent raster side evidence; a
majority of contradictory windows on any run prevents automatic selection.

Regression coverage includes multiple switches, additional samples, cyclic ring
starts, reversed winding, rotated internal junctions, interrupted corner strokes,
genuine returns, source gaps away from junctions, disconnected details, conflicting
surface evidence and keeping adjoining edges straight. Existing ROI, component,
area-change, raster-only and ambiguous-face tests continue to apply.

`tmp/verify_outline_side_fit.py` compares the implementation with v6 at commit
`db6387ff74621c80baa75618d8b6277daa017401`. All 22 parsed saved captures across
four cases are identical, including their warnings and evidence. Those captures
do not contain this left-side defect. The constructed case changes as above.
The script writes `tmp/outline-side-fit-verification.json` and makes no model calls.

This is a source-supported regression, not a measurement of live model accuracy.
The existing insulation reference remains provisional and awaits domain review.
The API shape and review workflow are unchanged; version v7 invalidates old
outline cache entries. No new OpenCV dependency is required: PDF vectors provide
the decisive evidence and the existing raster fitter remains the fallback.
