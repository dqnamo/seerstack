# 0004 — MCP tools run parameterized Query API templates

**Status:** Accepted
**Date:** 2026-11-02

## Context

Agents need both common answers (overview, top pages, funnels), which should be correct the first time, and open-ended SQL. Tinybird offers published endpoints (pipes), the Query API (`/v0/sql`), and its own hosted MCP server.

## Options

- Publish a Tinybird endpoint per tool and have the MCP server call it.
- Use Tinybird's hosted MCP server and write no MCP code.
- Build SQL in TypeScript and send it to `/v0/sql` as a template, with values bound by Tinybird.

## Decision

Use Query API templates. Each tool's SQL starts with `%`, and every value becomes `{{String(pN)}}`, sent as a form param that Tinybird binds. All query logic lives in TypeScript (`src/analytics.ts`) next to the tool definitions. `run_sql` is the escape hatch, behind the SQL guard. One READ token covers both.

## Consequences

- Variable-length funnels, comparisons and zero-filled buckets are plain TypeScript, and there are no datafiles to redeploy when a query changes.
- Endpoint caching and per-endpoint observability aren't used. That's fine for agent-scale traffic.
- Tool descriptions and errors are written for agents, which Tinybird's generic MCP can't do. Its hosted MCP still works alongside this one if you want it.

## Revisit when

Something other than agents needs these numbers at volume (a public dashboard, embeds). Then publish endpoints for the hot queries.
