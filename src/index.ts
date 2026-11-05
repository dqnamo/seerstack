import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type AuthProps, githubCallback, SCOPE, showConsent, submitConsent } from "./auth";
import type { Env } from "./env";
import { showImport, showImportForm, submitCancel, submitImport } from "./import-page";
import { handleMcp } from "./mcp";
import { BadRequest, extractEvents, normalizeEvents } from "./normalize";
import { originAllowed, projectByPublicKey, projectBySecretKey } from "./projects";
import { CALLBACK_PATH, finishSignIn } from "./sign-in";
import { appendEvents } from "./tinybird";
import { TRACKER_JS } from "./tracker";

// Workflow classes must be exported from the main module.
export { PosthogImport } from "./import-workflow";

const MAX_BODY_BYTES = 512 * 1024;
const PUBLIC_URL = "https://seerstack.com";

export const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("Seerstack. Events: POST /e. Script: /s.js. Agents: /mcp (OAuth)."));
app.get("/health", (c) => c.json({ ok: true }));

app.get("/s.js", (c) =>
  c.body(TRACKER_JS, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  }),
);

// Browsers post with the project's public key in the body (and must come from
// one of its domains); servers post with `Authorization: Bearer <secret key>`.
app.use(
  "/e",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);

app.post("/e", async (c) => {
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return c.json({ error: "Body over 512 KB" }, 413);

  let body: unknown;
  let events: unknown[];
  try {
    body = JSON.parse(text);
    events = extractEvents(body);
  } catch (e) {
    return c.json({ error: e instanceof BadRequest ? e.message : "Body must be valid JSON" }, 400);
  }

  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const trusted = bearer !== "";
  const key = trusted ? bearer : String((body as { key?: unknown }).key ?? "");
  const project = trusted ? await projectBySecretKey(c.env.DB, key) : await projectByPublicKey(c.env.DB, key);
  if (!project) return c.json({ error: trusted ? "Invalid secret key" : "Invalid public key" }, 401);

  const origin = c.req.header("origin");
  if (!trusted && !originAllowed(project, origin)) {
    return c.json({ error: `Origin ${origin ?? "(none)"} isn't one of ${project.id}'s domains` }, 403);
  }

  const cf = c.req.raw.cf as { country?: string; region?: string; city?: string } | undefined;
  const { rows, rejected, errors } = await normalizeEvents(events, {
    projectId: project.id,
    now: Date.now(),
    trusted,
    ip: c.req.header("cf-connecting-ip") ?? "",
    userAgent: c.req.header("user-agent") ?? "",
    country: cf?.country ?? "",
    region: cf?.region ?? "",
    city: cf?.city ?? "",
    salt: c.env.ANON_SALT,
  });

  if (rows.length > 0) {
    if (trusted) {
      // Servers wait for the write, so a failure is theirs to retry.
      try {
        await appendEvents(c.env, rows);
      } catch (e) {
        console.error(e);
        return c.json({ error: "Couldn't store events. Retry later." }, 502);
      }
    } else {
      c.executionCtx.waitUntil(appendEvents(c.env, rows).catch((e) => console.error(e)));
    }
  }
  return c.json({ accepted: rows.length, rejected, ...(errors.length > 0 && { errors }) }, 202);
});

app.get("/authorize", (c) => showConsent(c.req.raw, c.env));
app.post("/authorize", (c) => submitConsent(c.req.raw, c.env));
app.get("/callback", (c) => githubCallback(c.req.raw, c.env));

// The PostHog import page, for the owner only (src/import-page.ts).
app.get(CALLBACK_PATH, (c) => finishSignIn(c.req.raw, c.env));
app.get("/import", (c) => showImportForm(c.req.raw, c.env));
app.post("/import", (c) => submitImport(c.req.raw, c.env));
app.get("/import/:id", (c) => showImport(c.req.raw, c.env, c.req.param("id")));
app.post("/import/:id/cancel", (c) => submitCancel(c.req.raw, c.env, c.req.param("id")));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

// Requests to /mcp reach here only with a valid access token.
export const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = (ctx as ExecutionContext & { props?: AuthProps }).props;
    // Tokens issued before ALLOWED_GITHUB_USER_ID changed stop working.
    if (props?.githubId !== env.ALLOWED_GITHUB_USER_ID) return new Response("Forbidden", { status: 403 });
    return handleMcp(env, request);
  },
};

export default new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: [SCOPE],
  requiredScopes: [SCOPE],
  resourceMetadata: { resource: `${PUBLIC_URL}/mcp` },
  clientIdMetadataDocumentEnabled: true,
});
