import { Hono } from "hono";
import { cors } from "hono/cors";
import { secretsEqual } from "./enrich";
import type { Env } from "./env";
import { handleMcp } from "./mcp";
import { BadRequest, extractEvents, normalizeEvents } from "./normalize";
import { PROJECTS } from "./projects";
import { appendEvents } from "./tinybird";
import { TRACKER_JS } from "./tracker";

const MAX_BODY_BYTES = 512 * 1024;

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.text("Seerstack. Events: POST /e. Script: /s.js. Agents: /mcp."));
app.get("/health", (c) => c.json({ ok: true }));

app.get("/s.js", (c) =>
  c.body(TRACKER_JS, 200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=3600",
  }),
);

// Browsers post from your sites; servers post with `Authorization: Bearer <INGEST_KEY>`.
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

  const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const trusted = bearer !== "" && (await secretsEqual(bearer, c.env.INGEST_KEY));
  if (bearer && !trusted) return c.json({ error: "Invalid INGEST_KEY" }, 401);

  let events: unknown[];
  try {
    events = extractEvents(JSON.parse(text));
  } catch (e) {
    return c.json({ error: e instanceof BadRequest ? e.message : "Body must be valid JSON" }, 400);
  }

  const cf = c.req.raw.cf as { country?: string; region?: string; city?: string } | undefined;
  const { rows, rejected, errors } = await normalizeEvents(events, {
    projects: PROJECTS,
    now: Date.now(),
    trusted,
    origin: c.req.header("origin"),
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

app.all("/mcp", async (c) => {
  // `?token=` is for MCP clients that can't send headers.
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.query("token") ?? "";
  if (!(await secretsEqual(token, c.env.MCP_TOKEN))) return c.json({ error: "Invalid MCP_TOKEN" }, 401);
  return handleMcp(c.env, PROJECTS, c.req.raw);
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

export default app;
