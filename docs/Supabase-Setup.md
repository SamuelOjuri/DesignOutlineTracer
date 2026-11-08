# Supabase setup for the Render backend

The browser continues to call the Render API without a user login. Render uses
Supabase Postgres for ROI metadata/call budgets and private Supabase Storage for
uploaded page images. Supabase Auth is not required for this flow. The backend
keeps the existing random session-token ownership checks.

## 1. Prepare the project

Create or select a Supabase project in a region close to the Render API. Save
its database password securely. A new project keeps this ROI state separate
from any Supabase project already used for the email Edge Function.

## 2. Create a private bucket

In the project's **Storage** section, create a bucket named `roi-pages` (or use
your chosen name consistently in `ROI_STORAGE_BUCKET`). Leave **Public bucket**
off. Set allowed MIME types to `image/png` and `image/jpeg`. A per-file limit of
25 MB covers the default API source limit of 20 MiB (20,971,520 bytes). If you
increase `ROI_MAX_UPLOAD_BYTES`, increase the bucket/project limit accordingly.

Original PDFs remain in the browser. The API receives rendered PNG/JPEG page
images and stores those original bytes plus a prepared inference PNG whose
maximum dimensions are 1024 by 1024. Keep this bucket private; no public or
anonymous upload/download policy is needed. The backend's secret key supplies
Storage access, while the application checks anonymous page ownership.

## 3. Apply the application migration

Open the project's **SQL Editor**, create a new query, and run the exact contents
of [`20261104180000_roi_private_state.sql`](../supabase/migrations/20261104180000_roi_private_state.sql).
Review the checked-in SQL before applying it. It creates the application's
private `roi` schema/state tables and does not change Auth, the email Edge
Function, or unrelated application tables. It does not create the Storage
bucket. Keep `roi` out of the Data API's exposed schemas.

The API validates its database schema when it starts; it does not run schema
migrations itself. Do not substitute invented tables or an empty database.
Alternatively, use the explicit migration command below after preparing the
connection settings.

## 4. Collect the backend connection settings

From the project's **Connect** dialog or **Settings > API Keys**, copy the
project URL and a backend secret key (`sb_secret_...`). Keep this key on Render,
never in Netlify, browser code or a `VITE_*` variable. The Postgres database
password is separate from this API key.

In **Connect**, choose **Session pooler** and copy the complete PostgreSQL URI
on port 5432. Replace `[YOUR-PASSWORD]` with the percent-encoded database
password. Copy the actual host and username from the dialog; the pooler username
usually includes the project reference. Add `sslmode=require` to the query
string (`?sslmode=require`, or `&sslmode=require` if a query already exists).
The adapter requires encryption; stronger `verify-ca`/`verify-full` modes can be
used with the appropriate trusted CA configuration.

Session pooling supports the long-lived connection/advisory lock used by the
state store. Do not use transaction pooling on port 6543. A direct port-5432
connection also works when reachable from Render; the default direct Supabase
endpoint requires IPv6 unless the project has the IPv4 add-on.

After installing the locked backend dependencies, put the four real backend
values in the root `.env`. The labels in `.env.example` (`Project URL`, `Backend
secret key`, `Postgres connection URI`, and `ROI storage bucket name`) are
placeholders, not working values. Do not copy those labels into Render.

From the repository root, validate configuration without network access:

```powershell
& ./backend/app/.venv/Scripts/python.exe -m backend.scripts.check_supabase_storage --env-file .env --local-only
```

Then check the private bucket, encrypted database connection and required tables:

```powershell
& ./backend/app/.venv/Scripts/python.exe -m backend.scripts.check_supabase_storage --env-file .env
```

The checker reports Storage bucket access and Postgres connectivity/schema
separately. Both checks run even if one fails, and the command exits with code 1
if either fails. Schema checks verify the required columns and read permissions
as well as table existence. It prints no credential values, creates no
application state and makes no model calls. If it reports that the ROI schema
is missing, apply the reviewed private migration explicitly:

```powershell
& ./backend/app/.venv/Scripts/python.exe -m backend.scripts.check_supabase_storage --env-file .env --apply-migration
```

The apply flag runs only the checked-in migration for the private ROI tables and
their permissions. It does not create bucket objects, snapshots or model calls.
If the private bucket check fails, the migration is skipped and only read-only
database checks run.
Run the read-only check again after applying it. If using another active virtual
environment containing the locked backend dependencies, use its `python` instead.

## 5. Set the Render environment

Use the following backend-only settings in the existing Render Python service:

```text
ROI_STORAGE_BACKEND=supabase
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SECRET_KEY=YOUR-BACKEND-SECRET-KEY
DATABASE_URL=YOUR-POSTGRES-SESSION-POOLER-URI
ROI_STORAGE_BUCKET=roi-pages
ROI_DEPLOYMENT_MODE=public
ROI_ALLOWED_ORIGINS=https://YOUR-SITE.netlify.app
ROI_ALLOW_LIVE=true
GOOGLE_API_KEY=YOUR-GEMINI-KEY
```

Use an origin-only `SUPABASE_URL` without a trailing slash. Origin lists use
exact HTTPS frontend origins, without paths or trailing slashes. Enter raw
values in the Render UI without surrounding quote characters. Keep one worker
and one instance. The checked-in `render.yaml` defines these settings and no
longer requires a persistent Render disk for the Supabase backend.
Set Render's **Health Check Path** to `/healthz`, which supports the deployment
handover described below. Keep `/api/roi/v1/health` for browser/API readiness.

When updating an existing service, add the four Supabase settings manually;
`sync: false` Blueprint values are only prompted for on initial setup. If a
root `.env` holds these values during local development, load it explicitly:

```powershell
& ./backend/app/.venv/Scripts/python.exe -m uvicorn backend.app.main:app --env-file .env --host 127.0.0.1 --port 8080 --workers 1 --no-proxy-headers --no-access-log
```

Use local origins/local deployment mode for a local server. Existing process
environment values take precedence over an environment file. `auto` storage
selection uses Supabase when all credentials are supplied; partial credentials
fail startup. Explicit `sqlite` remains available for the previous deployment.

In a Render Shell, use its Python and service environment; no local `.env` file
is needed:

```sh
python -m backend.scripts.check_supabase_storage
# Only when the reviewed migration has not already been applied:
python -m backend.scripts.check_supabase_storage --apply-migration
```

Storage failures in the Render application logs include a diagnostic line before
the generic startup or `storage_unavailable` error. For example:

```text
roi_storage_failure operation=initialize stage=postgres_connect exception_type=InvalidPassword http_status=none sqlstate=28P01
roi_storage_failure operation=save stage=storage_object_upload exception_type=HTTPStatusError http_status=503 sqlstate=none
```

`stage` identifies the failed operation: connection/session setup, schema
preflight, writer ownership, snapshot commit, or a Storage bucket/object request.
`exception_type` preserves the original exception class; `http_status` and
`sqlstate` contain the HTTP status and PostgreSQL error code when available,
otherwise `none`. Exception messages, SQL, credentials, URLs, object keys and
response bodies are excluded. The checker uses the same diagnostic fields.

Only the first terminal failure per store is logged with these details; later
cleanup retries retain the existing availability warning. An outbox deletion
failure logs `roi_storage_retry` at warning level and is retried without making
the store unhealthy. Normal writer-lock contention during deployment remains
standby rather than a storage failure. Recovery still requires a fresh process
after a terminal failure; diagnostics do not reconnect a lost writer session.

## 6. Verify after deployment

Check the Render logs for successful activation and open
`https://YOUR-API.onrender.com/api/roi/v1/health`. Once active it should report `mode: public`.
`status: ready` confirms provider configuration, not model access; verify a
single intentional live detection with a non-sensitive sample drawing.

Upload a sample page and run detection. Confirm that images appear under the
`roi-state-v1/` namespace in the private bucket, restart Render, and verify that
the unexpired page/completed operation can still be read by its original
anonymous client. Verify deletion and expiry cleanup and that another browser
session cannot access that page. Do not put backend credentials into inspection
commands, screenshots or logs.

During redeployment, `/healthz` becomes healthy after the replacement instance
validates its credentials, private bucket and schema, even while the previous
instance still owns the writer lock. The replacement API returns temporary
503 responses with `Retry-After` until Render retires the previous instance.
It then acquires the lock, restores the latest state and starts serving API
requests. Activation has a five-minute limit; afterward deployment health fails.
This handover supports overlapping Render deployments without stale writes;
continue to use one worker and one instance.

Selecting this backend starts a separate Supabase store; existing SQLite
sessions/pages are not automatically imported. Keep the old disk until those
temporary pages have expired or a deliberate migration is performed. Completed
and failed operation IDs are retained while their session/page is live; an
in-flight Gemini call cannot resume across a restart. The single-writer lock
does not add horizontal scaling.

## References

- [Supabase bucket creation](https://supabase.com/docs/guides/storage/buckets/creating-buckets)
- [Private bucket access](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- [Backend secret keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Database connections and session pooling](https://supabase.com/docs/guides/database/connecting-to-postgres)
