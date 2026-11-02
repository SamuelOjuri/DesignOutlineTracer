# Outline Benchmark: JSON Mode, Shapely Clean-up And OpenCV Experiment

Date: 2026-11-02. Status: **provisional**. All reference outlines are drafts
(`awaiting_review`) until a roof-domain reviewer approves them. The decisions
below may change after that review.

This benchmark measures "Generate outline" against reference polygons. It
answers whether OpenCV and Shapely improve the feature. Live calls are made
only on request, with an explicit cap. Scoring re-runs only the local geometry
on the same captured model replies, so comparisons between variants are
like-for-like and cost nothing.

## Setup

The reference environment
([requirements.in](../../backend/roi_reference/requirements.in)) now also pins
`numpy`, `opencv-python-headless`, `shapely` and `pypdfium2`. The app
environment adds only `shapely` (and `numpy`, which Shapely needs).

```powershell
& ./backend/roi_reference/.venv/Scripts/python.exe -m pip install -r backend/roi_reference/requirements.lock
& ./backend/roi_reference/.venv/Scripts/python.exe -m unittest discover -s backend/roi_reference_tests
```

The harness runs the app's own pipeline: `backend.app` outline prompt, parser
and fitting, and the PDF.js vector extractor through
[extract-pdf-vectors.ts](../../scripts/extract-pdf-vectors.ts) (`vite-node`).
This guarantees it scores what users get. It is the only part of the reference
tooling allowed to import `backend.app`. Pages are rendered with pdfium at the
app's PDF.js scale (2).

## Commands

```powershell
# Billable: one Gemini call per run. --allow-live and a cap are required.
$env:ROI_JSON_MODE = "true"
& ./backend/roi_reference/.venv/Scripts/python.exe -m backend.roi_reference outline-capture --case tp17221-roof --runs 3 --allow-live --max-calls 3 --env-file backend/app/.env

# Offline: re-parse every capture with the current parser and score the variants.
& ./backend/roi_reference/.venv/Scripts/python.exe -m backend.roi_reference outline-score --markdown

# Offline: review sheets (overview plus zoomed corners) for each reference.
& ./backend/roi_reference/.venv/Scripts/python.exe -m backend.roi_reference outline-review
```

Captures, page renders, vector caches, reports and review sheets are written to
the git-ignored `docs/roi-evaluation/private/outline/`. Each capture stores the
raw reply text and is parsed again at scoring time, so parser changes are
measured on existing replies.

## References

[outline-manifest.json](outline-manifest.json) holds four cases from three
drawings, all using the `inner_parapet` convention:

| Case | Drawing | How the draft was made |
|---|---|---|
| `251004-terrace` | `251004 WD03 C7.pdf` | Approximate scope snapped to drawn lines; the ASHP-zone top edge was set by hand (see notes in the manifest) |
| `tp17221-roof` | TP17221 | Coloured scope mask snapped to drawn lines |
| `tp17202-north`, `tp17202-south` | TP17202 | Inner parapet faces, with widths taken from the drawing's dimensions |

Snapping rule: each edge moves to the drawn line nearest the roof interior,
within 16 px. Edges with no drawn line use the strongest raster edge, and the
manifest records which. Every decision is listed in the per-case `edges`
report. TP17256 is not in this first draft set; its scope needs a reviewer's
decision before a reference can be drawn.

**Bias caveat:** the references follow the "innermost drawn face" rule. The
OpenCV variant uses a similar idea, so part of its gain may come from this
shared assumption rather than better accuracy. A reviewer should confirm the
references before its result is relied on.

## Metrics

- **IoU (failures = 0)**: area overlap with the reference, counting a failed or
  unusable reply as 0. **IoU (successes)** averages usable outlines only.
- **Boundary F1 @2px / @5px**: share of the outline lying within 2 or 5 px of
  the reference boundary, and vice versa (page pixels at scale 2; 1 px ≈ 0.18 mm
  on the page). This is the best measure of the edge placement that fitting
  controls.
- **Hausdorff / mean distance**: worst and average boundary distance, in pixels.
- **ms**: geometry time per outline in the harness, excluding the model call.

## Results (26 captures, 2026-11-02)

13 free-form and 13 JSON-mode replies from `gemini-4-argon`:

| Variant | Failures | IoU (failures = 0) | IoU (successes) | F1 @2px | F1 @5px | Mean distance px |
|---|---|---|---|---|---|---|
| Model only (no fitting) | 4 | 0.814 | 0.963 | 0.334 | 0.535 | 5.24 |
| Production fitting (before) | 6 | 0.745 | 0.969 | 0.465 | 0.604 | 4.07 |
| Production + Shapely (**now live**) | 4 | 0.818 | 0.967 | 0.470 | 0.626 | 4.72 |
| OpenCV side-aware (experiment) | 4 | 0.819 | 0.968 | 0.567 | 0.637 | 4.55 |

Boundary F1 @2px per case:

| Case | Production + Shapely | OpenCV side-aware |
|---|---|---|
| 251004-terrace | 0.263 | 0.444 |
| tp17221-roof | 0.453 | 0.510 |
| tp17202-north | 0.719 | 0.718 |
| tp17202-south | 0.871 | 0.871 |

The four remaining failures are all free-form replies with leaked reasoning text
and no JSON object, which cannot be recovered.

Shapely's mean distance and Hausdorff are slightly higher than production's.
This is because it adds two recovered outlines that production rejected; on
the 20 outlines both handled, the results are identical.

## Findings And Decisions

### 1. JSON mode: adopted (`ROI_JSON_MODE=true`)

- Parse rate: free-form 9/13, JSON mode 13/13. The free-form failures were
  leaked reasoning text.
- JSON-mode replies sometimes begin with `💭` and a newline, then a few
  non-ASCII tokens. The parser's leading-noise rule now accepts up to three
  such groups (each at most eight characters) separated by short whitespace,
  directly before the JSON. Prose is still rejected.
- Only `response_mime_type="application/json"` is sent; `gemini-4-argon` still
  returns HTTP 400 when a response schema is supplied
  (`ROI_STRUCTURED_OUTPUT` stays `false`).
- Sanity checks in JSON mode: ROI 2/2 and outlets 2/2 parsed on the first
  attempt.

### 2. Convert the page once: adopted (no setting)

Outline preparation used to decode and convert the whole page image twice. It
now decodes once and keeps only the region around the ROI, plus a 24 px margin.
The margin is larger than the snapping radius plus sampling distance, so
results stay identical. Checked on 48 refinements × 3 raster sources: 0
mismatches.

| Step | Before | After |
|---|---|---|
| `prepare_outline_crop` | 314 ms | 176 ms |
| Fitting (`refine_outline_polygons`) | 244 ms | 16 ms |

The Gemini call itself (about 11–14 s) remains the main cost.

### 3. Shapely clean-up: adopted (`ROI_OUTLINE_CLEANUP=shapely`)

Before fitting, each model ring is:

- **Repaired** if self-intersecting (`make_valid`). Parts under 1% of the area
  and holes are dropped. Warning: `outline_repaired`.
- **Clipped** to the ROI when it overshoots by at most the snapping radius
  (larger overshoot still returns `roi_too_tight`). Warning: `clipped_to_roi`.
- **Cleaned** of spikes and slots narrower than the snapping radius (mitre
  opening/closing by half the radius on each side). Warning:
  `thin_features_removed`.

The model's winding direction is kept. Results:

- It recovered two outlines that production had rejected: one overshot the ROI
  by 2.3 px on 251004, and one had a collinear back-track on TP17221.
- It was identical on the other 20.
- It adds about 10–15 ms per outline.

Set `ROI_OUTLINE_CLEANUP=none` to turn it off.

### 4. OpenCV "which side is the roof": not ported yet (reference tooling only)

[outline_side_aware.py](../../backend/roi_reference/outline_side_aware.py)
addresses the cases where production keeps the model's edge and warns
`ambiguous_parallel_edges` (two equally good parallel lines). It measures
ink density on each side of each candidate line, ignoring text glyphs under
25 px. It then picks the face with open roof on the inside and wall or
hatching on the outside. The same acceptance checks as production apply, and
it adds the `side_aware_reselection` warning.

- Boundary F1 @2px improves from 0.470 to 0.567 overall. The gains are on the
  two drawings with parallel parapet lines; TP17202 is unchanged.
- It costs about 200 ms more per outline.
- It is **not** in the live service. Port it only after the references are
  reviewed (see the bias caveat). If ported, it needs `opencv-python-headless`
  in the app lock, or a numpy-only ink-density version.

## Limits

- Four cases from three drawings, with 4–12 replies per case. This is enough
  to rank variants on the same replies, but not to claim accuracy in general.
- No held-out drawings yet. TP17256 and other drawings with unclear scope need
  reviewed references.
- Reply variance between runs is large on 251004; compare variants only on the
  same captures.

## Reviewing The References

Run `outline-review` and check each sheet: the red line should follow the
inner face of the roof boundary at every zoomed corner. To approve a case, set
its `status` to `reviewed` and fill in `review` (`reviewer`, `reviewed_on`).
Validation rejects either change without the other. Then re-run
`outline-score`; the report drops "Provisional" once every case is reviewed.
