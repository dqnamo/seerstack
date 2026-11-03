# 0002 — Projects are defined in code

**Status:** Accepted
**Date:** 2026-11-02

## Context

Ingest has to know which project IDs are real and which sites may send browser events for them. Otherwise anyone could post junk under any project name.

## Options

- A `PROJECTS` map in `src/projects.ts`, changed by redeploying.
- Workers KV or D1, with MCP tools to create projects.
- Accept any project ID.

## Decision

Use a typed `PROJECTS` map in `src/projects.ts`: ID → name and allowed domains (subdomains included). Browser events must come from an allowed Origin. Server events skip the check because they authenticate with `INGEST_KEY`.

## Consequences

- Adding a project means editing a line and running `pnpm run deploy`.
- `list_projects` reads the map, plus 30-day activity from Tinybird.
- The Origin check stops casual abuse but can be spoofed by non-browser clients. That's acceptable for analytics.

## Revisit when

Projects change often enough that redeploying is annoying, or agents should be able to create projects themselves.
