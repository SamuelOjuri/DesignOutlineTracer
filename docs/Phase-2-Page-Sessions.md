# Phase 2: Page Sessions And Coordinates

Implemented on `region-of-interest`, 2026-09-09. This is the frontend foundation
for assisted annotation, not an enabled detection feature or an accuracy claim.

## Source Identity

- [PdfUpload](../src/components/newbuild/PdfUpload.tsx) retains `onPdfRendered(canvas)`
  and adds `onPageRendered(source, canvas)` plus `onPageSelectionStart()`.
- [Source capture](../src/utils/roiSource.ts) snapshots an unannotated PNG Blob
  before either completion callback can paint the editor canvas. Blob bytes and
  the frozen source record remain independent of later canvas changes.
- Document identity is SHA-256 of PDF bytes, not the filename. Page identity
  incorporates the document hash, zero-based page index, source-image hash,
  raster dimensions, PDF.js scale/rotation/view box and render-version identifier.
  Equal pixels on different pages or in different files do not share a session.
- PDF.js owns rotation and crop. Width/height describe the actual canvas after
  integer raster sizing. The PNG is already oriented; coordinates are not rotated
  again. Render version includes the installed PDF.js version and capture format.
- Selection changes cancel available render work and ignore stale asynchronous
  completions, including completions after unmount. Failed uploads cannot enable
  progression using the previous page.
- Hashing uses Web Crypto and requires localhost or HTTPS. No image/PDF upload,
  Gemini call or API dependency is introduced. A future server must independently
  validate uploaded bytes, dimensions and hashes.

## Coordinates And State

[Types](../src/types/roi.ts) separate annotation boxes from physical roof,
penetration and outlet dimensions. Canonical `box_2d` and `proposed_box_2d` use
`[ymin, xmin, ymax, xmax]` in 0-1000 page coordinates. Subtypes follow the draft
Phase 1 contract; domain adjudication and provider-facing validation remain open.

[Coordinate helpers](../src/utils/roiCoordinates.ts) convert normalized boxes,
source-pixel rectangles, measured display scale/offset and padded crop rectangles.
Offsets include the measured canvas/container position and pan. Display scale
includes fit and zoom. Physical `DrawingScale` is deliberately absent. Invalid,
non-finite, inverted and out-of-bounds boxes are rejected, not silently clamped.
Fractional coordinates are retained; raster rounding belongs to renderers.

[Reducer](../src/utils/roiSession.ts) and [hook](../src/hooks/useRoiSession.ts):

- Retain separate annotations, manual drawing, review history and monotonic
  page/accepted-ROI/manual-geometry revisions per page.
- Keep original proposals separate from edits, with decision, validity and edit
  provenance independent. Model text remains data; no HTML rendering is added.
- Start requests with page, image hash, task, unique request ID and relevant
  revisions. Child tasks require an accepted/current parent. The hook returns an
  AbortSignal for future networking; no networking is performed here.
- Reject stale, cancelled, superseded, mismatched and replayed results. Switching
  away clears pending identities and aborts signals even if the user returns to
  the old page before the result arrives.
- Parent edits/removal/rejection invalidate associated children and pending child
  requests. Manual outline/cutout changes invalidate child associations without
  deleting accepted or corrected work. Drawing-scale changes do not invalidate
  annotation coordinates.
- Preserve existing accepted annotations on rerun, keep new results suggested,
  ignore repeated IDs and flag identical-box candidates for reconciliation.
  Spatial/semantic duplicate review and actual editor acceptance adapters belong
  to later phases. No result creates a polygon, hole or outlet.
- Undo the last review operation without removing proposals delivered afterward.
  Revision-aware undo does not revive stale child associations. Review undo is
  bounded to 100 entries per page. Run provenance is retained separately.

## Manual Editor Boundary

[New Build](../src/components/NewBuildApp.tsx) owns the hook and canvas references.
Each page stores source-pixel polygons with stable IDs and optional ROI links,
page-bound outlets, ID-based drainage edges and its own physical drawing scale.
The existing `Outlet` positions in New Build are source pixels; diameter remains
the existing `0.15` UI default, not an annotation measurement.

[Drawing adapters](../src/utils/roiDrawing.ts) resolve stable IDs into legacy
array/index props only at the editor boundary. Unchanged/reordered polygons retain
IDs; explicit vertex/edge edits retain the edited polygon ID. Newly extracted or
ambiguous split/merged polygons receive new IDs with unresolved ROI links, rather
than inheriting an association by array position. Drainage references to removed
polygons or changed edge counts are dropped.

Additional-page composition rescales into the first populated page's display
units and places subsequent pages to its right. Object-reference arrays preserve
page/ROI IDs. Illustration movement stores per-object display offsets, including
holes and outlets, without changing source geometry or annotation coordinates.
Returning to the editor shows only the active page's original geometry.

[Paint renderer](../src/components/newbuild/PaintBucketCanvas.tsx) rebuilds its
editable fill/cutout masks from saved manual polygons on remount and cancels
deferred initialization on unmount. It never rasterizes ROI boxes into a roof.
Mask undo starts a new local stack on remount; saved polygons and holes survive.

Additional upload is explicit: choose PDF/page and scale, then Next. Cancel
restores the previous active page without replacing its scale or manual work.
The step order remains `upload -> paint -> outlets -> details`. Refurbishment and
the external email payload are unchanged; internal page/annotation metadata is
not added to submission.

## Verification

```powershell
npm test
npm run test:e2e
npm run typecheck
npm run build -- --outDir .vite/frontend-phase2-check
npm run lint
```

- 38 unit tests cover source identity/immutability, stale PDF renders, coordinates,
  sessions, revision-aware undo, manual mask restoration and additional-page state.
- Deterministic coordinate fixtures cover corners/centres, non-square images,
  already-rotated 0/90/180/270-degree viewports, multiple resolutions, crop,
  zoom/pan, display offsets and physical-scale independence, within one source
  pixel. These synthetic fixtures are not detection ground truth.
- Desktop Chromium New Build and Refurbishment flows cover the manual fallback.
  New Build additionally reloads the same two-page PDF, proves the other page is
  unpainted, restores manual fill/undo and outlets, and checks pristine previews.
  Screenshot and canvas-pixel checks are retained in the Playwright report.
- Type-check and production build pass. Full lint has zero errors and the same
  nine inherited warnings. No diagnostics are suppressed or dependencies changed.
- Browser requests are guarded; submission is mocked. No real email, backend
  access or live Gemini evaluation is performed.

## Deferred Boundaries

State lives only in memory until the New Build screen is closed or reloaded.
Save/load, server storage, retention/authentication and versioned handoff are
later-phase work. Phase 3 supplies upload/provider validation, networking and
limits; Phase 4 supplies annotation overlays and review controls. No new ROI or
penetration step is exposed yet. Live model access and domain-reviewed data are
still Phase 1 gates. Existing mobile overflow, dependency advisories and the large
bundle warning remain; verification here supports the desktop development flow,
not mobile support or a production release.