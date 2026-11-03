# Perimeter verification: 251004 and saved outline captures

Validated 2026-11-03 with `source-supported-outline-v8`. No live model calls.

## Failure and correction

Two saved replies for `251004-terrace` put the upper edge near source y=1195.64,
beside unrelated parallel drawing lines and the ROI limit. The finite adjoining
roof strokes instead close at y=1241.84 for the selected inner-parapet policy.
The approximately 46.2 px error exceeded ordinary fitting and the earlier
unsupported-edge recovery radius. A nearest-line or average-support check could
not establish the right closure.

The new pass audits all edges and endpoint connections, then jointly compares
an unverified edge and its two adjoining sides. It uses source directions, so
the same method applies to top, bottom, left, right and diagonal boundaries.
Already verified adjoining lines are retained. A connected alternative must
meet local line-support checks and whole-polygon limits before it can move.
The boundary convention participates in paired-face selection; contrary evidence
also produces a review warning on supported edges that are retained.

This is conservative geometric verification, not proof of the insulation scope.
Some architectural interruptions and conflicting faces remain unresolved. The
original cleaned proposal is retained in `proposed_points`, and corrections
remain proposals until the user selects **Use outline**.

## Offline replay

Replayed 22 parsed, non-truncated captures across the four cases in
`outline-manifest.json`, using the cached pristine raster, PDF vectors and
unchanged model replies. The baseline is a snapshot of the preceding v7 fitter.

| Capture (UTC, 2026-11-02) | v7 top y | v8 top y | v8 top x endpoints |
| --- | ---: | ---: | --- |
| 00:49:26.731715 | 1195.64 | 1241.84 | 1371.12, 1656.00 |
| 00:51:03.533810 | 1195.64065 | 1241.84 | 1371.12, 1656.00 |
| 00:51:35.476689 | 1234.22875 | 1241.84 | 1371.12, 1656.00 |

All coordinates are source pixels at render scale 2. The first two captures
exercise the reported overshoot; the third also benefits from joint closure
verification. The remaining **19 captures retain identical fitted geometry**.
Their review flags can change because verification now checks every edge.
Other questionable sides in the three corrected captures remain flagged;
these results do not establish that the complete perimeter is accurate.

Observed total refinement time was approximately 20-415 ms per saved reply
on the development machine while tests were also running. This is diagnostic
timing, not a performance guarantee. No drawing-specific coordinates are in
the application implementation.

Local replay command and artifacts:

```powershell
venv/Scripts/python.exe tmp/verify_perimeter_alignment.py
```

- `tmp/outline_geometry_v7_snapshot.py`: unchanged pre-v8 geometry baseline.
- `tmp/perimeter-alignment-replay.json`: before/after polygons, evidence, warnings
  and timing for all captures. The replay asserts the three expected corrections,
  exact corrected top coordinates and preservation of original proposals.

## Regression validation

- 180 tests in `backend/roi_tests` and 12 outline benchmark reference tests pass.
- 20 focused frontend tests pass; application and test TypeScript checks pass.
- New cases cover rotated/reversed rings, diagonal sides, genuine returns,
  preserved verified geometry, policy conflicts, missing corners, disconnected
  dimensions, broken lines, raster-only input, narrow edges, bounded search,
  combined corrections with a symmetric-difference budget, ROI containment and
  separate components. API tests check corrected coordinates, original evidence,
  review status and cached responses. UI tests check the review explanations.

No browser-level or fresh live-model accuracy result is claimed by this replay.
