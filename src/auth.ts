import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { BASE_CSS, HEAD } from "./styles";

// The OAuth sign-in for MCP clients. /authorize shows a consent page (who is
// asking, where the token goes); Allow sends you to GitHub, and /callback
// finishes only if GitHub says you are ALLOWED_GITHUB_USER_ID. The library's
// consent and upstream helpers bind each step to this browser, so the page
// can't be framed or forged and a GitHub code can't be replayed elsewhere.

export const SCOPE = "seerstack";

/** What every MCP request sees as ctx.props. */
export type AuthProps = { githubId: string; login: string };

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(title: string, body: string, headers = new Headers(), status = 200): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  const html = `<!doctype html>
<html lang="en">
${HEAD}
<title>${escapeHtml(title)} · Seerstack</title>
<style>${BASE_CSS}
  .container { width: 100%; max-width: 30rem; margin: 0 auto; padding: 5rem 0; }
  .logo a { color: var(--gray-12); text-decoration: none; transition: opacity 200ms ease; }
  .logo a:hover { opacity: 0.7; }
  h1 { margin: 2.5rem 0 0; font-size: 1.25rem; font-weight: 500; line-height: 1.35; letter-spacing: -0.01em; text-wrap: balance; }
  p { margin: 0.75rem 0 0; font-size: 0.9375rem; color: var(--gray-11); }
  strong { font-weight: 500; color: var(--gray-12); }
  .warn { margin-top: 1.25rem; padding: 0.75rem 0.875rem; border: 1px solid var(--amber-7); border-radius: 0.625rem; background: var(--amber-2); color: var(--amber-11); }
  .warn strong { color: var(--amber-12); }
  .note { margin-top: 1rem; font-size: 0.8125rem; }
  .button.allow { --bg: var(--gray-12); color: var(--gray-1); }
  .button.allow:hover { --bg: var(--gray-11); }
</style>
<div class="container">
  <p class="logo"><a href="/">seerstack</a></p>
${body}
</div>
`;
  return new Response(html, { status, headers });
}

function consentPage(details: ConsentDescription, handle: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  const local = details.redirectIsLoopback
    ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting it.</p>'
    : "";
  return `<h1>Allow ${name} to read and manage your Seerstack analytics?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${local}
<form method="post" class="actions">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <button class="button solid allow" name="decision" value="approve">Allow</button>
  <button class="button" name="decision" value="deny">Deny</button>
</form>
<p class="note">You'll sign in with GitHub next.</p>`;
}

// Redirect back to the client only when the library has validated where to;
// everything else is shown here.
function authError(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : "This app couldn't be verified.";
    return page("Can't connect", `<h1>Can't connect</h1><p>${escapeHtml(message)}</p>`, undefined, 400);
  }
  throw error;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

const callbackUrl = (req: Request) => new URL("/callback", req.url).href;

// GET /authorize
export async function showConsent(req: Request, env: Env): Promise<Response> {
  try {
    const request = await env.OAUTH_PROVIDER.parseAuthRequest(req);
    const details = await env.OAUTH_PROVIDER.describeConsent(request);
    const consent = await env.OAUTH_PROVIDER.beginConsent(request);
    return page(`Allow ${details.clientName}?`, consentPage(details, consent.handle), consent.headers);
  } catch (error) {
    return authError(error);
  }
}

// POST /authorize: Deny goes back to the client; Allow goes to GitHub.
export async function submitConsent(req: Request, env: Env): Promise<Response> {
  try {
    const form = await req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await env.OAUTH_PROVIDER.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await env.OAUTH_PROVIDER.approveConsent(req, handle, { scope: [SCOPE] });
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const { state, headers } = await env.OAUTH_PROVIDER.beginUpstream(approved.request, {
      data: { verifier },
      headers: approved.headers,
    });
    const github = new URL("https://github.com/login/oauth/authorize");
    github.search = new URLSearchParams({
      client_id: env.GITHUB_CLIENT_ID,
      redirect_uri: callbackUrl(req),
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      allow_signup: "false",
    }).toString();
    headers.set("Location", github.href);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return authError(error);
  }
}

async function githubUser(env: Env, code: string, verifier: string, redirectUri: string) {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!token.access_token) return null;
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "seerstack",
    },
  });
  return userRes.ok ? ((await userRes.json()) as { id: number; login: string }) : null;
}

// GET /callback from GitHub.
export async function githubCallback(req: Request, env: Env): Promise<Response> {
  let resumed: Awaited<ReturnType<typeof env.OAUTH_PROVIDER.finishUpstream<{ verifier: string }>>>;
  try {
    resumed = await env.OAUTH_PROVIDER.finishUpstream<{ verifier: string }>(req);
  } catch (error) {
    return authError(error);
  }
  const { request: original, data, headers } = resumed;
  const deny = (description: string) => {
    headers.set("Location", authorizationErrorRedirect(original, "access_denied", description));
    return new Response(null, { status: 302, headers });
  };

  const code = new URL(req.url).searchParams.get("code");
  if (!code) return deny("GitHub sign-in was cancelled");
  const user = await githubUser(env, code, data.verifier, callbackUrl(req));
  if (!user) return deny("GitHub sign-in failed");
  if (String(user.id) !== env.ALLOWED_GITHUB_USER_ID) return deny(`GitHub user ${user.login} can't use this Seerstack`);

  const props: AuthProps = { githubId: String(user.id), login: user.login };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: original,
    userId: props.githubId,
    metadata: { login: user.login },
    scope: original.scope,
    props,
  });
  headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers });
}
