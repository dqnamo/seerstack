# Seerstack

Web and product analytics for all my projects, with no dashboard. One Cloudflare Worker takes events and stores them in Tinybird, and agents query them over MCP.

```
your sites ──/s.js──► POST /e ─┐
your servers ──────► POST /e ──┼──► seerstack Worker ──► Tinybird (events)
agents ────────────► /mcp ─────┘
```

## Setup

You need a Tinybird account (`tb` CLI) and a Cloudflare account (`wrangler`).

```bash
pnpm install
```

1. Create the Tinybird datasource and tokens:

```bash
tb login
tb --cloud deploy
```

2. Set the Worker's secrets. Copy the two Tinybird tokens with `tb --cloud token copy seerstack_ingest` and `tb --cloud token copy seerstack_read`. The other three are any long random strings (`openssl rand -hex 32`).

```bash
pnpm exec wrangler secret put TINYBIRD_INGEST_TOKEN
```

```bash
pnpm exec wrangler secret put TINYBIRD_READ_TOKEN
```

```bash
pnpm exec wrangler secret put INGEST_KEY
```

```bash
pnpm exec wrangler secret put MCP_TOKEN
```

```bash
pnpm exec wrangler secret put ANON_SALT
```

3. Set `TINYBIRD_HOST` in `wrangler.jsonc` to your workspace's region (`tb info` shows it), add your projects to `src/projects.ts`, and deploy:

```bash
pnpm run deploy
```

Ad blockers target well-known analytics paths and domains, so consider a custom domain for the Worker (e.g. `a.yourdomain.com`).

## Sending events

**Websites.** Pageviews are tracked automatically, including SPA navigations. There are no cookies.

```html
<script defer src="https://seerstack.jp-814.workers.dev/s.js" data-project="my-site"></script>
```

```js
window.seerstack?.track("signup_clicked", { plan: "pro" });
window.seerstack?.identify(user.id, { plan: "pro" }); // links today's anonymous visits to the user
```

The page's domain must be listed in the project's `domains`. Localhost is ignored unless the tag has `data-allow-localhost` and `localhost` is in `domains`. To exclude your own browser, run `localStorage.seerstack_ignore = "1"`.

**Servers.** For any project:

```bash
curl -X POST https://seerstack.jp-814.workers.dev/e \
  -H "Authorization: Bearer $SEERSTACK_INGEST_KEY" \
  -d '{"project":"my-app","event":"purchase","user_id":"u_123","properties":{"plan":"pro","amount":49}}'
```

Send up to 500 events at once with `{"project":"my-app","batch":[...]}`. Server events may set `timestamp` (ISO or ms) for backfills, plus `anonymous_id` and `event_id`.

## Connecting agents

```bash
claude mcp add --transport http seerstack https://seerstack.jp-814.workers.dev/mcp --header "Authorization: Bearer $SEERSTACK_MCP_TOKEN"
```

For clients that can't send headers, use `https://…/mcp?token=<MCP_TOKEN>`. Treat that URL as a secret.

| Tool                     | What it answers                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `list_projects`          | Which projects exist and their last 30 days of activity                                       |
| `overview`               | Visitors, pageviews, sessions, bounce rate, session length, compared with the previous period |
| `timeseries`             | Visitors and counts per hour, day, week or month for any event                                |
| `breakdown`              | Top pages, sources, UTMs, countries, devices, events, or any `properties.<key>`               |
| `list_events`            | Which events a project sends, and their property keys                                         |
| `funnel`                 | Step-by-step conversion, linking anonymous visits to signups                                  |
| `get_schema` / `run_sql` | Anything else, in read-only ClickHouse SQL                                                    |

## Local development

```bash
tb local start
```

```bash
tb build
```

```bash
cp .dev.vars.example .dev.vars
```

Fill in `.dev.vars` with the local tokens from `tb token copy seerstack_ingest` and `tb token copy seerstack_read`, then:

```bash
pnpm dev
```

```bash
pnpm test
```

How it works and why: [`.context/`](.context/README.md).
