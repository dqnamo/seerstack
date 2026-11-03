# Architecture

One Cloudflare Worker (Hono) at https://seerstack.com. Projects live in D1, OAuth state in KV, and events in one Tinybird datasource. The only UI is the OAuth consent page.

```mermaid
flowchart LR
  browser["Your sites<br/>(/s.js + public key)"] -- "POST /e" --> worker
  servers["Your backends"] -- "POST /e + secret key" --> worker
  agents["Agents<br/>(Claude, Cursor…)"] -- "/mcp + OAuth token" --> worker
  worker["seerstack Worker"] -- "projects, keys" --> d1[("D1")]
  worker -- "OAuth clients, grants, tokens" --> kv[("KV")]
  worker -- "Events API<br/>seerstack_ingest (APPEND)" --> tb[("Tinybird<br/>events")]
  worker -- "Query API /v0/sql<br/>seerstack_read (READ)" --> tb
  worker -. "sign-in" .-> gh["GitHub OAuth"]
```

## Routes

`src/index.ts` exports an `OAuthProvider`. Requests to `/mcp` with a valid token go to `mcpHandler`. The provider itself answers `/token`, `/register` and the `/.well-known/oauth-*` discovery documents. Everything else goes to the Hono app.

- `GET /s.js`: the tracker (`src/tracker.ts`). It sends pageviews on load and on `pushState`/`popstate`, and exposes `window.seerstack.track/identify`. It reads the public key from `data-key`. By default it stores nothing; with `data-persist` it keeps a random visitor ID in localStorage and sends it as `anonymous_id` (ADR 0008).
- `POST /e`: ingest. Takes one event, or `{ batch: [...] }` up to 500.
  - A bearer header means a server event: the key is resolved as a secret key.
  - Otherwise it's a browser event: the public key comes from `key` in the body, and the Origin must match the project's domains.
  - The body is parsed as JSON whatever the Content-Type (beacons send `text/plain` to avoid a CORS preflight). `src/normalize.ts` turns events into rows.
  - Browser rows are written in `waitUntil`. Server rows are awaited, so a Tinybird failure returns 502.
- `GET/POST /authorize` and `GET /callback`: OAuth sign-in for MCP clients (`src/auth.ts`).
  1. The consent page shows the client's name and where the token goes.
  2. Allow redirects to GitHub with PKCE.
  3. The callback completes only for `ALLOWED_GITHUB_USER_ID`.
  - The library's `beginConsent`/`approveConsent`/`beginUpstream`/`finishUpstream` bind each step to the browser.
- `/mcp`: a stateless Streamable HTTP MCP server (`src/mcp.ts`), with a fresh server per request. `mcpHandler` re-checks the GitHub ID in the token's props.

## Projects

`src/projects.ts` reads and writes the D1 `projects` table (`migrations/`). Public keys are stored as-is, secret keys as SHA-256 hashes. Key lookups on ingest are cached per isolate for 60 s.

## Querying

- Prebuilt tools (`overview`, `timeseries`, `breakdown`, `list_events`, `funnel`, and activity in `list_projects`) are in `src/analytics.ts`. Each builds a Tinybird template: the SQL starts with `%`, and every value is a `{{String(pN)}}` placeholder that Tinybird binds from form params. Only allowlisted column names and validated integers are inlined.
- `run_sql` runs agent-written SQL. `src/sql-guard.ts` checks it (single SELECT/WITH, no SETTINGS/FORMAT/INTO/system tables/external table functions), then wraps it with caps of 10,000 rows, 10 s and 1 GB.
- Both use the `seerstack_read` token, which can only read `events`.

## Tinybird

- Datafiles: `tinybird/datasources/events.datasource` (Forward CLI, `tinybird.config.json` at the repo root).
- The datasource defines two static tokens: `seerstack_ingest` (APPEND) and `seerstack_read` (READ).
- Storage: MergeTree, partitioned by month, sorted by `(project_id, event, timestamp)`. Duplicates aren't collapsed.

## Config

- `wrangler.jsonc`:
  - Bindings: `DB` (D1 `seerstack`) and `OAUTH_KV`.
  - Vars: `TINYBIRD_HOST`, `GITHUB_CLIENT_ID`, `ALLOWED_GITHUB_USER_ID`.
  - Custom domain: `seerstack.com`.
- Secrets: `TINYBIRD_INGEST_TOKEN`, `TINYBIRD_READ_TOKEN`, `ANON_SALT`, `GITHUB_CLIENT_SECRET`.
- Production:
  - Cloudflare account jp@interface.london (the zone and the Worker).
  - Tinybird workspace `seerstack` (europe-west2).
  - GitHub OAuth App "Seerstack" with callback https://seerstack.com/callback.
  - `ANON_SALT` is also kept in the gitignored `.env.production`.
- Local dev reads `.dev.vars`, which points at Tinybird Local on `:7181`. Run `wrangler d1 migrations apply seerstack --local` first.
