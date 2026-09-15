# Phase 5: Penetration Recommendations And Review

Implemented on 2026-09-10 as an opt-in, localhost-only assisted-annotation slice.
Verification uses synthetic geometry and mocked model responses, not architectural
ground truth or a live accuracy claim. The public annotation API remains version 1.

## Delivered Workflow

- `VITE_ROI_ENABLED=true` enables
  `upload -> roi -> paint -> penetrations -> outlets -> details`, including
  additional PDFs. The disabled four-step manual workflow is unchanged.
- Penetration detection is explicit. It uploads the immutable unannotated full
  page and supplies only accepted/current ROI IDs, boxes and revisions. It uses
  the existing aspect-preserving maximum-1024-pixel preparation, exact
  `gemini-3.6-flash` model, temperature 0.5 and bounded request service.
- The new application prompt is `penetration-v1`; the draft and reference
  materials remain unchanged. It requests actual object/symbol extents and
  excludes text-only references, arbitrary equipment, outlets and out-of-scope
  objects, including empty portions of nonrectangular roof boxes.
- The provisional Phase 1 categories remain `rooflight`, `vent`, `flue` and
  `access_hatch`. The schema restricts parent IDs and subtypes. The service still
  reports `category_policy_pending_domain_review`; implementation does not
  constitute approval of that policy.
- The existing review canvas, overlay and sidebar now support penetration
  selection, acceptance/rejection, label/subtype edits, fractional drag/resize,
  numeric correction, manual addition, parent reassignment, deletion and undo.
  Compact `P1` labels retain full accessible names and tooltips. Accepted roof
  boxes and manual outlines/cutouts are passive context over the pristine image.
- Manual penetrations start suggested and need explicit review. A sole accepted
  parent is preselected; multiple/no parents leave the association unresolved.
  Detection and acceptance require a current accepted parent. Manual entry and
  onward navigation remain available without one.
- Loading, cancel, retry, valid empty, partial and failure states retain user
  work. Existing bounded partial-follow-up behavior is reused. Feedback is keyed
  by page/task and, for child tasks, ROI and geometry revision. Parent/geometry
  changes cannot reuse stale child feedback or accept late results.

## Association Safeguards

`penetrationAssociationWarnings` uses `polygon-clipping` to compare normalized
boxes with their assigned ROI, other accepted ROIs, and the union of relevant
manual roof polygons minus cutouts. Manual source-pixel geometry is normalized
using source width and height, never physical scale or illustration offsets.
Explicitly associated polygons are considered only for their own parent;
unassigned manual polygons provide page-level supporting evidence.

Missing parents, crossing/outside ROI boxes, overlapping parents, missing roof
outlines, geometry-check failures, out-of-roof objects and cutout overlap produce
review warnings. Initial proposals with such warnings are `needs_review`.
Valid geometry alone never accepts a suggestion or establishes semantic membership.
An explicit **Confirm association** can resolve geometric uncertainty when a
current accepted parent exists; missing/rejected parents cannot be overridden.

Box, subtype and parent corrections require re-review. Editing, removing or
rejecting a parent invalidates dependent children; changing manual roof outlines
or holes invalidates child associations and pending child requests. Edited and
accepted children are preserved, including original proposed geometry and edit
history. Undo cannot silently restore stale validity. Reruns retain decisions,
skip existing IDs and flag possible duplicates for reconciliation.

## Geometry And Handoff Boundaries

Acceptance never fills a polygon, subtracts a hole, creates an editor penetration,
sets physical width/height or places an outlet. Existing cutout and drainage tools
remain manual. New Build still passes `penetrations={[]}` to the legacy form.

Project Details includes a read-only penetration summary grouped by source
document/page and ROI. Accepted/current, suggested, rejected and unresolved work
remain distinguishable. This is an in-memory review summary, not an accepted-output
handoff: no annotation fields are added to the email payload, no save/load is
introduced, and reload or leaving New Build still loses review state. Phase 7
owns persistence and the receiving contract.

## Verification

Run from the repository root:

```powershell
npm test
npm run test:e2e:roi
npm run test:e2e -- --output .vite/phase-5-manual-e2e
npm run typecheck
npm run build -- --outDir .vite/phase-5-check
npm run lint
& "./backend/roi_app/.venv/Scripts/python.exe" -m unittest discover -s backend/roi_tests
```

Results: 80 frontend tests, 43 isolated offline backend tests, 6 mocked annotation
browser flows (3 ROI and 3 penetration), and both feature-disabled manual flows
pass. Type-check/build pass; lint remains 0 errors / 9 inherited warnings.
Editor diagnostics and changed Python syntax checks are clear.

Coverage includes two distinct parents, valid empty results, rejected out-of-ROI
objects, the empty part of an L-shaped roof, cutout/boundary geometry, parent
reassignment, explicit confirmation, cancellation, retained corrections/reruns,
manual/no-parent fallback, original-box preservation and unchanged geometry/email
boundaries. Existing session tests cover page isolation, parent and geometry
invalidation, late-response rejection, undo and scale independence.

The synthetic PDF contains two scopes and small symbols, including deliberately
out-of-scope proposals. These test the review contract, not model recall. Browser
requests verify pristine upload hashes/bytes and parent revisions. Desktop
(1600x1000) and mobile (390x844) checks cover nonblank/unannotated canvas pixels,
overlay alignment after zoom/scroll, unchanged canonical boxes and nonoverlapping
fixture labels. Screenshots are generated under `test-results/` as
`penetration-review-desktop.png` and `penetration-review-mobile.png`.

## Local Use And Remaining Gates

Use the isolated service setup in [Phase 3](Phase-3-Annotation-API.md), normally
on port 8091. In an unused frontend port:

```powershell
$env:VITE_ROI_ENABLED = "true"
$env:VITE_ROI_API_BASE_URL = "http://127.0.0.1:8091"
npm run dev -- --host 127.0.0.1 --port 8084 --strictPort
```

Open `http://127.0.0.1:8084/new-build`. The API must allow that exact origin in
`ROI_ALLOWED_ORIGINS`. Keep `ROI_ALLOW_LIVE=false` unless live processing and its
budget are explicitly approved. No live Gemini call, real email, API restart or
budget change was made for this implementation. Loading the new backend prompt
requires an intentional API restart, which resets in-memory uploads/cache/budgets;
do not restart an existing live pilot just to bypass its limits.

Full-page conditioned accuracy, small-object recall and the authoritative subtype
policy still require budgeted live evaluation and domain-reviewed positive and
negative targets. No high-resolution crops, extra crop calls or crop deduplication
were introduced without that evidence. Provider settings/access verification and
quality/latency/cost thresholds remain release gates. Outlet recommendation wiring
is Phase 6; persistence/handoff is Phase 7.

The complete pilot remains desktop-only. The touched review view was checked on
mobile, but inherited upload/paint/outlet/details layout limitations remain.
Production authentication, retention and provider-processing approval are unchanged.
The build still reports a large bundle; dependency installation reported 15
advisories (1 low, 7 moderate, 7 high). They were not suppressed or force-upgraded.