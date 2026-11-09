# Automatic insulation-scope outlines

The assisted New Build workflow now offers **Generate outline** in Step 3,
**Set Outlines**, after a roof ROI has been accepted. It proposes exterior roof
polygons, fits them conservatively to source linework, and keeps the result
separate from the editable drawing until **Use outline** is selected.

## Using the feature

1. Upload the PDF and select its drawing scale. Accept or manually draw the
   required roof regions in Step 2.
2. In Step 3, choose the roof region under **Select roof area to outline** and
   the boundary convention. The default is
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
   them through the manual fill tool's gap-closing/contour cleanup.
5. **Undo generated outline** restores the preceding drawing in one action,
   while that application remains the latest page edit, and reselects the roof
   area whose outline was removed. Further manual edits use the existing canvas
   Undo. Existing adjustment tools remain available.
6. Review rooflights and other openings separately in Step 4. Changing or undoing
   the base scope invalidates dependent opening decisions; it does not silently
   restore stale accepted openings.

In **Adjust**, drag a vertex near a PDF endpoint or intersection to snap it exactly
to that point. The snap radius stays at 10 screen pixels as you zoom; nearby PDF
lines provide a fallback target. Teal linework, a marker and a **PDF endpoint**,
**PDF intersection** or **PDF line** label identify the active snap. Release applies
the move as one Undo action. Hold Alt for free movement without PDF snapping or
vertex merging. Shift retains 90-degree corner alignment and takes priority over
PDF snapping; otherwise an adjacent outline vertex merge takes priority. Pages
without extracted PDF vectors retain manual dragging. Geometry checks still block
crossings, touching roofs and page overshoot.

Hover an edge in **Adjust** to reveal **+ / Add vertex on this edge** at its
midpoint. Click to insert a vertex on the unchanged edge, then drag the new red
ring to place the missing corner; dragging directly from **+** also works.
Insertion and the first placement form one Undo action. The new vertex ignores
adjacent-vertex merging during placement while retaining PDF snapping and Alt
free movement. Shift still applies the existing horizontal/vertical corner rule.
Only edges at least 40 screen pixels long show the handle, and the midpoint must
be at least 18 screen pixels from every existing vertex. Zooming reveals shorter
edges without changing their geometry. Existing vertices always take priority.
Crossings, page overshoot, touching roofs and changes to cutout/opening coverage
are blocked. Esc cancels the current drag; a point already inserted by clicking
stays available for placement or Undo. Changing editing tools finishes the group.

A collinear split maps drainage on the original side to both new segments;
moving the point away from that side clears its drainage markings while keeping
unaffected sides mapped. Scope comparisons and outlet fingerprints ignore only
redundant forward collinear samples within a tiny source-pixel arithmetic
tolerance. Stored vertices, component identities and ownership remain intact.
Adding or undoing a handle on an unchanged edge preserves geometry revisions,
accepted penetration/outlet decisions and pending detection requests. Real bends,
narrow returns and changed ownership retain the existing invalidation behavior.

### Several roof areas on one page

Every accepted roof area is listed in **Select roof area to outline**, so they can
be outlined one after another without returning to Step 2:

- Step 3 opens on the area chosen in Step 2 while it still needs an outline;
  otherwise it opens on the next area that does.
- After **Use outline**, the next area without an outline (in roof-area order,
  wrapping round) is selected automatically. The boundary convention and
  guidance carry over; change them before generating if that area differs.
- Outlined areas are marked **(outlined)** and a progress line lists the areas
  still to outline. An outline counts for the area it was generated for; a
  manual, edited or orphaned outline counts for any accepted area whose box
  contains the outline's centre.
- **Next** asks for confirmation while an accepted area has no outline. Choose
  **Outline Roof area N** to stay, or **Continue anyway** when that area is not
  part of the insulation scope. Nothing is blocked.

An ROI that cuts off the proposed scope must be corrected before use. Cropping
supplies context and never turns the ROI rectangle into a roof perimeter.
Generation failure, cancellation, navigation and stale responses leave existing
geometry intact. Changing the region, policy, guidance, page or scope invalidates
the pending proposal; any committed manual edit changes the scope, so it also
cancels a running generation. **Redraw** lets you keep drafting and preview the
last clicked point's reconnection to the same blue boundary; its single
**Finish redraw** button stays disabled while a generation is running or a
proposal awaits review. Clicking a boundary point never applies a redraw
automatically.
Review and drawing state still live only in the open
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
- With `ROI_OUTLINE_CLEANUP=shapely` (the default), each ring is first cleaned
  with Shapely. Self-intersecting rings are repaired (`outline_repaired`).
  Overshoot of the ROI by no more than the snapping radius is clipped
  (`clipped_to_roi`); larger overshoot is still `roi_too_tight`. Spikes and
  slots narrower than the snapping radius are removed (`thin_features_removed`).
  On the outline benchmark this recovered 2 of 26 replies that were previously
  rejected and changed nothing on the rest
  ([outline-benchmark.md](roi-evaluation/outline-benchmark.md)).
  `proposed_points` are then the cleaned rings.
- Before fitting, algorithm `source-supported-outline-v6` converts small traced
  curves, chamfers and corner jogs into a single CAD polygon vertex at the
  intersection of the adjoining long sides. Nearly collinear tracing bends
  (within 6 degrees and the snapping radius) immediately adjoining a short
  transition are removed first so extra model samples do not hide those sides.
  Shallow bends elsewhere are preserved. A corner run can contain any number of points;
  each leg must be shorter than twice the snapping radius (at most 24 source
  pixels), the total run at most six radii, and every removed point within three
  radii of the intersection. Both flanking sides must be at least four radii long.
  Actual side directions determine the angle, including rotated and oblique
  roofs. Straight offsets, larger returns, crossings under 30 degrees, corners
  outside the ROI and invalid results are preserved. Normalization, fitting and
  wider recovery share the original ring's 4% area and displacement allowances;
  separate roof components must remain separate. Successful corner normalization
  does not add a review warning, and `proposed_points` keep the pre-normalization
  vertices. Weak or ambiguous source-line evidence can still require review.
  The supplied `TP17221_25.01_outline.pdf` confirms a 12-edge exterior with one
  sharp corner at the hip-roof junction. Regression tests use that perimeter and
  rotated, reversed, oblique and densely sampled variants. No project-specific
  coordinates or page orientation are used by the implementation.
  See [TP17221 CAD corner validation](roi-evaluation/tp17221-cad-corners.md).
- Algorithm `source-supported-outline-v7` extends continuity fitting to a complete
  side, including multiple small face switches and extra tracing samples. It
  groups maximal forward runs within 3 degrees, separated by transverse paths
  no longer than two snapping radii. Each run must be at least four times the
  longest transition; the whole side's transverse spread must stay within two
  radii. Failed whole sides are not retried as smaller subchains.
  PDF vectors must support at least 90% of every run and 98% of the span between
  drawn corner anchors, with no uncovered interval over one source pixel.
  The extra search remains local (at most 36 source pixels); ordinary fitting
  still uses at most 12 px. Both corners require local adjoining stroke support
  over up to four radii, allowing an adjoining endpoint gap of at most 3 source
  pixels. This accommodates architectural interruptions further along that side.
  Anchor positions are evidence only: reconstruction intersects the proposed
  adjoining lines so moving one corner cannot introduce a tilted neighbouring edge.
  A finite connector joining two terminating source runs protects a real return.
  Other connector ink can be disregarded only when vectors show a T junction
  continuing at least four radii into the roof from the common boundary.
  Raster-only connectors remain protected. For a close pair of complete faces,
  policy selection needs agreement in at least three of five raster windows on
  one run and no contradictory majority on another run. Each surface gets its
  own vote, so a long unclear or hatched surface cannot overwhelm a clear one.
  `roof_deck`, more than two candidates, and conflicting evidence require review.
  Repairs preserve the original proposal and add `boundary_steps_straightened`.
  Unresolved chains add `boundary_continuity_ambiguous` and mark every affected
  edge for review. Fitting preserves these decisions; the original topology,
  winding, ROI, component, 4% area and displacement limits still apply jointly.
  The algorithm version invalidates previous cache entries.
  See the [whole-side regression](roi-evaluation/251004-left-boundary-continuity.md)
  and [earlier right-side diagnosis](roi-evaluation/251004-right-boundary-diagnosis.md).
- Vector segments supply candidate supporting lines; high-resolution raster
  contrast is the fallback. Collinear fragments contribute joint edge support.
  Small movements and consistent rotated directions are allowed. Equally
  plausible parallel faces retain the initial edge and produce a review warning.
  Adjacent fitted lines determine corners. The complete ring is checked again
  for topology, area change, displacement and containment before fitting is used.
- Algorithm `source-supported-outline-v4` adds recovery for an unsupported edge
  that has no candidates within the ordinary search radius. It searches twice
  that radius (at most 24 source pixels), only for edges at least four times the
  wider radius in length. Both adjoining sides must already have unambiguous
  vector support. A candidate must have at least 98% vector coverage, no gaps
  over one pixel, and finite strokes reaching both adjoining corners. Raster-only
  evidence, competing faces, supported edges and rejected ordinary fits do not
  qualify. This applies to all edge orientations and boundary conventions.
  All recoveries use the same pre-recovery ring, share the existing 4% area-change
  allowance with fitting/continuity repair, and must preserve valid topology, ROI
  containment and separate components. Evidence is recalculated for the moved
  edge and its adjoining sides; the original proposal remains available. The
  `boundary_edges_recovered` warning keeps the result subject to review. The
  algorithm-version change invalidates cached results from the older fitter.
- Algorithm `source-supported-outline-v5` limits a rejected corner fit locally.
  If intersecting the candidate lines would move a corner beyond the ordinary
  displacement limit or outside the ROI, both incident lines revert to their
  proposed positions. All unsafe corners are handled together and the bounded
  retry can only retain additional lines, never enlarge the search radius.
  Retained lines have their evidence recalculated, are marked for review and
  produce `local_fitting_limited`; they cannot anchor wider edge recovery.
  Safe fits and recoveries elsewhere can proceed. The complete ring still passes
  the existing topology, winding, 4% area, displacement, ROI and component checks;
  failures of those checks still reject the complete fit.
  An offline replay of 22 parsed captures across four cases changed only the
  previously rejected TP17221 response: its bottom moved from y=2600.09726 to the
  continuously supported inner boundary at y=2618.96 in source-page coordinates.
  The other 21 responses were identical. These coordinates are evaluation
  evidence only; the implementation contains no drawing-specific positions.
  This fallback remains for corners that cannot be normalized safely; v6 handles
  the small sampled TP17221 corner before fitting, removing the need for this
  fallback or a corner-review warning there.
- Algorithm `source-supported-outline-v8` adds verification of every edge of
  every exterior ring after local fitting and recovery. Each edge needs a
  continuous finite vector span or strong raster support in short windows,
  including its endpoints. Nearby paired faces are also checked for evidence
  contrary to the selected boundary convention. These checks flag uncertainty;
  they do not establish the construction meaning of a line.
  An unverified edge can be corrected by jointly comparing its line and both
  adjoining lines. The wider search is bounded by five snapping radii (at most
  60 source pixels) and one fifth of the edge length; adjoining faces stay within
  the ordinary radius. Candidate sides need source support at both ends, so a
  nearby dimension line cannot win solely on its length or proximity. Already
  verified adjoining lines and resolved continuity decisions are preserved.
  Paired closures require consistent inner/outer geometry and raster side
  evidence for the selected convention. Roof-deck policy needs a unique closure.
  Dense, disconnected, contradictory or conflicting alternatives remain for
  review. Corrections are considered together, without depending on ring start
  or page orientation, and preserve the ring's vertex order and side count.
  Shapely checks the complete result against the original cleaned ring: changed
  scope (symmetric difference) and net area are each bounded to 4%, in addition
  to displacement, validity, winding, ROI and component separation checks.
  `boundary_alignment_corrected` identifies applied corrections;
  `boundary_connections_unverified` and `boundary_policy_unverified` explain
  unresolved orange dashed edges. Proposals still require **Use outline**.
  The algorithm version changes cache identity. See
  [251004 perimeter verification](roi-evaluation/251004-perimeter-verification.md)
  for offline replay evidence and remaining limitations.
- No mask dilation, convex hull, blanket orthogonalisation or inferred rooflight
  holes are applied. Evidence scores measure line support, not calibrated model
  confidence or construction accuracy.
- The page image is decoded once per request. Fitting reads only the ROI region
  plus a 24 px margin, which gives results identical to full-page conversion.
  This reduced crop preparation from about 314 to 176 ms and fitting from 244 to
  16 ms. The Gemini call (about 11–14 s) remains the main cost.

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
the ROI service. Malformed model output is retried once within those budgets,
and rejected attempts are logged as `outline_output_rejected` with a failure
category (see `Phase-4-ROI-Review.md`). Outline requests are bounded to 512 KiB. Cache identity includes
the source, ROI/revisions, boundary notes, vector data, prompt, algorithm and
model settings. Source and review revisions are checked again before applying.
Cancellation prevents browser application; a provider call already sent can
still consume the shared budget and incur charges.

The frontend's atomic application reconciles existing cutouts against the new
scope, preserves unrelated roofs/outlets, and removes drainage-edge assignments
belonging to replaced outlines. The current editor, penetration processing,
illustration and project form consume the resulting `PagePolygon` records.

The backend lock now includes `shapely` (and `numpy`). Reinstall from
`backend/app/requirements.lock` before restarting. `ROI_JSON_MODE` (default
`true`) asks Gemini for a JSON-only reply without a schema. `ROI_OUTLINE_CLEANUP`
(default `shapely`; `none` disables) controls the clean-up step above. Both are
part of the cache key and the reported generation settings. Existing
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

[outline-benchmark.md](roi-evaluation/outline-benchmark.md) is the first step:
draft references for four cases, a capped live-capture command, and offline
scoring of geometry variants on the same captured replies. It also records an
OpenCV "which side is the roof" experiment that is not in the live service.
