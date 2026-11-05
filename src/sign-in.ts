import { base64Url, escapeHtml, githubUser, page, pkceChallenge } from "./auth";
import type { Env } from "./env";
import { signToken, verifyToken } from "./seal";

// Sign-in for Seerstack's own pages (the PostHog import page). Like the MCP
// sign-in it goes through GitHub and only lets in ALLOWED_GITHUB_USER_ID, but
// it ends in a signed session cookie instead of an OAuth token. GitHub returns
// to /callback/import, a subdirectory of the OAuth App's callback URL.

const SESSION_COOKIE = "seerstack_session";
const SIGN_IN_COOKIE = "seerstack_signin";
const SESSION_LABEL = "seerstack page session";
const SIGN_IN_LABEL = "seerstack page sign-in";
const SESSION_MS = 12 * 3_600_000;
const SIGN_IN_MS = 10 * 60_000;
export const CALLBACK_PATH = "/callback/import";

export type OwnerSession = { githubId: string; login: string; csrf: string };
type SignIn = { state: string; verifier: string; returnTo: string };

const random = (bytes: number) => base64Url(crypto.getRandomValues(new Uint8Array(bytes)));

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

const setCookie = (name: string, value: string, path: string, maxAgeSeconds: number) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;

// Only ever send someone back to a page of ours.
const safeReturn = (path: string) => (/^\/import(?:[/?]|$)/.test(path) ? path : "/import");

export async function ownerSession(req: Request, env: Env): Promise<OwnerSession | null> {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return null;
  const session = await verifyToken<OwnerSession>(token, env.ANON_SALT, SESSION_LABEL);
  // Sessions from before ALLOWED_GITHUB_USER_ID changed stop working.
  return session?.githubId === env.ALLOWED_GITHUB_USER_ID ? session : null;
}

// Sends the browser to GitHub, remembering (in a signed cookie) the state,
// the PKCE verifier and where to come back to.
export async function beginSignIn(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const signIn: SignIn = { state: random(16), verifier: random(32), returnTo: safeReturn(url.pathname + url.search) };
  const github = new URL("https://github.com/login/oauth/authorize");
  github.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: new URL(CALLBACK_PATH, req.url).href,
    state: signIn.state,
    code_challenge: await pkceChallenge(signIn.verifier),
    code_challenge_method: "S256",
    allow_signup: "false",
  }).toString();
  const token = await signToken(signIn, SIGN_IN_MS, env.ANON_SALT, SIGN_IN_LABEL);
  return new Response(null, {
    status: 302,
    headers: {
      Location: github.href,
      "Set-Cookie": setCookie(SIGN_IN_COOKIE, token, CALLBACK_PATH, SIGN_IN_MS / 1000),
      "Cache-Control": "no-store",
    },
  });
}

function refuse(message: string): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  return page("Can't sign in", `<h1>Can't sign in</h1><p>${escapeHtml(message)}</p>`, headers, 403);
}

// GET /callback/import from GitHub.
export async function finishSignIn(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const token = cookie(req, SIGN_IN_COOKIE);
  const signIn = token ? await verifyToken<SignIn>(token, env.ANON_SALT, SIGN_IN_LABEL) : null;
  if (!signIn || url.searchParams.get("state") !== signIn.state) {
    return refuse("This sign-in expired or was started elsewhere. Open the page again.");
  }
  const code = url.searchParams.get("code");
  if (!code) return refuse("GitHub sign-in was cancelled.");
  const user = await githubUser(env, code, signIn.verifier, new URL(CALLBACK_PATH, req.url).href);
  if (!user) return refuse("GitHub sign-in failed.");
  if (String(user.id) !== env.ALLOWED_GITHUB_USER_ID)
    return refuse(`GitHub user ${user.login} can't use this Seerstack.`);

  const session: OwnerSession = { githubId: String(user.id), login: user.login, csrf: random(16) };
  const headers = new Headers({ Location: safeReturn(signIn.returnTo), "Cache-Control": "no-store" });
  headers.append(
    "Set-Cookie",
    setCookie(
      SESSION_COOKIE,
      await signToken(session, SESSION_MS, env.ANON_SALT, SESSION_LABEL),
      "/import",
      SESSION_MS / 1000,
    ),
  );
  headers.append("Set-Cookie", setCookie(SIGN_IN_COOKIE, "", CALLBACK_PATH, 0));
  return new Response(null, { status: 302, headers });
}
