# Production deployment: Netlify and Render

Deploy the frontend from `main` on Netlify and the active FastAPI package
`backend/app` from `main` on Render. There is no sign-in screen or user account
requirement. The client generates a random bearer token to keep one anonymous
client's uploaded pages separate from another client's pages. This token is not
a shared API key and is not user authentication.

The repository includes `netlify.toml` and `render.yaml`. These files configure
deployments; they do not deploy anything until connected through the providers.
For an existing Render service, apply the equivalent settings to that service
rather than unintentionally creating a second backend from a Blueprint.

## Render backend

Use a paid Python web service, one service instance and one Uvicorn worker.
The Blueprint includes a paid compute plan and uses Supabase Postgres plus
private Storage for durable state, without a Render disk. Complete
[Supabase setup](Supabase-Setup.md) before starting it. Image preparation and
cached uploads require sufficient memory.

Run both commands from the repository root:

```sh
python -m pip install --require-hashes -r backend/app/requirements.lock
python -m uvicorn backend.app.main:app --host 0.0.0.0 --port "$PORT" --workers 1 --no-access-log
```

Set Render's health check path to `/healthz`. Set these environment variables
on the Render web service:

| Variable | Value |
| --- | --- |
| `ROI_DEPLOYMENT_MODE` | `public` |
| `ROI_ALLOWED_ORIGINS` | Your exact frontend origin, e.g. `https://your-app.netlify.app` |
| `ROI_STORAGE_BACKEND` | `supabase` |
| `SUPABASE_URL` | Your Supabase project HTTPS origin |
| `SUPABASE_SECRET_KEY` | Your server-only Supabase secret key |
| `DATABASE_URL` | PostgreSQL direct or session pooler URI on port 5432 |
| `ROI_STORAGE_BUCKET` | Your private bucket name, normally `roi-pages` |
| `ROI_ALLOW_LIVE` | `true` to enable the existing Gemini features |
| `GOOGLE_API_KEY` | Your server-side Gemini credential |
| `ROI_MODEL` | The existing selected model, with access verified for this credential |

Keep the Root Directory blank so both commands run from the repository root.
The checked-in `.python-version` selects Python 3.13; remove an older
`PYTHON_VERSION` environment override if present. Render supplies `PORT`.
The required PostgreSQL migration is
[`20261104180000_roi_private_state.sql`](../supabase/migrations/20261104180000_roi_private_state.sql).
The application checks the schema and private bucket at startup; it does not
apply SQL migrations or create buckets automatically. New `sync: false` values
must be added manually to an existing Render service.

Before the first API deployment, use the local check below to prepare the schema.
Once the service is running, the Render Shell equivalent checks the configured
private bucket, SSL database connection and required tables without creating
application state or making a model call:

```sh
python -m backend.scripts.check_supabase_storage
```

If the required ROI tables are missing, review the checked-in migration, then
apply it explicitly and rerun the check:

```sh
python -m backend.scripts.check_supabase_storage --apply-migration
python -m backend.scripts.check_supabase_storage
```

The apply flag changes only the application's private ROI schema/tables and
their permissions. It does not upload bucket objects or create model calls.
For a local Windows checkout with the root `.env`, the equivalent read-only
check is:

```powershell
& ./backend/app/.venv/Scripts/python.exe -m backend.scripts.check_supabase_storage --env-file .env
```

Add `--local-only` to validate values without network requests, or the explicit
`--apply-migration` flag to apply the reviewed migration. The checker hides
credentials. Replace the four descriptive placeholders in `.env.example` with
actual project/key/connection/bucket values; those labels are not Render values.

Origins are comma-separated if you use both a Netlify hostname and a custom
domain. Use HTTPS origins without trailing slashes or URL paths. List specific
preview origins separately when needed; arbitrary Netlify preview sites are
not allowed automatically. Public configuration rejects wildcards and local
HTTP origins.

By default, the public-mode API trusts its Render hostname from
`RENDER_EXTERNAL_HOSTNAME` in addition to loopback hosts. For a custom API
domain, set `ROI_ALLOWED_HOSTS` explicitly, e.g.
`your-api.onrender.com,api.example.com`. Host entries are hostnames, without
schemes, ports or paths.

`GET /healthz` is Render's deployment health endpoint. A new instance checks its
credentials, private bucket and schema before becoming healthy. During Render's
deployment overlap it can wait in standby while the previous instance still
holds the writer lock. Its API responds with temporary HTTP 503 and `Retry-After`
until Render retires the previous instance and the new one acquires the lock,
restores the latest snapshot and becomes active. This avoids writing stale state.
If activation does not finish within five minutes, the health check fails.
Do not configure Render to use the API readiness endpoint for this handover.

The frontend retries `storage_unavailable` and `storage_starting` responses
automatically for up to one minute, honouring `Retry-After` (capped at 10 seconds)
and resending the same request ID. While it waits, the assisted panels show "The
service is restarting after an update. Retrying automatically...". If the API is
still unavailable after that window, they ask the user to try again in a minute.
Cancel stops the wait immediately.

Once active, `GET /api/roi/v1/health` returns `mode: public` and needs no bearer token.
`status: ready` means the provider is configured; it does not perform a paid
model call or verify that the credential has access to the selected model.
All page mutation requests still use the automatically generated page-ownership
token. CORS restricts browser origins; it does not restrict non-browser callers.
The public API intentionally has no user authentication.

## Netlify frontend

Connect this repository, select `main` as the production branch, and keep the
base directory at the repository root. `netlify.toml` sets the build command,
publishes `dist`, and rewrites frontend routes to `/index.html`, including
refreshes of `/new-build` and `/refurbishment`.

Set these build-time environment variables in Netlify:

```text
VITE_ROI_ENABLED=true
VITE_ROI_API_BASE_URL=https://your-api.onrender.com
VITE_ROI_DETECTION_TIMEOUT_MS=930000
VITE_ENABLE_SEND_TO_TAPEREDPLUS=false
```

The API URL is an origin only, without `/api/roi/v1` or a trailing path.
Rebuild the frontend after changing a `VITE_*` value. Keep `GOOGLE_API_KEY`
and the Supabase secret/database credentials only on Render: `VITE_*` settings
are included in public browser JavaScript.
Project email submission remains controlled by the existing
`VITE_ENABLE_SEND_TO_TAPEREDPLUS` switch and Supabase Edge Function; configure
and verify that integration separately before enabling it.

Requests go directly from the browser to Render. Do not route detection through
a Netlify Function or a Netlify API proxy. The existing backend timeout is
900 seconds, and the browser deadline is 930 seconds. Render documents support
for HTTP responses lasting up to 100 minutes, so the existing request/response
workflow can remain in place.

## Storage, budgets and restarts

Public mode requires durable state. The recommended `supabase` backend stores
contexts, hashed owners, completed operation results and call counters in a
private PostgreSQL `roi` schema, with original/prepared images in a private
Storage bucket. Expiry and explicit deletion remove active records and schedule
object deletion. The state never contains provider credentials or raw browser
bearer tokens. Treat database and Storage backups as containing drawing data.

Keep one worker and one instance: the Supabase state store holds a PostgreSQL
session advisory lock. A replacement instance enters validated standby while
the previous process owns that state, and serves no application requests until
it acquires the lock and loads a fresh snapshot. Temporary API 503 responses
during this deployment handover are expected; retry after activation. Use the
session pooler on port 5432 or a direct connection,
not the transaction pooler on 6543. This deployment does not support horizontal
replicas. A restart cannot resume an in-flight Gemini call. Interrupted request IDs return an explicit
error rather than starting a second paid call; initiate a new detection after
the deployment finishes. Completed request IDs can be replayed while retained.

`ROI_STORAGE_BACKEND=auto` selects Supabase when all three Supabase credential
settings are supplied, otherwise SQLite when `ROI_STATE_PATH` is set, otherwise
memory for local development. Partial Supabase configuration fails startup.
For the previous SQLite deployment, explicitly set `ROI_STORAGE_BACKEND=sqlite`
and `ROI_STATE_PATH=/var/data/roi.sqlite3`, with a real persistent disk mounted at
`/var/data`. Do not remove an existing disk until its retained data is no longer
needed. Selecting Supabase starts a separate state store; existing SQLite pages
and completed operations are not automatically imported.

For a local root `.env`, start Uvicorn with `--env-file .env`. On Render set
credentials in the service environment; the production start command does not
load a committed environment file.

Existing limits remain configurable: upload size, retained bytes, sessions,
pages, concurrency and per-session model calls. `ROI_MAX_TOTAL_CALLS` defaults
to 100 calls per `ROI_CALL_BUDGET_WINDOW_SECONDS` (default 86400 seconds).
The budget survives restarts and counts calls within a rolling window: each
call stops counting after 86400 seconds by default. Retries consume calls too.
Without a login, anyone able
to call the public API can consume this shared budget.

## Verification and rollout

Run offline checks before pushing deployment changes:

```sh
npm test
npm run typecheck
npm run build
venv/Scripts/python.exe -m pytest backend/roi_tests
```

After configuring the providers, verify the public health response and refresh
`/new-build` directly. Upload a non-sensitive sample drawing, then run detection,
outline generation and outlet detection. Verify that another fresh browser
session cannot access the first session's uploaded pages. Restart Render and
verify unexpired uploaded-page access and completed response replay. Recheck
provider access with one intentional live model call; the offline tests use
fixtures and do not call Gemini.

## Provider references

- [Netlify Vite builds](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/)
- [Netlify SPA rewrites](https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/)
- [Render port binding](https://render.com/docs/web-services#port-binding)
- [Render persistent disk restrictions](https://render.com/docs/disks)
- [Render long-running HTTP requests](https://render.com/docs/render-vs-vercel-comparison)
- [Supabase connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- [Supabase backend secret keys](https://supabase.com/docs/guides/getting-started/api-keys)
