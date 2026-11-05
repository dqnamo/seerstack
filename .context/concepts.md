# Concepts

**Project**: one site or app being tracked, with a short ID (`saintdex`) used in every query. Projects live in D1 and are created and changed through the MCP tools (`create_project`, `update_project`, `rotate_keys`), never in code. Every query filters on `project_id`, but the owner can query across projects.

**Keys**: each project has two.
- **Public key** (`pk_…`) goes in the script tag. It's not a secret: it only works from the project's `domains` (and their subdomains).
- **Secret key** (`sk_…`) is for server-side events. It's stored only as a hash, shown once, and replaced with `rotate_keys`.

The key on a request decides which project its events belong to.

**Event**: one row in Tinybird's `events` datasource. Three kinds share the table:
- `$pageview`: sent by the browser tracker on load and on SPA navigation.
- `$identify`: links the current `anonymous_id` to a `user_id`, with user traits in `properties`.
- Product events: any other name (`signup`, `purchase`), from the browser or a server.

**Browser event vs server event**: browser events carry the public key in the body and must come from one of the project's domains (Origin check). Bots are dropped, and the Worker fills in geo, device and a cookieless ID from the request and sets the timestamp itself. Server events carry `Authorization: Bearer <secret key>`, keep their own `timestamp` (for backfills), and get no request-derived geo or device data, because the request comes from the server, not the user.

**Imported event**: a row copied from PostHog by an import, with `lib = 'posthog'` and PostHog's UUID as `event_id`. It's shaped as if the tracker had recorded it: the same visitor ID scheme (`c_` per day, or `p_` for `data-persist` sites, hashed from PostHog's device ID), referrers credited the same way, geo and device filled in, bots and PostHog's automatic events left out. Imports stop where the project's own pageviews begin.

**Import**: one run of the PostHog import Workflow, started by the owner on the `/import` page (where the PostHog key is pasted, so it never passes through an agent), tracked in D1's `imports` table: running, completed, failed or cancelled, with an estimate, totals and the position it has read up to. A new import of the same PostHog project carries on from the furthest position.

**Visitor identity**:
- `anonymous_id`: for browser events, either:
  - `c_…`: a hash of salt + UTC day + project + IP + user agent. It's stable for a day and unlinkable across days, with no cookies or storage. This is the default.
  - `p_…`: a random ID the tracker keeps in localStorage when the tag has `data-persist`, so a returning browser keeps the same ID across days.

  Multi-day unique counts are exact for `p_` IDs and upper bounds for `c_` IDs.
- `user_id`: your app's user ID, when known.
- `distinct_id`: `user_id` if set, else `anonymous_id`. This is the "unique visitor/user" key.
- **Person** (funnels only): `user_id`, or the `user_id` an `$identify` linked to this `anonymous_id`, or the `anonymous_id`. This lets a funnel start before signup.

**Session**: not stored. A visitor's pageviews more than 30 minutes apart start a new session. Bounce = a session with one pageview.

**Range**: every analytics tool works on a half-open UTC range `[from, to)`, from a `period` (`7d` includes today) or an inclusive `date_from`/`date_to`. "Previous period" is the same length immediately before.

**"(none)"**: how empty dimension values (direct traffic, no UTM) are shown. Filtering on `"(none)"` matches empty.

**Owner**: the one GitHub account (`ALLOWED_GITHUB_USER_ID`) that can connect MCP clients. There are no other users.
