# Phase 1 Reference And Evaluation

Date: 2026-09-09. Status: offline implementation available; live access and
domain adjudication remain open gates. This is development tooling, not an
annotation API or a frontend feature. It imports neither the legacy backend nor
the Colab export. The source notebook, Python export and reference PDFs are unchanged.

## Setup And Offline Commands

Run from the repository root. Verified with Python 3.13.13 on Windows. Keep this
environment separate from the existing backend environment; no activation is needed.

```powershell
py -3.13 -m venv backend/roi_reference/.venv
& ./backend/roi_reference/.venv/Scripts/python.exe -m pip install -r backend/roi_reference/requirements.lock
& ./backend/roi_reference/.venv/Scripts/python.exe -m pip check
& ./backend/roi_reference/.venv/Scripts/python.exe -m unittest discover -s backend/roi_reference_tests -v
& ./backend/roi_reference/.venv/Scripts/python.exe -m backend.roi_reference fixtures
& ./backend/roi_reference/.venv/Scripts/python.exe -m backend.roi_reference audit
```

The lock pins the complete clean-environment resolution, including
`google-genai==2.22.0`, `Pillow==12.3.0` and `pydantic==2.13.5`.
[requirements.in](../../backend/roi_reference/requirements.in) declares direct
dependencies. Regenerate the lock deliberately in a clean environment after a
reviewed dependency change. Other Python/OS combinations need validation.

The fixture command validates nine sanitized, **synthetic contract fixtures**.
These test response handling, not whether Gemini sees objects in a drawing.
No captured live response is being claimed as sanitized or independently verified.
The audit intentionally exits **2 (blocked)** while sources, labels, or category
approval are missing. Normal tests never load credentials or call a provider.

## Reference Inputs And Profiles

The original `TP17202_25.01_input.jpg` was not found in the local reference
directory/sample search. It is explicitly recorded as unavailable. The supplied
PDF is available locally, but is not the notebook JPEG. A PNG exported from a
pristine PDF.js page is a `pdfjs_page` derivative, never an exact reproduction.
The runner accepts single-frame PNG/JPEG only; it does not render PDFs, OCR,
trace boundaries, crop regions, or import old extraction results.

The sample's reported two roof ROIs and two outlets are model recommendations,
not ground truth. There is no demonstrated positive penetration result in the
prototype. The manifest's tags are **collection targets**, not verified evidence.

[Configuration](../../backend/roi_reference/config.json) and
[the initial ROI prompt](../../backend/roi_reference/prompts/roof-roi-v1.txt)
are versioned. All profiles use exactly `gemini-3.6-flash`, temperature `0.5`,
aspect-preserving LANCZOS thumbnailing to at most 1024 pixels per side, and no
upscaling. The runner stores and sends the same RGB PNG bytes. Transparency is
composited on white, EXIF rotation other than identity is rejected, and no
second orientation transform is applied. PNG encoding is an explicit transport
choice, not a claim of identical notebook wire bytes or identical detections.

| Profile | Purpose | JSON / Thinking |
| --- | --- | --- |
| `reference` | Initial ROI comparison; original simple prompt and system wording | No structured-output setting; thinking omitted, **not disabled** |
| `json` | Explicit coordinate contract and structured-output compatibility experiment | JSON schema; thinking omitted |
| `json-minimal` | Separate thinking compatibility experiment | JSON schema and requested `MINIMAL`; not a claim that thinking is off |

The reference profile intentionally retains the prototype's implicit coordinate
assumption; strict parsing still enforces `[ymin, xmin, ymax, xmax]` in 0-1000.
The JSON profiles add that contract and drawing-text-as-data instructions.
Child tasks require a JSON profile and reviewed parent context. Their prompts
are draft evaluation variants, not production penetration/outlet wiring.
The third notebook ROI call is not adopted as another required processing stage.

SDK constructors and serialized requests were tested offline. Model availability
and supported deployment settings are **unverified**. A request that succeeds
only proves that the selected endpoint accepted those requested settings for
that run. It does not establish that thinking was disabled or quality was good.
No model substitution or automatic settings downgrade exists.

## Authorized Live Runs

Live runs require authorization to process the drawing with Google and to retain
private local artifacts. The command requires `--allow-live --max-calls 1`.
Each invocation makes at most one generation attempt, with SDK retries disabled,
a 60-second HTTP timeout, and at most 4096 output tokens. There is no batch loop,
automatic retry, follow-up request, or model-list/health call. Repeating a command
spends a new call budget. Set project billing quotas as an additional cost control;
the runner does not assert a dollar estimate for unverified model pricing.

Developer API: provide `GOOGLE_API_KEY` through the server process environment
using the approved secret mechanism. The API key's owning project must be
confirmed by the operator; this cannot be inferred safely from the key.
Vertex/service-account path: choose `--provider vertex`, set
`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION`, and use approved Application
Default Credentials. The paths use `v1beta` and `v1` respectively. No `.env`
file is automatically loaded and no secrets belong in command arguments,
browser variables, fixtures, logs, this manifest, or Git. Never paste credentials
into chat. Existing local environment files are not read or changed by setup.

After placing an authorized, unannotated raster in the ignored private directory:

```powershell
& ./backend/roi_reference/.venv/Scripts/python.exe -m backend.roi_reference run --image docs/roi-evaluation/private/sample.png --case-id tp17202-pdfjs-derivative --input-variant pdfjs_page --prepare-only
```

Inspect the prepared inference image and request before approving transmission.
Then an operator can explicitly perform the reference run:

```powershell
& ./backend/roi_reference/.venv/Scripts/python.exe -m backend.roi_reference run --image docs/roi-evaluation/private/sample.png --case-id tp17202-pdfjs-derivative --input-variant pdfjs_page --allow-live --max-calls 1 --max-output-tokens 4096
```

Use a separately authorized invocation with `--profile json`, then optionally
`--profile json-minimal`, to establish compatibility. Do not run all profiles
automatically. A 404 produces `model_unavailable`; 400 produces
`unsupported_request_or_settings`. Auth, refusal, timeout, malformed output,
and truncation are errors, not empty successful results. A valid `[]` means
`no_detections`, not proof of absence. A valid capped/output-limited result is
`partial`, exits 2, and cannot pass evaluation. Inspect it before budgeting any
follow-up; this version does not automate follow-ups.

Each generated run directory under the ignored
`backend/roi_reference/private/runs/` contains:

- `inference.png`: exactly the bytes supplied to the provider.
- `request.json`: source/inference hashes and sizes, input variant, prompts,
  schema/settings, configuration/prompt/SDK fingerprint, task, request ID,
  parent geometry/revision, API version and start time.
- `raw-response.json`: SDK response body fields without HTTP headers or request
  credentials, preserved before parsing; this is not a byte-for-byte HTTP capture.
- `response.txt`: unmodified non-thinking model text, including malformed text.
- `result.json`: parsed suggestions with application-assigned IDs, or a safe
  error code, plus completion state, elapsed time and available usage information.

Prepare-only and failed transport runs naturally have no provider response.
Oversized responses above 256 KiB are rejected rather than retained unboundedly.
Source files are unchanged. Input limits are 20 MiB and 40 million decoded pixels.
Keyboard interruption records unknown completion; a hard process termination may
leave request/image artifacts without a result. Do not assume cancellation avoided
billing. Private artifacts include drawing/model text and must not be committed.
Git ignore is not access control: this workspace is under OneDrive, so confirm
that its synchronization and access policy are authorized before live use. Remove
private artifacts after the agreed development review/retention period. No public
service, multi-user ownership, or production retention guarantee is implemented.

## Category And Label Policy

Draft policy version: `scope-policy-draft-v1`. A roof-domain reviewer must approve
or revise it before the evaluation gate can pass.

| Task | Included | Excluded / Ambiguous |
| --- | --- | --- |
| Roof ROI | Each distinct proposed flat-roof/tapered-insulation scope | Whole-sheet boxes without scope evidence; existing/pitched/out-of-scope roofs; separate rooflight ROI boxes |
| Penetration | `rooflight`, `vent`, `flue`, `access_hatch` with identifiable object extents | Arbitrary equipment, labels, outlets, and objects outside actual scope, even inside its rectangular ROI |
| Outlet | `internal_outlet`, `parapet_outlet`, `scupper` symbols serving an accepted ROI | Unrelated RWP labels/downpipes, label centroids, symbols serving another roof |

Boundary/adjacent outlets can belong to a roof; strict box containment is not a
membership test. Do not invent dimensions, holes, hydraulic design, or calibrated
confidence. Uncertain cases need reviewer adjudication before entering scored
ground truth. Include drawing-legend evidence and critical misses in the private
review record. If the policy changes, version the code/prompts/manifest together.

## Dataset Review And Evaluation

[manifest.json](manifest.json) is a collection/review manifest, **not a completed
benchmark**. Populate it with authorized real source images and independently
reviewed expectations. Do not set pending expectations to `[]` to make a gate pass.
Obtain multiple/disconnected and nonrectangular roofs, interior rooflights, tiny
vents, boundary outlets, dense notes, rotated pages, ambiguous scopes and negative
pages, including unmarked drawings. Each split also needs roof-positive pages
with no in-scope penetrations/outlets, not just pages without any roof.

For each case, provide a source-image SHA-256, relative `image_path`, document ID,
and explicit expectations for all three tasks. A target has `id`, `label`, and
`box_2d`; child targets also have a known `roi_id` and included `subtype`. Set
`review` to a domain reviewer ID, ISO `reviewed_on` date and policy version only
after adjudication. `expected: []` is an explicitly reviewed negative; `null`
means unresolved. Mark `status: reviewed` last. The sample must be adjudicated
independently, not auto-labelled from the notebook or a runner result.

Keep all pages/variants of one document in one split. Hold out documents before
prompt tuning; duplicate document IDs or source hashes across splits are rejected.
Held-out imagery and labels must not be used as prompt examples. Coverage tags
count only reviewed cases. The audit checks both splits for positive and negative
cases for every task. Missing images, mismatched hashes or missing reviews block
scoring. The original JPEG may remain explicitly unavailable without pretending
that a derivative reproduces it.

Child runs take `--parents` pointing to a private JSON document:

```json
{
  "source_sha256": "replace-with-the-actual-source-image-sha256",
  "revision": 1,
  "rois": [{"id": "roof-1", "box_2d": [100, 100, 400, 350]}]
}
```

Those example coordinates are synthetic. Use reviewer-approved ROI geometry,
not unreviewed model proposals. The runner verifies the source hash, revision,
IDs and boxes. Use `--task penetration --profile json --parents ...` or
`--task rainwater_outlet --profile json --parents ...` in separately budgeted runs.
No parent means child detection is inapplicable, not a model-negative example.

For scoring, use one configuration/profile and output-token budget across one
run set (use `json` for all three tasks). Place one run directory per applicable
case/task under a private evaluation-run directory. Keep repeated trials in
separate sets; duplicates, missing, failed or partial runs fail explicitly. For
child evaluation, parent IDs/boxes/order must match the independently reviewed
roof targets, so association scores measure conditioned detection.

```powershell
& ./backend/roi_reference/.venv/Scripts/python.exe -m backend.roi_reference evaluate --manifest docs/roi-evaluation/manifest.json --runs backend/roi_reference/private/evaluation-runs --split development --iou-threshold 0.5
```

The threshold shown is an example matching rule, **not a release quality target**.
The report identifies its deterministic greedy descending-IoU, same-subtype,
one-to-one matching rule and returns TP/FP/FN, pooled precision/recall, matched
overlaps, parent matches and matched center-position errors in 0-1000 units.
Duplicates count as false positives. Position/association metrics are conditional
on matched detections and must be read alongside recall. Tiny-outlet IoU is
unstable; missed tiny outlets still count as misses, and need domain review.
No automatic accuracy threshold, perimeter precision or release claim is inferred.

## Remaining Phase 1 Gates

- Authorized live generation on the actual selected model/project, with a parsed
  reference response and separately recorded JSON/thinking compatibility evidence.
- Roof-domain reviewer approval of the sample, authoritative scopes, subtype and
  outlet-symbol policy, including ambiguous associations.
- Authorized positive/negative real drawings and held-out labels for all tasks.
- Reviewed sanitization of any live responses before introducing public fixtures.

Offline checks do not satisfy these human/provider gates. Later API/session/UI
phases remain separate; the original manual frontend is unchanged.