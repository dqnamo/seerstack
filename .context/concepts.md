# Concepts

**Project**: one site or app being tracked, keyed by a short ID (`saintdex`, `my-site`). Projects are defined in `src/projects.ts`; events for an unknown project are rejected. Every query filters on `project_id`, but the owner can query across projects.

**Event**: one row in Tinybird's `events` datasource. Three kinds share the table:
- `$pageview`: sent by the browser tracker on load and on SPA navigation.
- `$identify`: links the current `anonymous_id` to a `user_id`, with user traits in `properties`.
- Product events: any other name (`signup`, `purchase`), from the browser or a server.

**Browser event vs server event**: browser events have no credentials, so they must come from one of the project's `domains` (Origin check), bots are dropped, and the Worker fills in geo, device and a cookieless ID from the request and sets the timestamp itself. Server events carry `Authorization: Bearer INGEST_KEY`, may target any project, keep their own `timestamp` (for backfills), and get no request-derived geo or device data, because the request comes from the server, not the user.

**Visitor identity**:
- `anonymous_id`: for browser events, a hash of salt + UTC day + project + IP + user agent. It's stable for a day and unlinkable across days, with no cookies or storage. Multi-day unique-visitor counts are therefore upper bounds.
- `user_id`: your app's user ID, when known.
- `distinct_id`: `user_id` if set, else `anonymous_id`. This is the "unique visitor/user" key.
- **Person** (funnels only): `user_id`, or the `user_id` an `$identify` linked to this `anonymous_id`, or the `anonymous_id`. This lets a funnel start before signup.

**Session**: not stored. A visitor's pageviews more than 30 minutes apart start a new session. Bounce = a session with one pageview.

**Range**: every analytics tool works on a half-open UTC range `[from, to)`, from a `period` (`7d` includes today) or an inclusive `date_from`/`date_to`. "Previous period" is the same length immediately before.

**"(none)"**: how empty dimension values (direct traffic, no UTM) are shown. Filtering on `"(none)"` matches empty.
