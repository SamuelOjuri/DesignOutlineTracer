# Phase 4: ROI Review In New Build

Implemented on 2026-09-09. This is an opt-in, localhost-only assisted-annotation
slice verified with synthetic fixtures, not a detection-accuracy or production
release claim. The isolated Phase 3 public API contract is unchanged. The
provider-output compatibility and diagnostics follow-up is described below.

## Delivered Workflow

- With `VITE_ROI_ENABLED=true`, New Build uses
  `upload -> roi -> paint -> outlets -> details`. Additional PDFs enter their
  own ROI review step. Disabled builds retain the original four-step workflow.
- PDF rendering and page selection make no network requests. Detect explicitly
  uploads only the immutable selected-page PNG, discloses service/Gemini
  processing, then requests roof recommendations with the session identity.
- Loading, cancel, retry, structured failure, no-detections and partial-result
  states retain existing work. A partial response offers at most one explicit
  follow-up per upload incarnation. An expired follow-up requires a new run.
  Ordinary detection revalidates/reuploads the pristine page, so an expired page
  can be recreated without losing browser review state.
- Independent boxes use fractional `[ymin, xmin, ymax, xmax]` page coordinates.
  Zoom, pan and container resize are display transforms only. PDF.js effective
  rotation/crop is already in the source image; nothing rotates boxes again.
- The canvas and sidebar select the same annotation. Review supports accept,
  reject, bounded move/corner-resize, label and numeric correction, manual box
  drawing, deletion, and undo. Arrow keys edit a focused box/handle; Shift uses
  a larger increment. Escape cancels an unfinished gesture. The original box
  remains available separately. Review status uses text/icons and border style.
- A drawn manual region starts accepted; model proposals always start suggested.
  Repeated IDs are not added again. New near-overlapping proposals (IoU >= 0.8
  against current or original boxes) get a duplicate warning. Boxes covering
  >= 85% of the page get a scope warning, not rejection. These are review
  heuristics, not roof classification or confidence estimates.
- Accepted/current boxes appear as passive context in manual roof definition.
  Acceptance never fills the roof, creates holes, changes scale, or enables
  paint progression without a manually defined polygon. Filtering accepted
  boxes retains their review labels in the paint view.
- Leaving review, switching pages, cancellation and component unmount abort
  browser requests. Request/page/hash/revision guards reject late results.
  Provider-side work already sent can still finish and incur charges.

## Ownership And Limits

`useRoiSession` remains the page/revision owner. `useRoiDetection` owns the
explicit request lifecycle and page-bound feedback; it does not run inference
in an effect or renderer. `AnnotationOverlay` is a separate DOM layer over the
source canvas, reused read-only in `PaintBucketCanvas`. No inference image is
composited with annotations, and no physical units are inferred from boxes.

Review state remains in memory for the open New Build screen. Reloading or
leaving the screen loses it. Server images/cache expire under Phase 3 TTLs;
cancel/navigation does not delete uploaded images. No local storage, new email
fields, automatic penetration/cutout adapter or outlet acceptance adapter is
introduced. The existing external email payload is unchanged.

The ROI view was checked at 1600x1000 and 390x844, including nonblank source
pixels and sub-pixel overlay alignment. Its sidebar scrolls independently with
manual continuation kept visible. This does not certify the inherited upload,
paint, outlets or details screens as mobile-ready; the complete pilot remains
desktop-only. Authentication beyond localhost, domain review, provider data
processing approval, dependency advisories and bundle size are still open gates.

## Local Use

Use the isolated service startup and safety settings in
[Phase 3](Phase-3-Annotation-API.md). Keep `ROI_ALLOW_LIVE=false` until the exact
model/project and call budget are explicitly approved. An offline or unconfigured
service leaves manual regions and manual roof definition available.

In the frontend shell, using an unused port:

```powershell
$env:VITE_ROI_ENABLED = "true"
$env:VITE_ROI_API_BASE_URL = "http://127.0.0.1:8091"
npm run dev -- --host 127.0.0.1 --port 8083 --strictPort
```

Open `http://127.0.0.1:8083/new-build`. Include that exact origin in the service's
`ROI_ALLOWED_ORIGINS` environment before starting/restarting the API. For example,
`http://127.0.0.1:8081,http://127.0.0.1:8082,http://127.0.0.1:8083`.
Changing Vite environment flags requires restarting the frontend server.
Set `VITE_ROI_ENABLED=false` to remove review UI and all ROI networking.
Never put provider credentials in frontend environment variables.

## Invalid Model Responses

`malformed_output` means the provider stream or returned annotations failed
validation; it is not a successful empty detection. No new regions are added,
accepted work is retained, and manual roof definition remains available.
`truncated_output` means `MAX_TOKENS` was reported and the response could not be
parsed into valid annotations. Neither failure is automatically retried.

Offline regressions reproduced a compatibility issue: otherwise valid JSON in
a single Markdown fence was rejected with CRLF line endings, an uppercase
`JSON` marker, or no language marker. The parser now accepts those single-block
formats. It still rejects surrounding prose, multiple blocks, extra fields,
duplicate keys, invalid coordinates, and invalid child associations. Fractional
coordinates are preserved. The original failed live response was not captured,
so this does not establish that fencing caused that particular failure.

Backend warnings now identify the failure stage without model text, labels,
filenames, source hashes, images, prompts, credentials or authorization headers:

```text
roi_output_rejected request_id=diagnostic-example task=roof_roi code=malformed_output category=json_syntax finish=STOP response_chars=14
```

Categories distinguish `stream_candidate_count`, `stream_missing_finish`,
`stream_unexpected_finish`, `empty_text`, `json_syntax`, `json_structure`,
`annotation_fields`, `annotation_geometry`, `annotation_label`, and
`annotation_association`. `unspecified` is reserved for an uncategorized provider
error. `finish=unavailable response_chars=None` means the provider adapter did
not return a completed result; raw stream content is not logged. The public
error response remains `{error: {code, retryable}}`.

The API startup command does not enable automatic reload. Applying these backend
changes requires an intentional restart of the existing API process; restarting
also discards in-memory uploads/cache and resets call budgets. Do not start a
second listener on port 8091. Only restart for a further live test after approving
its processing/cost, and retain `ROI_MAX_ATTEMPTS=1`,
`ROI_MAX_CALLS_PER_SESSION=1`, and `ROI_MAX_TOTAL_CALLS=1`. The model and structured
output settings were not changed by this fix. A rejected provider response still
consumes the attempt, so `call_budget_exceeded` on retry is expected. Report the
`roi_output_rejected` diagnostic line for investigation, not raw response text
or environment secrets.

Follow-up verification: 39 offline backend tests and 26 focused frontend tests
pass, including CRLF-fenced output through the API, multi-chunk stream assembly,
safe categorized logs, unchanged error envelopes, retained accepted work, and
explicit-only retries. No live Gemini request was made to verify this fix.

## Notebook And App Scope Comparison

On 2026-09-10, the user supplied a successful notebook result with two separate
scope boxes for TP17202, while the app screenshot showed one broad recommendation
covering the roof plan. The app reported a successful response, so this is a
scope-selection discrepancy, not the earlier `malformed_output` failure.

The selected notebook ROI cell explicitly says:

```text
Do not return a box for the whole drawing sheet or the whole roof plan. Return only the specific proposed flat roof / tapered insulation scope area(s).
```

The app's `roof-roi-v1` only excluded unrelated drawing-sheet content and omitted
that explicit whole-roof restriction. `roof-roi-v2.txt` restores the quoted
instruction while preserving independent scopes, rooflight handling and the
distinction between working boxes and exact geometry. `PROMPT_VERSIONS` now
selects v2; v1 and the notebook remain unchanged. No fixed number of roofs,
sample-specific coordinates, color heuristic or size-based rejection was added
to detection logic. Run provenance reports `roof-roi-v2`, and cache identity
already includes both prompt version and prompt hash.

Other request differences remain deliberately visible:

| Input Or Setting | Notebook | App |
| --- | --- | --- |
| Source image | Local JPEG, observed 2482x1755 | Pristine PDF.js page raster uploaded as PNG |
| Preparation | Aspect-preserving LANCZOS thumbnail; observed 1024x724 | Aspect-preserving LANCZOS thumbnail, maximum side 1024, white RGB PNG |
| Model / temperature | `gemini-3.6-flash` / 0.5 in the supplied ROI cell | Same configured model / 0.5 |
| Instructions / output | Notebook system text and explicit safety setting; no output-token cap in the shown call | App system safeguards, strict schema validation, configured output-token cap, optional structured output, streamed response |

The notebook's JPEG is now available locally, but the two requests' exact input
pixels and complete provider outputs have not been compared. Model variability
also remains possible. Restoring the missing instruction is not proof that it
alone caused the broad box or that the revised prompt produces correct live
results. Do not weaken the app's system safeguards to make the calls identical.

Offline verification: a mocked SDK-wire test failed for v1's missing instruction
and passed after selecting v2. Replaying the two box coordinates visible in the
notebook screenshot through a fake provider preserves two distinct suggested
annotations, their original geometry and cached IDs. This is a response-handling
fixture, not a detection-accuracy test or adjudicated architectural ground truth.
All 41 backend tests and 15 focused client/reconciliation tests pass.

An intentional API restart is needed to load v2 and resets the in-memory call
budget. For an approved live retest, keep the one-attempt limits and check the
detection response's `prompt_version` is `roof-roi-v2`. Reruns preserve existing
annotations: reject or delete the earlier broad proposal when comparing the new
suggestions. The assistant did not restart the server, modify budgets, execute
the notebook or make a live Gemini request for this comparison.

## Verification

```powershell
npm test
npm run test:e2e:roi
npm run test:e2e
npm run typecheck
npm run build -- --outDir .vite/roi-phase4-build
npm run lint
```

The ROI suite uses its own Vite server on port 4181, with the feature enabled
and every annotation request mocked. Set `PLAYWRIGHT_ROI_PORT` to another unused
port when necessary. The existing suite stays disabled on port 4180. Both use
the external-network guard; only the deliberately mocked 503 console message is
allowlisted in the failure test. No real email, private drawing or Gemini call
is made. Synthetic boxes are not ground truth for architectural detection.

Initial Phase 4 verification: 66 unit tests, 3 ROI browser flows, 2 manual browser flows, app/test
type-check, build and lint (0 errors, 9 inherited warnings). Browser coverage
includes source-image hash/byte equality on rerun, separate regions, acceptance
without paint, move/resize/undo/numeric corrections, zoom/scroll alignment,
manual-region delete/undo, no-detections/partial/offline/retry/rejected-all, and
delayed responses after cancel/page switch. Owner tests cover additional-page
routing, drawing-scale independence and restoration of annotations/manual work.
Screenshots are written under `test-results/`; reports and build outputs remain
ignored. Phase 5/6 production child wiring must wait for review of this slice.