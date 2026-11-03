# Guidance

- **SQL values go through `SqlBuilder.bind()`.** Never interpolate a user or agent value into tool SQL. Column names come from `DIMENSIONS` or `properties.<key>` (whose key is bound). Numbers are validated before they're inlined.
- **Verify SQL against real ClickHouse.** Unit tests only check how queries are built. After changing any query, run `tb local start` and `tb build`, call `create_project` (or insert a row into local D1), seed events with `POST /e`, and run the tool.
- **Agent-facing errors are `QueryError(message, hint)`.** The hint says what to try next. Unexpected errors are logged and returned as a generic retry message.
- **Tool results are JSON with the resolved `range`** (ISO strings), so an agent always knows which period it got. ClickHouse UInt64s arrive as strings; convert them with `num()`.
- **Project management is MCP tools, not config.** Anything the owner would do routinely (add a site, change domains, rotate keys) should be a tool call, not a code edit and redeploy.
- **The consent page renders client-supplied strings.** Wrap every one in `escapeHtml()`. JavaScript's global `escape()` URL-encodes instead, and it typechecks, so it's an easy XSS mistake.
- **UTC everywhere.** There are no per-project timezones yet.
- **Tests** run in Node with Vitest: `pnpm test`.
  - Mock `fetch` for Tinybird and GitHub.
  - `test/d1.ts` is a D1 stand-in on `node:sqlite` that applies the real migrations.
  - `cloudflare:workers` is aliased to a stub in `vitest.config.ts`.
  - App tests call `app.request(...)` or `mcpHandler.fetch(...)` with a fake env and execution context. OAuth tests mock `env.OAUTH_PROVIDER`.
- **Schema changes** are new files in `migrations/`, applied with `wrangler d1 migrations apply seerstack --remote` before deploying.
- **Before committing:** `pnpm check` (Biome), `pnpm typecheck`, `pnpm test`.
- **Dependencies:** pnpm 11 refuses packages published less than a day ago, so pin ranges that allow a slightly older release.
