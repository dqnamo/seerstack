# Guidance

- **SQL values go through `SqlBuilder.bind()`.** Never interpolate a user or agent value into tool SQL. Column names come from `DIMENSIONS` or `properties.<key>` (whose key is bound). Numbers are validated before they're inlined.
- **Verify SQL against real ClickHouse.** Unit tests only check how queries are built. After changing any query, run `tb local start`, `tb build` and `pnpm dev`, seed a few events with `POST /e`, and call the tool through `/mcp`.
- **Agent-facing errors are `QueryError(message, hint)`.** The hint says what to try next. Unexpected errors are logged and returned as a generic retry message.
- **Tool results are JSON with the resolved `range`** (ISO strings), so an agent always knows which period it got. ClickHouse UInt64s arrive as strings; convert them with `num()`.
- **UTC everywhere.** There are no per-project timezones yet.
- **Tests** run in Node with Vitest: `pnpm test`. Mock `fetch` for Tinybird. App tests call `app.request(...)` with a fake env and execution context, and mock `src/projects` so they don't depend on your real project list.
- **Before committing:** `pnpm check` (Biome), `pnpm typecheck`, `pnpm test`.
- **Dependencies:** pnpm 11 refuses packages published less than a day ago, so pin ranges that allow a slightly older release.
