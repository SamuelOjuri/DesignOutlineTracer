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

Use a paid Python web service with a persistent disk mounted at `/var/data`,
one service instance and one Uvicorn worker. The Blueprint includes a paid
compute plan and a 1 GB disk; review the plan in Render before creating it.
Image preparation and cached uploads require sufficient memory.

Run both commands from the repository root:

```sh
pip install --require-hashes -r backend/app/requirements.lock
uvicorn backend.app.main:app --host 0.0.0.0 --port "$PORT" --workers 1
```

Set the health check path to `/api/roi/v1/health`. Set these environment variables
on the Render web service:

| Variable | Value |
| --- | --- |
| `ROI_DEPLOYMENT_MODE` | `public` |
| `ROI_ALLOWED_ORIGINS` | Your exact frontend origin, e.g. `https://your-app.netlify.app` |
| `ROI_STATE_PATH` | `/var/data/roi.sqlite3` |
| `ROI_ALLOW_LIVE` | `true` to enable the existing Gemini features |
| `GOOGLE_API_KEY` | Your server-side Gemini credential |
| `ROI_MODEL` | The existing selected model, with access verified for this credential |

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

`GET /api/roi/v1/health` returns `mode: public` and needs no bearer token.
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
only on Render: `VITE_*` settings are included in public browser JavaScript.
Project email submission remains controlled by the existing
`VITE_ENABLE_SEND_TO_TAPEREDPLUS` switch and Supabase Edge Function; configure
and verify that integration separately before enabling it.

Requests go directly from the browser to Render. Do not route detection through
a Netlify Function or a Netlify API proxy. The existing backend timeout is
900 seconds, and the browser deadline is 930 seconds. Render documents support
for HTTP responses lasting up to 100 minutes, so the existing request/response
workflow can remain in place.

## Storage, budgets and restarts

Public mode requires durable SQLite state. It retains unexpired uploaded images,
their contexts, hashed owners, completed operation results and call counters.
The database never contains the provider credential or raw browser bearer token.
Expiry and explicit deletion remove active records. Treat the disk and provider
backups as containing uploaded drawing data.

Keep one worker and one instance: the state store takes a single-writer lock and
fails startup if another process is already using the same file. This deployment
does not support horizontal replicas. Render persistent disks are attached to a
single instance and cause brief downtime during redeploys. A restart cannot
resume an in-flight Gemini call. Interrupted request IDs return an explicit
error rather than starting a second paid call; initiate a new detection after
the deployment finishes. Completed request IDs can be replayed while retained.

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
