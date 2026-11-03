# 0003 — Cookieless daily visitor IDs; sessions derived in SQL

**Status:** Accepted
**Date:** 2026-11-02

## Context

Web analytics needs unique visitors and sessions. Cookies or localStorage IDs are more accurate, but they need consent banners and add client state.

## Options

- Client-side IDs in cookies, localStorage or sessionStorage.
- A server-side hash of salt + UTC day + project + IP + user agent, with sessions derived in queries (the Plausible model).

## Decision

The tracker stores nothing. The Worker computes `anonymous_id` as that daily-rotating hash. Sessions aren't stored: queries treat a gap of more than 30 minutes between a visitor's pageviews as a new session. `$identify` from the browser links that day's `anonymous_id` to a `user_id`.

## Consequences

- No consent banner is needed for the tracker itself.
- A visitor counts as new each UTC day, so multi-day unique-visitor counts are upper bounds. Sessions can't span midnight UTC.
- Identity stitching (anonymous → user) only covers the day of the identify call.
- Session metrics cost a window-function pass over pageviews per query. That's fine at personal scale.

## Revisit when

Cross-day retention of anonymous visitors matters more than staying cookieless, or overview queries get slow (then add a materialized sessions table).
