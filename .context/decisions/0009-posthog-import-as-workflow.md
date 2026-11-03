# 0009 — Import PostHog history with a Workflow, shaped like live data

**Status:** Accepted
**Date:** 2026-11-03

## Context

Sites move to Seerstack with months of history in PostHog. Server events can already be backfilled with their own `timestamp`, but a script doing that loses location and device (server events don't get them), can't tell what it already sent (the table doesn't collapse duplicates), and copies PostHog's way of counting, which differs from the tracker's. A large history is also too much for one MCP request.

## Options

- **A documented backfill script** against `POST /e`: no new code in Seerstack, but every gap above stays.
- **An MCP tool that imports one chunk per call** and is called again until done: no new infrastructure, but the person (or agent) has to keep it going.
- **An MCP tool that starts a Cloudflare Workflow**: one call starts it, it runs and retries on its own, and other tools report and stop it.

## Decision

`import_posthog` checks the key and range, counts what it will import, records the import in a D1 `imports` table and starts the `PosthogImport` Workflow. `list_imports` shows progress; `cancel_import` terminates it.

- **Reading PostHog:** HogQL through the query API, keyset-paginated on (millisecond, UUID) (PostHog refuses `OFFSET` for personal API keys) in pages of 2,000, so any number of events sharing a timestamp page cleanly. Each page reads a time window that doubles while pages come back sparse and halves when PostHog times out. A 429 sleeps the Workflow for `Retry-After` (15 minutes when the hourly read budget is spent).
- **Safe retries:** a step reads its page from the same position, then skips rows Tinybird already has for that page's time range (`event_id` is PostHog's UUID; writes use `wait=true` so they're readable at once). Progress is written as totals. So a retried step or an overlapping import can't duplicate events. A partial unique index allows one running import per project, since two at once could each write a page before seeing the other's rows.
- **Resuming:** a new import of the same PostHog project and events starts where earlier ones stopped reading (their `position`).
- **No double counting:** by default it stops at the project's first pageview recorded by Seerstack itself.
- **Shaped like live data** (`src/posthog.ts`): pageviews and the site's own events only; bots and same-path navigations dropped; referrer is PostHog's `$referrer` on page loads and the previous page on SPA navigations (PostHog keeps the tab's first referrer on every event); visitor IDs are hashed per UTC day (`c_…`) or, for sites using `data-persist`, once (`p_…`); browser/OS/device come from `parseUserAgent()` on `$raw_user_agent`; geo from PostHog's GeoIP properties; only non-`$` properties are kept; `lib` is `posthog`.
- **The PostHog key** is used for the import only. Workflow params are stored and shown by Cloudflare, so it travels sealed with AES-GCM under a key derived from `ANON_SALT` (HKDF, its own label).

## Consequences

- Moving a site over is one request to an agent, and the history reads like the rest of the data: breakdowns by country, browser and source work on it.
- Imported rows can always be told apart (`lib = 'posthog'`) or excluded.
- Steps assume Workers Paid limits (30 s CPU per step, 10,000 steps): a page of 2,000 events is well inside them, and 10,000 steps is about 20 million events. On Workers Free (10 ms CPU per step), lower `PAGE_SIZE`.
- PostHog's docs say the query API "is not for exports". Keyset pagination is their recommended way to page through it, and rate limits are handled, but very large projects may be better served by a PostHog batch export.
- Imports fill forward from where earlier ones stopped; filling an older gap needs a `date_from`/`date_to` import. Overlaps are harmless.
- Rotating `ANON_SALT` breaks imports that are running at the time, as well as changing cookieless IDs.

## Revisit when

Another source (Plausible, GA4, Vercel Analytics) is wanted: the Workflow and `imports` table are source-agnostic, the mapping in `src/posthog.ts` isn't.
