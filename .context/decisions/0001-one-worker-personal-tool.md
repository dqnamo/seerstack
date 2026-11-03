# 0001 — One Worker, built as a personal tool

**Status:** Accepted
**Date:** 2026-11-02

## Context

Seerstack is web and product analytics for the owner's own projects, queried by agents over MCP, with no UI. An earlier version (now `seerstack-saas`) was a multi-tenant product: separate ingest and API Workers, Better Auth, Postgres, Stripe billing, a CLI, a docs site, and per-tenant Tinybird JWTs for isolation.

## Options

- Strip down the SaaS monorepo.
- Start fresh with one Worker that serves ingest, the tracker and MCP.

## Decision

Start fresh with one Hono Worker and one Tinybird datasource. There are no users, signups, keys or billing. There are three secrets: `INGEST_KEY` for server events, `MCP_TOKEN` for agents, and `ANON_SALT`. The battle-tested pieces of the SaaS (enrichment, SQL guard, MCP wiring, datasource schema) were ported and simplified.

## Consequences

- There's one thing to deploy and very little code.
- Agents can query across all projects. That's intended, since there's a single owner.
- There's no tenant isolation. Anyone holding `MCP_TOKEN` can read everything.

## Revisit when

Other people need access to some projects but not all, or this becomes a product again (see `seerstack-saas`).
