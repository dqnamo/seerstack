# 0007 — OAuth on /mcp, signing in with GitHub

**Status:** Accepted
**Date:** 2026-11-03

## Context

`/mcp` used a static bearer token (`MCP_TOKEN`) that had to be pasted into every client, and clients like claude.ai connectors can't send headers. MCP clients now support OAuth 2.1 with dynamic registration, so Seerstack can act as its own authorization server.

## Options

- Keep the static token.
- OAuth, signing in with an owner password stored as a secret.
- OAuth, signing in with GitHub, restricted to the owner's GitHub account.

## Decision

Use `@cloudflare/workers-oauth-provider`'s `OAuthProvider`, with the Worker acting as both the authorization server and its only resource (`https://seerstack.com/mcp`). It supports both dynamic client registration and client ID metadata documents.

`/authorize` shows a consent page with the client's name and where the token will go. Allow redirects to GitHub (with PKCE). `/callback` completes authorization only when GitHub's numeric user ID equals `ALLOWED_GITHUB_USER_ID`. The library's consent and upstream helpers bind each step to the browser, which closes the confused-deputy hole. The MCP handler re-checks the ID, so changing it cuts off existing tokens.

The numeric ID is used, not the username, because usernames can be renamed and then claimed by someone else.

## Consequences

- Connecting a client is a browser sign-in; there is no token to copy.
- There's a small HTML consent page. It's the only UI.
- Requires a GitHub OAuth App (callback `https://seerstack.com/callback`) and a KV namespace for OAuth state.
- Tokens are issued for `https://seerstack.com/mcp`, so the MCP endpoint only works on that hostname.
- Local development of the OAuth flow needs a second GitHub OAuth App with a localhost callback; the tests mock the helpers instead.

## Revisit when

Someone other than the owner needs access (then add an allowlist or per-user projects).
