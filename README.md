# Seerstack

Web and product analytics for all my projects, with no dashboard. One Cloudflare Worker at https://seerstack.com takes events and stores them in Tinybird. Agents create projects and query the data over MCP, signing in with GitHub.

```
your sites ──/s.js + public key──► POST /e ─┐
your servers ───────secret key───► POST /e ─┼──► seerstack Worker ──► Tinybird (events)
agents ─────────────OAuth────────► /mcp ────┘          │
                                                       └──► D1 (projects, keys)
```

## Connecting an agent

```bash
claude mcp add --transport http seerstack https://seerstack.com/mcp
```

The first time a tool is used, Claude opens a browser. Allow the app on Seerstack's consent page, then sign in with GitHub. Only the owner's GitHub account gets in. For claude.ai or Claude Desktop, add `https://seerstack.com/mcp` as a custom connector.

## Tracking a site or app

Ask your agent, e.g. _"Create a Seerstack project for saintdex.com"_. It calls `create_project` and gets back:

- **A script tag** with the project's public key. Paste it into the site's `<head>`:

  ```html
  <script defer src="https://seerstack.com/s.js" data-key="pk_…"></script>
  ```

  Pageviews are tracked automatically, including SPA navigations, with no cookies. For custom events:

  ```js
  window.seerstack?.track("signup_clicked", { plan: "pro" });
  window.seerstack?.identify(user.id, { plan: "pro" }); // links today's anonymous visits to the user
  ```

  By default nothing is stored in the browser, so visitors are counted per day. Add `data-persist` to the tag to recognise returning visitors across days: it keeps a random ID in localStorage (browser storage, which EU/UK rules treat like a cookie).

  Only the project's domains (and subdomains) can send browser events. To test locally, add `localhost` to the domains and `data-allow-localhost` to the tag. To exclude your own browser, run `localStorage.seerstack_ignore = "1"`.

- **A secret key** (`sk_…`, shown once) for server-side events:

  ```bash
  curl -X POST https://seerstack.com/e \
    -H "Authorization: Bearer $SEERSTACK_SECRET_KEY" \
    -d '{"event":"purchase","user_id":"u_123","properties":{"plan":"pro","amount":49}}'
  ```

  Send up to 500 events at once with `{"batch":[...]}`. Server events may set `timestamp` (ISO or ms) for backfills, plus `anonymous_id` and `event_id`.

## Tools

| Tool                                | What it does                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------- |
| `list_projects`                     | Projects, their domains and public keys, and the last 30 days of activity                     |
| `create_project` / `update_project` | Start tracking a site, or change its name or domains                                          |
| `rotate_keys`                       | Replace a project's public key, secret key, or both                                           |
| `overview`                          | Visitors, pageviews, sessions, bounce rate, session length, compared with the previous period |
| `timeseries`                        | Visitors and counts per hour, day, week or month for any event                                |
| `breakdown`                         | Top pages, sources, UTMs, countries, devices, events, or any `properties.<key>`               |
| `list_events`                       | Which events a project sends, and their property keys                                         |
| `funnel`                            | Step-by-step conversion, linking anonymous visits to signups                                  |
| `get_schema` / `run_sql`            | Anything else, in read-only ClickHouse SQL                                                    |

## Deploying from scratch

You need Tinybird (`tb`), Cloudflare (`wrangler`) and a GitHub OAuth App whose callback URL is `https://<your domain>/callback`.

```bash
pnpm install
```

```bash
tb login && tb --cloud deploy
```

```bash
pnpm exec wrangler d1 create seerstack
```

```bash
pnpm exec wrangler kv namespace create OAUTH_KV
```

Put the D1 and KV IDs, your Tinybird region, the GitHub app's client ID and your GitHub user ID (`gh api user --jq .id`) into `wrangler.jsonc`, along with your domain in `routes` and in `PUBLIC_URL` in `src/index.ts`. Then set the secrets. The two Tinybird tokens are the full values of `seerstack_ingest` and `seerstack_read`, and `ANON_SALT` is any long random string.

```bash
pnpm exec wrangler secret put TINYBIRD_INGEST_TOKEN
```

```bash
pnpm exec wrangler secret put TINYBIRD_READ_TOKEN
```

```bash
pnpm exec wrangler secret put ANON_SALT
```

```bash
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
```

```bash
pnpm exec wrangler d1 migrations apply seerstack --remote
```

```bash
pnpm run deploy
```

## Local development

```bash
tb local start && tb build
```

```bash
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` with the local tokens from `tb token copy seerstack_ingest` and `tb token copy seerstack_read`, then:

```bash
pnpm exec wrangler d1 migrations apply seerstack --local
```

```bash
pnpm dev
```

```bash
pnpm test
```

How it works and why: [`.context/`](.context/README.md).
