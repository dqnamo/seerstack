# 0006 — Projects and keys live in D1, managed over MCP

**Status:** Accepted
**Date:** 2026-11-03
**Supersedes:** [0002](./0002-projects-in-code.md)

## Context

Projects were a map in `src/projects.ts`, so tracking a new site meant editing Seerstack and redeploying. The owner works through agents and wants "create a project, get a key" to be one tool call. A global `INGEST_KEY` also let any server write to any project.

## Options

- Keep the code map and add a deploy step to the agent's workflow.
- Workers KV: fast reads, but a new key can take up to a minute to be visible everywhere.
- D1: strongly consistent, queryable, cheap at this scale.

## Decision

Projects live in a D1 `projects` table. The MCP tools `create_project`, `update_project` and `rotate_keys` manage them. Each project has:
- a **public key** (`pk_…`, stored in plain text) that goes in the script tag and only works from the project's domains;
- a **secret key** (`sk_…`, stored as a SHA-256 hash, shown once) for server-side events.

A request's key decides its project, so events no longer carry a `project` field. Key lookups are cached per isolate for 60 seconds.

## Consequences

- Adding a site needs no deploy: the agent calls `create_project` and hands back a script tag.
- A rotated key can keep working for up to a minute in isolates that cached it.
- A project with no domains accepts server events only.
- Losing a secret key means rotating it; it can't be shown again.

## Revisit when

Several people need different access to projects, or keys need scopes or expiry.
