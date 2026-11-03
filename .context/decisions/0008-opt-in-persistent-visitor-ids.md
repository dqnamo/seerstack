# 0008 — Opt-in persistent visitor IDs

**Status:** Accepted
**Date:** 2026-11-03
**Amends:** [0003](./0003-cookieless-ids-derived-sessions.md)

## Context

Cookieless IDs rotate daily, so a visitor who comes back the next day counts as new. Returning visitors, multi-day uniques and retention aren't measurable for sites without logins (like saintdex). PostHog and GA solve this with a random ID kept in browser storage; Plausible and PostHog's cookieless mode accept per-day counts.

## Options

- Keep daily rotation everywhere.
- Rotate the server-side hash weekly or monthly (Umami-style). Still storage-free, but it breaks whenever the IP changes (mobile), and a long-lived hash of IP and user agent is close to fingerprinting.
- An opt-in random ID in localStorage, per site.

## Decision

The tracker takes a `data-persist` attribute. With it, the tracker keeps a random `p_…` ID in localStorage (`seerstack_id`) and sends it as `anonymous_id`. Without it, or when storage is blocked, nothing is stored and the server's daily `c_…` hash is used as before. The server needed no change: it already preferred a client-supplied `anonymous_id`.

## Consequences

- Sites with `data-persist` get accurate returning visitors and retention per browser, and `$identify` links the same anonymous ID across days.
- A persistent ID is browser storage, which EU/UK rules treat like a cookie, so turning it on is a per-site decision (saintdex has it on).
- `anonymous_id` now has two kinds of value: `p_…` (persistent) and `c_…` (daily). Multi-day unique counts are exact for `p_` IDs and still upper bounds for `c_` IDs.

## Revisit when

A site needs a consent banner: then start cookieless and switch to the stored ID only after consent.
