# 0005 — Write straight to the Events API, no queue

**Status:** Accepted
**Date:** 2026-11-02

## Context

The SaaS version buffered events through a Cloudflare Queue with retries and a dead-letter queue, so no event was ever lost. That's more infrastructure to create and run.

## Options

- Queue → consumer → Events API.
- Write to the Events API directly from the request.

## Decision

Write directly. Browser events are written in `waitUntil`, so the beacon returns at once. Server events are awaited, and a failure returns 502 so the caller can retry.

## Consequences

- There's no queue to set up.
- If Tinybird is down, browser events from that window are lost (they're logged in Workers observability).
- Each pageview is one small Events API request, which is the traffic pattern the Events API is built for.

## Revisit when

Losing a window of pageviews matters, traffic approaches Events API rate limits, or batching would cut costs.
