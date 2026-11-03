import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";

vi.mock(import("../src/projects"), async (original) => ({
  ...(await original()),
  PROJECTS: { site: { name: "Site", domains: ["site.com"] } },
}));

const env = {
  TINYBIRD_HOST: "https://tinybird.test",
  TINYBIRD_INGEST_TOKEN: "ingest-token",
  TINYBIRD_READ_TOKEN: "read-token",
  INGEST_KEY: "ingest-key",
  MCP_TOKEN: "mcp-token",
  ANON_SALT: "salt",
};
const CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

let pending: Promise<unknown>[];
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} });
const tinybird = vi.fn<typeof fetch>();

beforeEach(() => {
  pending = [];
  tinybird.mockReset();
  tinybird.mockImplementation(async () => Response.json({ successful_rows: 1, quarantined_rows: 0 }));
  vi.stubGlobal("fetch", tinybird);
});
afterEach(() => vi.unstubAllGlobals());

const post = (body: unknown, headers: Record<string, string>) =>
  app.request("/e", { method: "POST", body: JSON.stringify(body), headers }, env, ctx() as never);

describe("POST /e", () => {
  it("accepts browser events from the project's domain and writes them in the background", async () => {
    const res = await post(
      { project: "site", event: "$pageview", url: "https://site.com/" },
      { Origin: "https://site.com", "User-Agent": CHROME, "Content-Type": "text/plain" },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, rejected: 0 });
    await Promise.all(pending);
    const [url, init] = tinybird.mock.calls[0] ?? [];
    expect(url).toBe("https://tinybird.test/v0/events?name=events");
    expect(JSON.parse(String(init?.body))).toMatchObject({ project_id: "site", event: "$pageview", path: "/" });
  });

  it("waits for server writes and reports failures", async () => {
    tinybird.mockResolvedValueOnce(new Response("down", { status: 503 }));
    const res = await post({ project: "site", event: "signup", user_id: "u1" }, { Authorization: "Bearer ingest-key" });
    expect(res.status).toBe(502);
  });

  it("rejects a wrong INGEST_KEY instead of treating it as a browser", async () => {
    const res = await post({ project: "site", event: "x" }, { Authorization: "Bearer nope" });
    expect(res.status).toBe(401);
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
  expect(await res.text()).toContain("sendBeacon");
});

describe("/mcp", () => {
  const rpc = (body: unknown, auth = "Bearer mcp-token") =>
    app.request(
      "/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: auth,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...(body as object) }),
      },
      env,
    );

  it("requires MCP_TOKEN", async () => {
    expect((await rpc({ method: "tools/list" }, "Bearer wrong")).status).toBe(401);
  });

  it("lists the analytics tools", async () => {
    const res = await rpc({ method: "tools/list", params: {} });
    const names = ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toEqual([
      "list_projects",
      "overview",
      "timeseries",
      "breakdown",
      "list_events",
      "funnel",
      "get_schema",
      "run_sql",
    ]);
  });

  it("runs tools as parameterized Tinybird queries with the read token", async () => {
    tinybird.mockResolvedValue(
      Response.json({ meta: [], data: [{ value: "/", visitors: "3", events: "5" }], rows: 1 }),
    );
    const res = await rpc({
      method: "tools/call",
      params: { name: "breakdown", arguments: { dimension: "path", period: "today" } },
    });
    const result = ((await res.json()) as { result: { structuredContent: { rows: unknown[] } } }).result;
    expect(result.structuredContent.rows).toEqual([{ value: "/", visitors: 3, events: 5 }]);

    const [url, init] = tinybird.mock.calls[0] ?? [];
    expect(url).toBe("https://tinybird.test/v0/sql");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer read-token" });
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("q")).toMatch(/^%\n/);
    expect(Object.values(Object.fromEntries(form))).toContain("site"); // the only project is the default
  });
});
