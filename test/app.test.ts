import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubCallback, showConsent, submitConsent } from "../src/auth";
import type { Env } from "../src/env";
import worker, { app, mcpHandler } from "../src/index";
import { clearKeyCache, createProject } from "../src/projects";
import { fakeD1 } from "./d1";

const CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const OWNER = "25507937";

let env: Env;
let pending: Promise<unknown>[];
const ctx = (props?: unknown) =>
  ({ waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props }) as never;
const upstream = vi.fn<typeof fetch>();

beforeEach(() => {
  pending = [];
  clearKeyCache();
  env = {
    DB: fakeD1(),
    OAUTH_KV: {} as KVNamespace,
    OAUTH_PROVIDER: {} as OAuthHelpers,
    TINYBIRD_HOST: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "ingest-token",
    TINYBIRD_READ_TOKEN: "read-token",
    ANON_SALT: "salt",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    ALLOWED_GITHUB_USER_ID: OWNER,
  };
  upstream.mockReset();
  upstream.mockImplementation(async () => Response.json({ successful_rows: 1, quarantined_rows: 0 }));
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => vi.unstubAllGlobals());

const post = (body: unknown, headers: Record<string, string>) =>
  app.request("/e", { method: "POST", body: JSON.stringify(body), headers }, env, ctx());

describe("POST /e", () => {
  it("accepts browser events with the public key from the project's domain", async () => {
    const { project } = await createProject(env.DB, { name: "Site", domains: ["site.com"] });
    const res = await post(
      { key: project.public_key, event: "$pageview", url: "https://site.com/" },
      { Origin: "https://site.com", "User-Agent": CHROME, "Content-Type": "text/plain" },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, rejected: 0 });
    await Promise.all(pending);
    const [url, init] = upstream.mock.calls[0] ?? [];
    expect(url).toBe("https://tinybird.test/v0/events?name=events");
    expect(JSON.parse(String(init?.body))).toMatchObject({ project_id: "site", event: "$pageview", path: "/" });
  });

  it("refuses unknown keys and other origins", async () => {
    const { project } = await createProject(env.DB, { name: "Site", domains: ["site.com"] });
    const headers = { Origin: "https://site.com", "User-Agent": CHROME };
    expect((await post({ key: `pk_${"0".repeat(32)}`, event: "x" }, headers)).status).toBe(401);
    expect(
      (await post({ key: project.public_key, event: "x" }, { ...headers, Origin: "https://evil.com" })).status,
    ).toBe(403);
    expect((await post({ event: "x" }, { Authorization: "Bearer sk_nope" })).status).toBe(401);
  });

  it("takes server events with the secret key, waits for the write and reports failures", async () => {
    const { secret_key } = await createProject(env.DB, { name: "App" });
    const ok = await post({ event: "signup", user_id: "u1" }, { Authorization: `Bearer ${secret_key}` });
    expect(ok.status).toBe(202);
    expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))).toMatchObject({ project_id: "app", lib: "server" });

    upstream.mockResolvedValueOnce(new Response("down", { status: 503 }));
    const failed = await post({ event: "signup" }, { Authorization: `Bearer ${secret_key}` });
    expect(failed.status).toBe(502);
  });

  it("answers CORS preflights", async () => {
    const res = await app.request(
      "/e",
      { method: "OPTIONS", headers: { Origin: "https://site.com", "Access-Control-Request-Method": "POST" } },
      env,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

it("serves the tracker script", async () => {
  const res = await app.request("/s.js", {}, env);
  expect(res.headers.get("content-type")).toContain("javascript");
  expect(await res.text()).toContain("data-key");
});

describe("/mcp", () => {
  const rpc = async (body: object, props: unknown = { githubId: OWNER, login: "dqnamo" }) =>
    mcpHandler.fetch(
      new Request("https://seerstack.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
      }),
      env,
      ctx(props),
    );
  const call = async (name: string, args: object) => {
    const res = await rpc({ method: "tools/call", params: { name, arguments: args } });
    return ((await res.json()) as { result: { isError?: boolean; structuredContent: Record<string, never> } }).result;
  };

  it("is refused without a token, and for anyone but the owner", async () => {
    const res = await worker.fetch(new Request("https://seerstack.com/mcp", { method: "POST" }), env, ctx());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata");
    expect((await rpc({ method: "tools/list" }, { githubId: "1", login: "someone" })).status).toBe(403);
  });

  it("lists the tools", async () => {
    const res = await rpc({ method: "tools/list", params: {} });
    const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "create_project",
        "update_project",
        "rotate_keys",
        "list_projects",
        "overview",
        "run_sql",
      ]),
    );
  });

  it("creates a project whose keys work for ingest", async () => {
    const created = await call("create_project", { name: "Saintdex", domains: ["saintdex.com"] });
    const setup = created.structuredContent.setup as unknown as { script_tag: string; secret_key: string };
    expect(setup.script_tag).toMatch(/^<script defer src="https:\/\/seerstack.com\/s.js" data-key="pk_[0-9a-f]{32}"/);

    const key = /data-key="(pk_[0-9a-f]+)"/.exec(setup.script_tag)?.[1];
    const browserRes = await post(
      { key, event: "$pageview", url: "https://saintdex.com/" },
      { Origin: "https://saintdex.com", "User-Agent": CHROME },
    );
    expect(browserRes.status).toBe(202);
    expect((await post({ event: "x" }, { Authorization: `Bearer ${setup.secret_key}` })).status).toBe(202);

    const duplicate = await call("create_project", { name: "Saintdex" });
    expect(duplicate.isError).toBe(true);
  });

  it("runs analytics as parameterized Tinybird queries with the read token", async () => {
    await createProject(env.DB, { name: "Site", domains: ["site.com"] });
    upstream.mockResolvedValue(
      Response.json({ meta: [], data: [{ value: "/", visitors: "3", events: "5" }], rows: 1 }),
    );
    const result = await call("breakdown", { dimension: "path", period: "today" });
    expect(result.structuredContent.rows).toEqual([{ value: "/", visitors: 3, events: 5 }]);

    const [url, init] = upstream.mock.calls[0] ?? [];
    expect(url).toBe("https://tinybird.test/v0/sql");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer read-token" });
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("q")).toMatch(/^%\n/);
    expect(Object.values(Object.fromEntries(form))).toContain("site"); // the only project is the default
  });
});

describe("OAuth sign-in", () => {
  const authRequest = { clientId: "c1", redirectUri: "https://claude.ai/cb", scope: ["seerstack"], state: "s" };
  const helpers = () =>
    ({
      parseAuthRequest: vi.fn(async () => authRequest),
      describeConsent: vi.fn(async () => ({
        clientId: "c1",
        clientName: '<img src=x onerror="alert(1)">',
        redirectUri: "https://claude.ai/cb",
        redirectHost: "claude.ai",
        redirectIsLoopback: false,
        scope: ["seerstack"],
      })),
      beginConsent: vi.fn(async () => ({ handle: "h1", headers: new Headers({ "X-Frame-Options": "DENY" }) })),
      approveConsent: vi.fn(async () => ({ request: authRequest, headers: new Headers() })),
      denyConsent: vi.fn(async () => ({
        request: authRequest,
        headers: new Headers({ Location: "https://claude.ai/cb?error=access_denied" }),
      })),
      beginUpstream: vi.fn(async () => ({ state: "st", headers: new Headers() })),
      finishUpstream: vi.fn(async () => ({ request: authRequest, data: { verifier: "v" }, headers: new Headers() })),
      completeAuthorization: vi.fn(async () => ({ redirectTo: "https://claude.ai/cb?code=abc" })),
    }) as unknown as OAuthHelpers;

  const form = (fields: Record<string, string>) =>
    new Request("https://seerstack.com/authorize", { method: "POST", body: new URLSearchParams(fields) });

  it("shows a consent page that escapes the client's name and can't be framed", async () => {
    env.OAUTH_PROVIDER = helpers();
    const res = await showConsent(new Request("https://seerstack.com/authorize?client_id=c1"), env);
    const html = await res.text();
    expect(html).not.toContain("<img");
    // HTML-escaped in the heading, not dropped or URL-encoded
    expect(html).toContain("<h1>Allow &#60;img src=x onerror=&#34;alert(1)&#34;&#62; to");
    expect(html).toContain("claude.ai");
    expect(html).toContain('value="h1"');
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("sends Deny back to the client and Allow to GitHub with PKCE", async () => {
    env.OAUTH_PROVIDER = helpers();
    const denied = await submitConsent(form({ handle: "h1", decision: "deny" }), env);
    expect(denied.headers.get("location")).toContain("error=access_denied");

    const allowed = await submitConsent(form({ handle: "h1", decision: "approve" }), env);
    const github = new URL(allowed.headers.get("location") ?? "");
    expect(github.origin + github.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(github.searchParams.get("state")).toBe("st");
    expect(github.searchParams.get("redirect_uri")).toBe("https://seerstack.com/callback");
    expect(github.searchParams.get("code_challenge_method")).toBe("S256");
    expect(env.OAUTH_PROVIDER.approveConsent).toHaveBeenCalledWith(expect.anything(), "h1", { scope: ["seerstack"] });
  });

  const githubAs = (id: number) =>
    upstream.mockImplementation(async (input) =>
      String(input).includes("access_token")
        ? Response.json({ access_token: "gho_x" })
        : Response.json({ id, login: id === Number(OWNER) ? "dqnamo" : "intruder" }),
    );
  const callback = () => githubCallback(new Request("https://seerstack.com/callback?code=c&state=st"), env);

  it("completes authorization for the owner only", async () => {
    env.OAUTH_PROVIDER = helpers();
    githubAs(Number(OWNER));
    const ok = await callback();
    expect(ok.headers.get("location")).toBe("https://claude.ai/cb?code=abc");
    expect(env.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER, props: { githubId: OWNER, login: "dqnamo" } }),
    );

    env.OAUTH_PROVIDER = helpers();
    githubAs(42);
    const refused = await callback();
    expect(refused.headers.get("location")).toContain("error=access_denied");
    expect(env.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
  });
});
