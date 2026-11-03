# Decisions

| #                                                 | Decision                                              | Status   | Summary                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| [0001](./0001-one-worker-personal-tool.md)        | One Worker, built as a personal tool                  | Accepted | A single Hono Worker for ingest, tracker and MCP. No auth, tenants or billing.              |
| [0002](./0002-projects-in-code.md)                | Projects are defined in code                          | Accepted | A `PROJECTS` map with allowed domains. Redeploy to add a project.                           |
| [0003](./0003-cookieless-ids-derived-sessions.md) | Cookieless daily visitor IDs; sessions derived in SQL | Accepted | No client storage. A 30-minute gap starts a new session.                                    |
| [0004](./0004-mcp-tools-as-query-templates.md)    | MCP tools run parameterized Query API templates       | Accepted | SQL is built in TypeScript and values are bound by Tinybird. `run_sql` is the escape hatch. |
| [0005](./0005-direct-events-api-writes.md)        | Write straight to the Events API, no queue            | Accepted | Browser writes run in waitUntil; server writes are awaited.                                 |
