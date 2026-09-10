# ROI Implementation Plan

## 1. Purpose And Status

- Branch: `region-of-interest`.
- Plan date: 2026-09-09.
- Status: Phases 0-3 provide the frontend baseline, offline reference tooling, page/session contracts, and isolated annotation API/client. Phase 4 now adds opt-in ROI review and explicit detection orchestration, verified with offline fixtures and browser flows. Live model access and domain-reviewed dataset gates remain pending; penetration/outlet recommendation wiring and persistence are not enabled.
- Model: Gemini 3.6 Flash, using the configured identifier `gemini-3.6-flash` demonstrated in the supplied prototype.
- Scope: enhance the existing New Build workflow with reviewable region-of-interest (ROI), roof-penetration, and rainwater-outlet recommendations.

This plan supersedes the previous backend implementation plan for this branch. It does not adopt extraction logic, architecture, or results from the experimental branches. Existing backend artifacts must not become dependencies merely because they remain on disk.

### Branch Objectives

1. Identify and annotate all relevant proposed flat roof / tapered-insulation scope areas on the selected architectural roof-plan page.
2. Identify and annotate roof penetrations belonging to those areas.
3. Identify and annotate rainwater outlets serving those areas, including outlets at their boundaries.
4. Present each recommendation at the appropriate New Build step, with acceptance, correction, rejection, and manual alternatives.

### Non-Goals

- Automatic production-quality roof-perimeter tracing or segmentation masks.
- Treating bounding boxes as exact roof polygons, holes, dimensions, or measured areas.
- Generating tapered-insulation layouts, drainage designs, CAD geometry, or DXF exports.
- Reintroducing vector-candidate generation, OpenCV boundary refinement, independent OCR pipelines, or legacy approval schemas.
- Rebuilding the frontend framework, redesigning Refurbishment, or replacing the existing manual roof-definition tools.
- Claiming that model confidence or a user's acceptance makes the output construction-ready.

## 2. Verified Starting Point

The recovered frontend is React 18, TypeScript, Vite 5, Tailwind, and shadcn/ui, restored selectively from pre-backend commit `1543ee90daf466dc5410b61141d640f830e9a961`.

| Existing Surface | Current Behaviour | Integration Responsibility |
| --- | --- | --- |
| [NewBuildApp.tsx](src/components/NewBuildApp.tsx) | Owns upload, paint, outlets, and details state; combines additional drawings using scale and offsets | Introduce page-specific annotation sessions and orchestration without losing manual work |
| [PdfUpload.tsx](src/components/newbuild/PdfUpload.tsx) | Renders PDFs locally with PDF.js, supports page selection, and returns a canvas | Return explicit document/page/render context and an immutable source image |
| [NewBuildStepHeader.tsx](src/components/newbuild/NewBuildStepHeader.tsx) | Displays the four existing steps | Add ROI review and penetration review to the New Build sequence |
| [NewBuildSidebar.tsx](src/components/newbuild/NewBuildSidebar.tsx) | Shows step-specific manual controls | Host recommendation lists, selection, and review actions |
| [PaintBucketCanvas.tsx](src/components/newbuild/PaintBucketCanvas.tsx) | Manual fill, cutout, and boundary adjustment | Preserve manual geometry tools; display accepted ROI context separately |
| [NewBuildOutletCanvas.tsx](src/components/newbuild/NewBuildOutletCanvas.tsx) | Manual outlet placement/movement and drainage-edge editing | Overlay outlet suggestions and explicitly convert accepted positions into editable outlet records |
| [RoofIllustrationCanvas.tsx](src/components/newbuild/RoofIllustrationCanvas.tsx) | Combined drawing illustration | Preserve display transforms without rewriting source annotation coordinates |
| [ProjectDetailsForm.tsx](src/components/ProjectDetailsForm.tsx) | Sends the original payload to an external Supabase email function | Add annotation handoff only after agreeing and testing the receiving contract |
| [roof.ts](src/types/roof.ts) | Shared manual drawing, outlet, penetration, and step types | Extend New Build navigation; keep annotation records separate from physical geometry types |

New Build currently passes an empty penetration array to the project-details form. The shared `Penetration` type does not establish that New Build has a dedicated penetration workflow or that its dimensions use annotation-image units.

The recovered application builds and type-checks. Browser verification covered PDF loading, page switching, manual region selection, outlet placement, and navigation to Project Details. See [README.md](README.md) for the recovery record.

Known inherited limitations are 26 lint errors, 17 warnings, 13 dependency advisories, a large application bundle, and narrow-screen layout overflow. These are not evidence of completed production hardening. Do not suppress existing diagnostics to make a phase pass.

## 3. Prototype Assessment And Decisions

Reference material:

- [Notebook](docs/roi-logic/New_Roof_Plan_Spatial_understanding_logic.ipynb).
- [Python export](docs/roi-logic/new_roof_plan_spatial_understanding_logic.py).
- [Captured notebook results](docs/roi-logic/New%20Roof%20Plan%20Spatial_understanding_logic.pdf).
- [Example roof plan](docs/TP17202_25.01_input.pdf).

The supplied code loads a JPEG, resizes it to fit within 1024 by 1024 pixels while preserving aspect ratio, and calls Gemini 3.6 Flash at temperature `0.5`. It requests labelled bounding boxes and interprets them as `[ymin, xmin, ymax, xmax]`, normalized to 0-1000.

The captured example contains two roof-region recommendations and two outlet recommendations. It demonstrates the intended interaction, not general detection accuracy. The source drawing already includes red scope callouts; evaluation must also include drawings without those cues.

Implementation decisions:

- Use the first, simpler ROI prompt as the initial reference. Treat the third notebook call as an alternative ROI prompt to evaluate, not a required second processing stage.
- Keep `gemini-3.6-flash` as the selected model. Verify access using the actual deployment project before integration; report an unavailable model rather than silently substituting another model.
- Preserve the original prompts, responses, and source documents as reference material. Write application code separately; do not turn the Colab export into the service entry point.
- Replace Colab secret access and package-install commands with server environment configuration and a reproducible dependency installation.
- Explicitly specify coordinate order and normalization in the application schema and prompts; the plotting helper currently assumes them.
- Use structured JSON output if supported by the verified model/SDK combination. The captured result includes code fencing despite the prompt, so parsing and schema validation cannot rely on instructions alone.
- The notebook prose recommends disabling thinking, but the demonstrated calls do not configure it. Record the actual supported settings instead of assuming thinking was disabled.
- Add a new penetration task. No penetration request or positive penetration result is demonstrated in the supplied prototype.
- Condition child detection on accepted ROI coordinates. The prototype's outlet request independently reinterprets the entire page and does not establish a parent-child relationship.
- Keep rooflights out of the list of roof ROI detections, but detect them as penetration annotations when relevant. A rectangular ROI cannot geometrically exclude an interior rooflight without becoming a different geometry representation.

## 4. Target Workflow And Architecture

### User Journey

```text
Upload PDF and choose page
  -> Review roof ROI recommendations or add/select regions manually
  -> Define/refine roof geometry using the existing manual tools
  -> Review penetration recommendations associated with accepted ROIs
  -> Review outlet recommendations and existing drainage controls
  -> Review project details and annotation summary
```

The proposed New Build step order is `upload -> roi -> paint -> penetrations -> outlets -> details`. Refurbishment retains its existing step order.

An accepted ROI is a recommendation about the working area. Accepting it does not fill the roof, draw its perimeter, create a cutout, or set an outlet diameter. The user remains responsible for manual geometry refinement where the existing workflow requires it.

Automation is optional. Each detection step offers a manual route. If the service fails, previously accepted work remains available. A user who skips ROI detection may add manual ROI boxes, or continue the original manual workflow without child detection. Child detection requires accepted or manually defined parent ROIs.

### Initial Architecture

```text
Existing PDF.js renderer
  -> immutable selected-page image and page identity
  -> isolated ROI API
  -> image preparation + Gemini request + response validation
  -> normalized annotation proposals
  -> page-bound frontend review state and overlays
  -> explicit acceptance/adaptation into existing controls where appropriate
```

For the first implementation, keep PDF.js as the source renderer and upload its unannotated selected-page image to the service. The backend does not need to parse or independently render the PDF. This is a deliberate simplification of the earlier conceptual backend-rendering proposal: it reuses the verified baseline and avoids introducing mismatched PDF.js/PDF-renderer coordinates.

The original PDF stays in the browser for this version. The selected-page image is transmitted to the application service and Gemini only when the user initiates detection. Deployment must disclose that processing and enforce the appropriate access and retention controls.

Use a small Python/FastAPI service in a new, isolated `backend/roi_app/` package. Do not import the remaining `backend/app/` modules. Proposed dependencies are FastAPI, Uvicorn, Pydantic, Pillow, and `google-genai`, pinned through a reproducible dependency specification after verifying SDK/model compatibility. No legacy geometry engine is required.

### Ownership Boundaries

- PDF.js owns the source page orientation and rasterization.
- The ROI API owns image validation, provider access, structured response validation, limits, and request provenance.
- Gemini proposes semantic detections; it does not approve user work or define physical geometry.
- The frontend owns review decisions, manual corrections, page/session state, and editor interactions.
- Narrow adapters handle any explicitly accepted conversion to an existing editor record.
- Submission/persistence uses a versioned annotation contract rather than legacy extraction metadata.

## 5. Core Contracts

### Coordinates And Page Identity

- Canonical annotation geometry is a bounding box in 0-1000 normalized page coordinates: `[ymin, xmin, ymax, xmax]`.
- Origin is top-left of the rendered, visible PDF page. X increases rightwards; Y increases downwards.
- The canonical image includes the PDF.js viewport's effective rotation and crop. Do not rotate model coordinates a second time.
- Store `document_id`, zero-based `page_index`, `page_id`, source-image hash, source width/height, render scale/rotation, and a render-version identifier.
- Hash and validate uploaded image bytes on the server; do not trust client-supplied dimensions or hashes as validation.
- Preserve fractional coordinates for user edits and transforms. Round only where raster drawing requires integer pixel positions.
- Convert to source pixels with `x_px = x_norm * source_width / 1000` and `y_px = y_norm * source_height / 1000`.
- Convert from source pixels to display coordinates through the editor's measured zoom, pan, and container offsets. Never store viewport coordinates as source geometry.
- For padded ROI crops, retain the source-pixel crop rectangle. Map crop-relative boxes back to full-page coordinates before returning proposals.
- Physical scale and `DrawingScale` are not needed for annotation display. Do not populate millimetre/metre fields from pixel box widths.

### Annotation Model

Create a separate frontend type module, proposed as `src/types/roi.ts`, with corresponding backend schemas.

Each annotation should include:

- Server- or application-assigned stable ID; IDs are not generated by the model.
- `page_id` and `kind`: `roof_roi`, `penetration`, or `rainwater_outlet`.
- `box_2d`, a label, and an optional controlled subtype such as `rooflight` or `vent`.
- `roi_id` for a child association, nullable only while unresolved and requiring review.
- `origin`: `gemini` or `manual`.
- Review decision: `suggested`, `accepted`, or `rejected`.
- Revision and an independent validity state: `current` or `needs_review`.
- Original proposed geometry and current edited geometry, with edit provenance.
- Optional short evidence/reason text and warnings. Treat model text as untrusted plain text.

Persist run provenance separately: model identifier, prompt/schema version, image hash, task, settings, request ID, timing, completion state, and accepted-ROI revision used for child detection. Do not display numeric confidence as a calibrated probability unless calibration has actually been established.

An example response envelope, illustrating shape rather than verified detections:

```json
{
  "schema_version": "1",
  "page_id": "page_example",
  "request_id": "request_example",
  "task": "roof_roi",
  "status": "complete",
  "roi_revision": null,
  "model": "gemini-3.6-flash",
  "prompt_version": "roof-roi-v1",
  "annotations": [
    {
      "id": "roi_example_1",
      "kind": "roof_roi",
      "label": "Proposed flat roof",
      "box_2d": [288, 202, 458, 277],
      "roi_id": null,
      "origin": "gemini",
      "review_status": "suggested",
      "validity": "current",
      "revision": 1,
      "warnings": []
    }
  ],
  "warnings": []
}
```

### Proposed API

| Endpoint | Responsibility |
| --- | --- |
| `GET /api/roi/v1/health` | Report service readiness without exposing credentials; do not perform a billable model call |
| `POST /api/roi/v1/pages` | Accept a bounded multipart PNG/JPEG plus page context; return immutable page identity and validated dimensions |
| `POST /api/roi/v1/pages/{page_id}/detections` | Execute `roof_roi`, `penetration`, or `rainwater_outlet`; child tasks include accepted ROI geometry and its revision |
| `DELETE /api/roi/v1/pages/{page_id}` | Remove temporary uploaded images and related cached proposals owned by that session |

Detection starts as a bounded request/response operation with cancellation support in the frontend. If measured latency exceeds deployment request limits, add job submission and status endpoints explicitly rather than letting requests hang. Do not start with a worker queue without that evidence.

The result distinguishes `complete`, `no_detections`, and `partial`. Provider failure, refusal, malformed output, timeout, and invalid input are structured errors, never an empty successful annotation set. `no_detections` means the model returned none; it is not proof that the drawing contains none.

Enforce configurable upload-byte, decoded-pixel, annotation-count, response-size, timeout, and concurrent-request limits. The prototype's 25-object cap is not a completeness guarantee; reaching a cap or provider output limit must warn about possible truncation and support a bounded follow-up strategy.

### State And Editing Rules

- Each selected document/page has its own session, annotations, manual geometry, and revision history.
- Starting a new request does not overwrite previously accepted annotations.
- Switching files or pages aborts the old request where possible and ignores any late result with a different page/request/revision identity.
- An accepted ROI edited, removed, or rejected invalidates its child associations and in-flight child requests. Preserve edited/accepted children as `needs_review`; do not silently delete user work.
- A manual roof-outline edit can also invalidate child-to-roof associations even if the broad ROI box stays unchanged.
- Reruns create proposals for reconciliation; they do not duplicate already accepted outlets or cutouts.
- Zooming, changing display layout, or moving the combined illustration must not alter canonical annotation coordinates.
- The existing additional-PDF scale/offset merge is a display/export transform, not a new source page. Retain source page and ROI references through that transform.

## 6. Phase-By-Phase Delivery

### Phase 0: Secure The Frontend Checkpoint

**Starting status:** frontend restoration complete; files remain uncommitted at the time this plan was written.

**Delivery update (2026-09-09):** Vitest/React Testing Library and Playwright
harnesses are implemented. Clean install, 2 unit tests, 2 desktop browser
flows, type-check, build, and focused test lint pass. The reviewed frontend
checkpoint is staged, with commit approval still pending. See
[Phase 0 checkpoint](Phase-0-Frontend-Checkpoint.md) for coverage, results,
preserved artifacts, and the current dependency/lint debt.

**Implementation**

1. Review Git status and checkpoint only the restored frontend, configuration, documentation, and intended fixtures. Stage paths deliberately; remaining backend files are not automatically part of the baseline.
2. Preserve local environment files and reference PDFs/notebooks. Archive or remove obsolete artifacts only after separate review and approval.
3. Keep the existing npm lockfile and local PDF.js worker. Record inherited lint and dependency issues without broad unrelated rewrites.
4. Add a focused frontend test harness using Vitest/React Testing Library for state and transforms, and Playwright for browser flows. Do not change the existing framework or React version.
5. Capture manual New Build and Refurbishment smoke tests before adding automation.

**Deliverables:** reviewed recovery checkpoint, reproducible manual-flow smoke tests, and documented test commands.

**Exit criteria:** clean install, type-check, and build pass; PDF selection, manual outline creation, outlet placement, and project-details navigation still work without the ROI service. No real project email is sent by tests.

### Phase 1: Establish The Gemini Reference And Evaluation Set

**Depends on:** Phase 0.

**Delivery update (2026-09-09):** An isolated, explicitly invoked runner under
`backend/roi_reference/` now provides the original simple ROI reference profile,
separate JSON/thinking experiments, draft conditioned child prompts, bounded image
preparation, private run provenance, strict parsing, and an offline evaluation CLI.
Dependencies are pinned separately from the legacy backend. Synthetic contract
fixtures and a pending-source/review manifest are included. No live Gemini call
was made; the original JPEG is unavailable locally, and the sample/category policy
and real positive/negative held-out set still require domain adjudication. These
are open exit criteria, not completed accuracy evidence. See the
[Phase 1 runbook](roi-evaluation/README.md) for commands and review requirements.

**Implementation**

1. Create a server-side, explicitly invoked reference runner outside the Colab notebook. Keep reference material unchanged.
2. Use `gemini-3.6-flash`, the demonstrated temperature, original simple ROI prompt, and aspect-preserving 1024-pixel maximum image side as the initial reference configuration.
3. Verify actual model access and supported JSON/thinking settings with the deployment credentials. Do not put API keys in browser code, logs, fixtures, or Git.
4. Preserve the exact inference image, its hash and dimensions, request settings, raw response, and parsed result for authorized development runs.
5. The original JPEG referenced by the notebook must be obtained or explicitly marked unavailable. A PDF.js-rendered derivative is a separate input variant, not an exact reproduction of that JPEG.
6. Have a roof-domain reviewer label expected ROIs and object associations. The sample's two suggested ROIs and outlets become ground truth only after that review.
7. Add examples with multiple/disconnected scopes, nonrectangular scopes, interior rooflights, small vents, boundary outlets, dense notes, rotation, ambiguous scope, and no relevant targets. Include unmarked drawings and a held-out set.
8. Define the included penetration subtypes and outlet symbols. Do not assume every RWP label or every rooftop object is an in-scope penetration/outlet.

**Deliverables:** versioned reference prompts/configuration, manually reviewed evaluation manifest, sanitized response fixtures, and a repeatable evaluation command.

**Exit criteria:** the service account can invoke the selected model; an end-to-end reference response can be parsed; the sample is manually adjudicated; negative and positive test cases exist for all three objectives. Accuracy across the dataset remains measured, not assumed from one screenshot.

### Phase 2: Introduce Page Sessions And Coordinate Contracts

**Depends on:** Phase 0; use Phase 1 evidence to finalize provider-facing fields.

**Delivery update (2026-09-09):** Typed PDF page callbacks now retain an immutable
PNG and SHA-256 document/page/render identity while preserving the canvas callback.
Pure coordinate helpers and an in-memory session reducer/hook cover fractional
transforms, request cancellation, late-result rejection, undo and child invalidation.
New Build retains manual page records and stable object IDs; additional-page scale
and illustration offsets are derived display transforms, not source mutations.
The four-step manual workflow and existing email payload remain unchanged.
Synthetic unit and desktop browser checks cover these contracts, not detection
accuracy. See the [Phase 2 record](Phase-2-Page-Sessions.md) for verification,
editor boundaries and deferred work.

**Implementation**

1. Extend `PdfUpload` through a typed page-context callback while retaining its existing canvas callback for compatibility. Include file identity, page index, viewport rotation/scale, dimensions, and render version.
2. Keep a pristine rendered source canvas/image separate from painted overlays. Produce a PNG/JPEG blob for inference before any visual annotation is composited.
3. Add annotation/page types, pure coordinate helpers, and a session reducer/hook. Do not place Gemini networking directly inside the canvas renderer.
4. Implement per-page annotation state, request identity checks, revision updates, undoable review edits, and child invalidation rules.
5. Preserve original page records during additional-PDF workflows. Associate manual polygons and child annotations through IDs instead of array position alone.
6. Define unit conversions at editor boundaries and test round trips. Synthetic geometric fixtures are sufficient for these tests and must not be labelled as detection accuracy evidence.

**Proposed files:** `src/types/roi.ts`, `src/utils/roiCoordinates.ts`, `src/hooks/useRoiSession.ts`, and neighboring tests; update the existing upload and New Build owner components.

**Exit criteria:** equivalent boxes align across source-image sizes, zoom/pan, rotation, and crops with at most one source-pixel conversion error in deterministic tests. Page changes and stale responses cannot contaminate another page. Drawing scale changes do not move an annotation overlay.

### Phase 3: Implement The Isolated Annotation API

**Depends on:** Phases 1 and 2.

**Delivery update (2026-09-09):** `backend/roi_app/` now implements bounded
upload/detection/deletion and nonbillable health, strict Pydantic/image validation,
the exact-model provider adapter, session ownership, expiry, proposal caching,
request deduplication, bounded transient retries and a single explicit partial
follow-up. Dependencies are isolated and hash-locked. The opt-in frontend client
validates responses and supports cancellation without changing manual screens or
submission. 32 offline backend tests, 52 frontend tests, both desktop manual
flows, type-check, build and lint (0 errors, 9 inherited warnings) pass. Live
provider access/settings and domain-quality gates remain unverified; the service
is deliberately localhost-only, with live calls disabled by default. See the
[Phase 3 record](Phase-3-Annotation-API.md) for contracts, limits and setup.

**Implementation**

1. Create `backend/roi_app/` with a small application entry point, configuration, request/response models, image preparation, provider adapter, and task-specific prompt files. Keep its dependency/test setup isolated from leftover backend modules.
2. Implement the page upload and detection API described above. Validate file content with Pillow, enforce decoded-size limits, and store images under generated identifiers, not user-controlled paths.
3. Resize the unannotated page to the Phase 1 reference dimensions while preserving aspect ratio. Keep the original render for later high-resolution crops.
4. Validate model responses using Pydantic: expected fields, finite numbers, coordinate ordering, allowed bounds, known kinds, nonzero boxes, and accepted parent IDs. Reject malformed geometry rather than silently converting it into a plausible detection.
5. Use the SDK's supported structured-output facility where verified. If a compatibility parser is needed for the captured fenced JSON, isolate it and test it; never evaluate model text as code or accept arbitrary prose as JSON.
6. Add bounded retries for transient failures only, with request deduplication and cost limits. Do not retry refusals, invalid input, or malformed output indefinitely.
7. Cache provider proposals using source-image hash, model, prompt/schema/settings version, task, and canonical accepted-ROI geometry/revision. Never reuse a child result for different ROIs or treat cached suggestions as accepted.
8. Add frontend API calls behind a proposed `VITE_ROI_ENABLED` flag and `VITE_ROI_API_BASE_URL`. Store `GOOGLE_API_KEY` only on the service; require the exact selected model in configuration.
9. Bound image/cache lifetime, add cleanup and ownership checks, restrict CORS, and keep raw drawing data out of normal logs. Treat text embedded in a drawing as task data, not instructions to the service.

**Proposed files:** `backend/roi_app/main.py`, `config.py`, `models.py`, `images.py`, `gemini.py`, `prompts/`, `backend/roi_tests/`, and `src/integrations/roi/client.ts`.

**Exit criteria:** contract tests pass for valid boxes, empty results, refusals, malformed/truncated output, authentication/model failures, timeout, bad images, and cache invalidation. Health checks make no billable call. Tests use fake provider responses unless explicitly running authorized live evaluation. The legacy backend is not imported.

### Phase 4: Deliver ROI Recommendations In New Build

**Depends on:** Phases 2 and 3.

**Delivery update (2026-09-09):** The feature flag now enables
`upload -> roi -> paint -> outlets -> details`, including additional PDFs.
Explicit pristine-image upload/detection supports cancellation, retry, empty and
partial results, and one follow-up per upload incarnation. Independent overlays
and sidebar review support acceptance, rejection, fractional drag/resize and
numeric correction, manual regions, deletion, and undo. Reruns preserve prior
decisions and flag possible duplicates or sheet-wide proposals. Accepted boxes
remain passive paint context, never filled polygons. 66 frontend unit tests,
three mocked ROI browser flows and both feature-disabled manual flows pass;
type-check/build pass and lint remains at 0 errors / 9 inherited warnings.
Desktop/mobile ROI screenshots and source-pixel checks are included, but the
whole workflow remains a desktop-only localhost pilot. Live provider and
domain-quality gates remain open. See the [Phase 4 record](Phase-4-ROI-Review.md).

**Implementation**

1. Add the `roi` step before manual roof definition; update step order, progression rules, and sidebar content together.
2. Add a reusable annotation canvas overlay and recommendation list. Draw independent boxes for multiple roof regions rather than a single enclosing sheet box.
3. Expose an explicit detection action after page selection. Provide loading, cancel, retry, error, no-detections, and partial-result states without blocking the manual path.
4. Allow selecting a recommendation, inspecting it, accepting/rejecting it, dragging/resizing its box, adding a manual ROI, and undoing a review edit. Preserve the model's original proposal separately.
5. Use short on-canvas labels such as `Roof area 1`; show longer evidence in the sidebar. Use existing Lucide icons, tooltips, focus styles, and UI conventions. Status must not rely on color alone.
6. Carry accepted ROIs into the paint step as context and optional focus/zoom targets. Do not automatically feed boxes into flood fill, crop away the rest of the drawing, or replace manually selected polygons.
7. On rerun, reconcile new suggestions with existing review state. A suspected duplicate or sheet-wide box should be flagged for review; do not hard-code the assumption that the correct roof can never occupy most of a page.

**Proposed files:** `RoiReviewCanvas.tsx`, `RoiReviewSidebar.tsx`, and a shared `AnnotationOverlay.tsx` under `src/components/newbuild/`; update the existing New Build owner, sidebar, header, and step type.

**Exit criteria:** a user can upload a PDF, choose the right page, request Gemini recommendations, review multiple boxes, and continue to manual roof definition. Service-offline, no-detection, and rejected-all scenarios have usable manual alternatives. Browser tests prove overlay alignment and retention of user edits.

**Milestone:** this is the first complete automation release slice. Do not begin production penetration/outlet wiring before the ROI contract works end to end.

### Phase 5: Add Penetration Recommendations

**Depends on:** Phase 4.

**Implementation**

1. Add a `penetration` prompt/schema using the Phase 1 subtype policy. Request actual object/symbol extents, not surrounding text labels or arbitrary rooftop equipment.
2. Supply the unannotated full-page image plus accepted ROI IDs and coordinates. The model must associate detections with those ROIs and exclude out-of-scope objects.
3. First evaluate the full-page conditioned approach. If small-object recall is inadequate, introduce padded high-resolution crops as a measured refinement, retaining full-page context and exact crop transforms. Deduplicate overlapping-crop results.
4. Add a dedicated penetration review step after manual roof definition. Allow acceptance, rejection, relabelling, box correction, manual addition, and reassignment to an ROI.
5. Use overlap with accepted ROIs and any associated user-defined roof geometry as supporting validation, not proof of semantic membership. Flag objects whose association is ambiguous, including objects falling into the empty portion of a nonrectangular roof's bounding box.
6. Keep accepted penetration boxes as annotations. Manual cutouts remain available, but detection does not automatically subtract a hole or set a physical width/height. An explicit future adapter requires independently verified units and a deliberate user action.
7. Mark dependent recommendations for re-review when their parent region or roof geometry changes.

**Proposed files:** penetration prompt/schema additions, `PenetrationReview.tsx`, shared overlay/list extensions, and association/review tests. Reuse existing presentation primitives, not Refurbishment's geometry assumptions.

**Exit criteria:** a positive penetration fixture and an out-of-ROI negative fixture pass through the complete review flow. Multiple ROIs remain distinct. Accepted annotations survive step navigation and are available in the project summary without becoming unintended holes.

### Phase 6: Add Outlet Recommendations

**Depends on:** Phase 4; share the association/review infrastructure established in Phase 5.

**Implementation**

1. Add the `rainwater_outlet` task conditioned on accepted ROI IDs and boxes. Include outlets on boundaries or immediately adjacent symbols clearly serving the ROI; strict interior containment is insufficient.
2. Request outlet symbol boxes and separate any label evidence. Do not use an RWP text centroid as a guaranteed outlet position, or treat every RWP elsewhere on the page as relevant.
3. Present proposals in the existing outlets step, separate from accepted manual outlets. Reuse accept/reject, correction, manual addition, and association controls.
4. On explicit acceptance, propose an editable outlet anchor from the symbol box center. Require user adjustment when it represents a label, leader, or ambiguous edge connection; retain the original detection and link the editor outlet to its annotation ID.
5. Keep the current manual diameter default as a UI default, not a model measurement. Review the existing pixel/editor unit conversion before populating `Outlet.x` and `Outlet.y`.
6. Do not infer drainage-edge assignments, falls, or hydraulic design from outlet boxes. Preserve existing manual drainage controls.
7. Avoid duplicate editor outlets when rerunning detection or reaccepting an annotation. Preserve user-moved positions and mark uncertain associations for review.

**Exit criteria:** the reviewed sample outlets and additional boundary/out-of-scope cases can be suggested, corrected, and accepted. Reruns do not duplicate accepted outlets. Manual outlets and drainage-edge editing continue to work when detection is disabled.

### Phase 7: Preserve Review State And Define Handoff

**Depends on:** Phases 4-6.

**Implementation**

1. Add a project summary grouped by document, page, and ROI, showing accepted roof regions, penetrations, and outlets. Make unresolved/invalidated associations visible.
2. Define a versioned annotation review document containing canonical source geometry, review decisions, provenance, and links to manual editor objects. Do not use combined-illustration offsets as source coordinates.
3. Provide explicit save/load of that review document, validated against matching source-image/document identity. A first version may use a local JSON download/import; do not store raw drawing images or secrets in browser local storage by default.
4. Preserve accepted edits during navigation, reruns, and adding another PDF. Test restoring a review file, document mismatch, rejected results, and `needs_review` annotations.
5. Define any production server-side draft persistence and retention only with an agreed ownership/authentication policy. Local review files are not a substitute for multi-user access control.
6. Do not silently send new fields to the original email endpoint. Agree a receiving schema and integration test before adding accepted annotation data to submission; keep the legacy payload compatible when automation is disabled.
7. Treat penetration annotations as their own payload section rather than copying box dimensions into the currently empty New Build `penetrations` geometry array. Include only accepted/current results in an accepted-output handoff; retain rejected proposals only in an explicitly requested audit document.
8. Mock project submission in automated tests and require explicit authorization for a real email or external storage test.

**Exit criteria:** accepted annotation state round-trips without losing page/ROI identity or user edits. An annotation review document is usable independently of the unavailable legacy backend. External submission is either verified against an agreed contract or clearly kept outside the enabled annotation release.

### Phase 8: Evaluate, Harden, And Release Gradually

**Depends on:** Phases 0-7.

**Implementation**

1. Run the versioned evaluation set and repeated live runs using the approved model/project. Separate training/prompt-tuning examples from held-out evaluation.
2. Report ROI/object precision and recall, box overlap against reviewed targets, parent-association accuracy, missed critical targets, false in-scope objects, and user correction effort. For tiny outlets also measure normalized position error, since box IoU alone is unstable.
3. Record latency, failure rate, request count, token/usage information where available, and cost per page/task. Compare full-page and crop variants before enabling extra calls.
4. Agree numerical quality, latency, and cost thresholds with the domain owner using Phase 1 results before release. Do not invent a high accuracy claim from the demonstration. Review-assisted accuracy remains distinct from geometric precision.
5. Test multi-page/multi-document sessions, page switching during a call, cancellation, retry, parent edits, truncated results, request caps, invalid uploads, expired images, and network loss. Automated jobs must not silently mark partial output complete.
6. Before exposure beyond localhost, enforce authenticated access, per-user request/storage budgets, authorized page ownership, restrictive CORS, secret handling, image retention/deletion, and safe error/log output. Verify the relevant provider data-processing requirements.
7. Verify annotation overlays at desktop and mobile viewports, with screenshots and canvas-pixel checks. Address overflow in the touched New Build surfaces before claiming mobile support; otherwise explicitly keep the release desktop-only. Do not silently imply the inherited layout is responsive.
8. Review dependency advisories and deployment settings before production use. Avoid broad forced upgrades without regression tests.
9. Keep a feature flag to disable all ROI networking and UI proposals without breaking the original manual workflow. Roll out internally first, then to a reviewed pilot group, then more broadly if the agreed gates pass.

**Exit criteria:** required functional/security tests pass, held-out quality is reviewed against agreed thresholds, manual fallback works, inherited debt is documented or addressed according to risk, and deployment/rollback instructions exist. Keep this feature labelled and operated as assisted annotation.

## 7. Verification Matrix

| Risk | Required Check |
| --- | --- |
| Wrong sheet/page receives results | Two-page fixture plus delayed response after page/file switch |
| Coordinates swapped or shifted | Known corner/center boxes, non-square images, rotation, crop, zoom, and pan tests |
| Annotated image contaminates inference | Hash/pristine-image test proving overlays are never uploaded as the source |
| Multiple roofs merged incorrectly | Independent ROI records, acceptance, and child associations on one page |
| Box mistaken for roof geometry | Accepting an ROI leaves manual roof polygons unchanged |
| Penetration outside actual scope | In-ROI-box but out-of-roof negative cases and explicit uncertain association review |
| Boundary outlets discarded | Fixtures with symbol center on/outside an ROI edge but serving the roof |
| Parent edits leave stale children | Revision invalidation, late-response rejection, and preserved user corrections |
| Rerun duplicates manual objects | Detection-to-editor ID mapping and idempotent acceptance tests |
| Model error appears as no objects | Separate refusal/error, valid empty, and partial response fixtures |
| Dense page truncates detections | Object-cap/output-limit detection and bounded follow-up tests |
| New backend revives old experiments | Dependency/import checks and startup with the old backend stopped |
| Secrets or drawing data leak | Environment/log review, endpoint ownership tests, cleanup tests, mocked submission |
| Manual workflow regresses | Feature-disabled browser test through New Build and Refurbishment |

Existing verification commands:

```powershell
npm ci
npm run typecheck
npm run build -- --outDir .vite/frontend-baseline-check
npm run lint
```

Add focused frontend unit/browser and backend contract-test commands when their harnesses are created. Current build and type-check are required gates; record existing lint debt separately and introduce no new lint failures in new modules. Live Gemini evaluation must be an explicit, budgeted command, not part of ordinary CI.

## 8. Delivery Boundaries And Decisions

Recommended reviewable increments:

1. Frontend checkpoint and regression harness.
2. Reference fixtures, model configuration, and evaluation protocol.
3. Page identity, annotation schema, transforms, and reducer tests.
4. Isolated ROI API and validated provider adapter.
5. ROI review UI end to end.
6. Penetration recommendations and review.
7. Outlet recommendations and editor adapter.
8. Review persistence/handoff and release hardening.

Decisions requiring confirmation at their phase gates:

- Phase 1: authoritative scope labels, included penetration/outlet categories, availability of the original JPEG, and actual model/project access.
- Phase 1/8: benchmark targets and tolerances; a bounding-box annotation task is not an exact roof-area measurement task.
- Phase 3/8: hosting, image retention, authentication, rate/cost limits, and supported provider settings.
- Phase 7: whether project annotations are handed off through local review documents or an agreed server/email integration.
- Phase 8: desktop-only pilot versus fully supported mobile workflow.

The branch is complete when all three annotation objectives are available at their intended New Build steps, users can correct and retain the results, annotations remain linked to the correct page and ROI, and the manual application remains usable without Gemini or the previous backend. No automatic perimeter or CAD-generation requirement is implied by completion of this plan.