import type { WorkflowStep } from "cloudflare:workers";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { PAGE_SIZE, PosthogImport } from "../src/import-workflow";
import type { ImportParams } from "../src/imports";
import { mcpHandler } from "../src/index";
import type { EventRow } from "../src/normalize";
import { clearKeyCache, createProject } from "../src/projects";
import { fakeD1 } from "./d1";

// The import end to end through the MCP tools, against stand-ins for PostHog's
// query API, Tinybird and the Workflows runtime.

const CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const T0 = Date.parse("2026-06-21T08:00:00.000Z");
const MINUTE = 60_000;
const KEY = "phx_test_key";

type Fixture = { uuid: string; event: string; ms: number; userAgent: string; properties?: string };

// --- PostHog: answers the import's own HogQL ----------------------------------

let posthogEvents: Fixture[];
// Queued answers for the next PostHog requests; null answers normally.
let posthogFailures: (Response | null)[];

function inRange(sql: string, ms: number) {
  const from = Number(/toUnixTimestamp64Milli\(timestamp\) >= (\d+)/.exec(sql)?.[1]);
  const to = Number(/toUnixTimestamp64Milli\(timestamp\) < (\d+)/.exec(sql)?.[1]);
  return ms >= from && ms < to;
}

function matchesFilter(sql: string, event: string) {
  const names = /event IN \(([^)]*)\)/.exec(sql)?.[1];
  if (names) return names.split(", ").includes(`'${event}'`);
  return event === "$pageview" || !event.startsWith("$");
}

function posthog(request: Request, sql: string): Response {
  if (request.headers.get("authorization") !== `Bearer ${KEY}`) {
    return Response.json({ detail: "Invalid personal API key." }, { status: 401 });
  }
  const failure = posthogFailures.shift();
  if (failure) return failure;
  // ClickHouse compares strings byte by byte.
  const matching = posthogEvents
    .filter((e) => inRange(sql, e.ms) && matchesFilter(sql, e.event))
    .sort((a, b) => a.ms - b.ms || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
  if (sql.startsWith("SELECT count()")) {
    return Response.json({ results: [[matching.length, matching[0]?.ms ?? null]] });
  }
  const after = /> (\d+) OR toString\(uuid\) > '([^']+)'/.exec(sql);
  const limit = Number(/LIMIT (\d+)$/.exec(sql)?.[1]);
  const page = matching.filter((e) => !after || e.ms > Number(after[1]) || e.uuid > (after[2] ?? "")).slice(0, limit);
  return Response.json({
    results: page.map((e) => [
      e.uuid,
      e.event,
      e.ms,
      "anon-1",
      "https://dqnamo.com/",
      "$direct",
      null,
      e.userAgent,
      "Chrome",
      "Mac OS X",
      "Desktop",
      "GB",
      "England",
      "London",
      "anon-1",
      false,
      e.event === "$pageview" ? "" : (e.properties ?? "{}"),
    ]),
  });
}

// --- Tinybird: an in-memory events table ----------------------------------------

let stored: EventRow[];
let failAfterWrite: number;

const msOf = (timestamp: string) => Date.parse(`${timestamp.replace(" ", "T")}Z`);

function tinybirdSql(form: URLSearchParams): Response {
  const q = form.get("q") ?? "";
  const p = (n: number) => form.get(`p${n}`) ?? "";
  if (q.includes("SELECT event_id")) {
    const rows = stored.filter(
      (r) => r.project_id === p(0) && r.lib === p(1) && r.timestamp >= p(2) && r.timestamp <= p(3),
    );
    return Response.json({ data: rows.map((r) => ({ event_id: r.event_id })) });
  }
  // firstLivePageviewMs: project, event, lib
  const rows = stored.filter((r) => r.project_id === p(0) && r.event === p(1) && r.lib !== p(2));
  const times = rows.map((r) => msOf(r.timestamp));
  return Response.json({
    data: [
      {
        n: String(rows.length),
        first: String(rows.length ? Math.min(...times) : 0),
        last: String(rows.length ? Math.max(...times) : 0),
      },
    ],
  });
}

async function upstream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.host === "us.posthog.com") {
    const body = (await request.json()) as { query: { query: string } };
    return posthog(request, body.query.query);
  }
  if (url.pathname === "/v0/events") {
    expect(url.searchParams.get("wait")).toBe("true");
    for (const line of (await request.text()).split("\n")) stored.push(JSON.parse(line) as EventRow);
    if (failAfterWrite-- > 0) throw new TypeError("network connection lost");
    return Response.json({ successful_rows: 1, quarantined_rows: 0 });
  }
  if (url.pathname === "/v0/sql") return tinybirdSql(new URLSearchParams(await request.text()));
  throw new Error(`Unexpected fetch: ${request.url}`);
}

// --- Workflows: instances run when the test says so -----------------------------

type Instance = { params: ImportParams; status: InstanceStatus["status"]; terminated: boolean };
let instances: Map<string, Instance>;
let sleeps: number[];

const workflowBinding = {
  create: async ({ id, params }: { id: string; params: ImportParams }) => {
    instances.set(id, { params, status: "queued", terminated: false });
    return { id };
  },
  get: async (id: string) => {
    const instance = instances.get(id);
    if (!instance) throw new Error("instance.not_found");
    return {
      id,
      status: async () => ({ status: instance.status }),
      terminate: async () => {
        instance.terminated = true;
        instance.status = "terminated";
      },
    };
  },
};

// Steps retry like the runtime does (without the waiting).
const step = {
  do: async (_name: string, configOrCallback: unknown, callback?: unknown) => {
    const fn = (typeof configOrCallback === "function" ? configOrCallback : callback) as () => Promise<unknown>;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (attempt === 5) throw error;
      }
    }
  },
  sleep: async (_name: string, ms: number) => {
    sleeps.push(ms);
  },
} as unknown as WorkflowStep;

async function runWorkflow(id: string) {
  const instance = instances.get(id);
  if (!instance) throw new Error(`No instance ${id}`);
  instance.status = "running";
  const payload = instance.params;
  await new PosthogImport({} as ExecutionContext, env).run(
    { payload, timestamp: new Date(), instanceId: id, workflowName: "seerstack-posthog-import" },
    step,
  );
  instance.status = "complete";
}

// --- MCP ---------------------------------------------------------------------------

let env: Env;

type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, never> };

async function call(name: string, args: object): Promise<ToolResult> {
  const res = await mcpHandler.fetch(
    new Request("https://seerstack.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    { waitUntil() {}, passThroughOnException() {}, props: { githubId: "1", login: "owner" } } as never,
  );
  return ((await res.json()) as { result: ToolResult }).result;
}

type Summary = {
  id: string;
  status: string;
  range: { from: string; until: string };
  progress: { estimated: number; imported: number; skipped: number; percent: number; through: string };
  error: string | null;
};

const startImport = async (args: object = {}) => {
  const result = await call("import_posthog", {
    project: "dqnamo",
    posthog_project_id: "479710",
    posthog_api_key: KEY,
    ...args,
  });
  if (result.isError) throw new Error(result.content[0]?.text);
  return result.structuredContent.import as unknown as Summary;
};
const imports = async () =>
  ((await call("list_imports", { project: "dqnamo" })).structuredContent.imports ?? []) as unknown as Summary[];

beforeEach(async () => {
  clearKeyCache();
  stored = [];
  failAfterWrite = 0;
  posthogFailures = [];
  instances = new Map();
  sleeps = [];
  env = {
    DB: fakeD1(),
    IMPORTS: workflowBinding as unknown as Env["IMPORTS"],
    OAUTH_KV: {} as KVNamespace,
    OAUTH_PROVIDER: {} as OAuthHelpers,
    TINYBIRD_HOST: "https://tinybird.test",
    TINYBIRD_INGEST_TOKEN: "ingest-token",
    TINYBIRD_READ_TOKEN: "read-token",
    ANON_SALT: "salt",
    GITHUB_CLIENT_ID: "gh-client",
    GITHUB_CLIENT_SECRET: "gh-secret",
    ALLOWED_GITHUB_USER_ID: "1",
  };
  await createProject(env.DB, { name: "dqnamo", domains: ["dqnamo.com"] });

  // Three events per minute for 25 hours, so pages end mid-millisecond; every
  // 50th is a bot. Plus PostHog's automatic events and a custom event.
  posthogEvents = Array.from({ length: 4_500 }, (_, i) => ({
    uuid: `0197a1b2-0000-7000-8000-${String(i).padStart(12, "0")}`,
    event: "$pageview",
    ms: T0 + Math.floor(i / 3) * MINUTE,
    userAgent: i % 50 === 0 ? "Googlebot/2.1" : CHROME,
  }));
  // 2,500 server-side events sharing one millisecond: more than a page.
  for (let i = 0; i < 2_500; i++) {
    posthogEvents.push({
      uuid: `0197a1b2-0000-7000-a000-${String(i).padStart(12, "0")}`,
      event: "invoice_sent",
      ms: T0 + 30 * MINUTE,
      userAgent: "",
    });
  }
  posthogEvents.push(
    { uuid: "0197a1b2-0000-7000-9000-000000000001", event: "$autocapture", ms: T0 + 5 * MINUTE, userAgent: CHROME },
    { uuid: "0197a1b2-0000-7000-9000-000000000002", event: "$pageleave", ms: T0 + 6 * MINUTE, userAgent: CHROME },
    {
      uuid: "0197a1b2-0000-7000-9000-000000000003",
      event: "experiment_card_clicked",
      ms: T0 + 7 * MINUTE,
      userAgent: CHROME,
      properties: JSON.stringify({ experiment: "playing-cards", $current_url: "https://dqnamo.com/" }),
    },
  );
  vi.stubGlobal("fetch", vi.fn(upstream));
});
afterEach(() => vi.unstubAllGlobals());

const importable = () => posthogEvents.filter((e) => e.event === "$pageview" || !e.event.startsWith("$"));
const bots = () => importable().filter((e) => e.userAgent.includes("bot"));

describe("import_posthog", () => {
  it("imports every pageview and custom event once, in the background, and reports progress", async () => {
    const started = await startImport();
    expect(started).toMatchObject({ status: "running", progress: { estimated: importable().length, imported: 0 } });
    expect(started.range.from).toBe(new Date(T0).toISOString());
    expect(JSON.stringify([...instances.values()][0]?.params)).not.toContain(KEY);

    await runWorkflow(started.id);

    const ids = stored.map((r) => r.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(importable().length - bots().length);
    expect(stored.every((r) => r.lib === "posthog" && r.project_id === "dqnamo")).toBe(true);
    expect(stored.find((r) => r.event === "experiment_card_clicked")?.properties).toBe(
      JSON.stringify({ experiment: "playing-cards" }),
    );
    expect(stored.some((r) => r.event.startsWith("$auto") || r.event === "$pageleave")).toBe(false);

    const [done] = await imports();
    expect(done).toMatchObject({
      status: "completed",
      progress: { imported: ids.length, skipped: bots().length, percent: 100 },
      error: null,
    });
    expect(importable().length).toBeGreaterThan(2 * PAGE_SIZE);
  });

  it("stops where Seerstack's own tracking begins, and carries on from the last import", async () => {
    const liveFrom = T0 + 10 * 60 * MINUTE;
    stored.push({
      project_id: "dqnamo",
      event: "$pageview",
      lib: "seerstack-web",
      timestamp: new Date(liveFrom).toISOString().replace("T", " ").replace("Z", ""),
      event_id: "live-1",
    } as EventRow);

    const first = await startImport();
    expect(first.range.until).toBe(new Date(liveFrom).toISOString());
    await runWorkflow(first.id);
    const imported = stored.filter((r) => r.lib === "posthog");
    expect(imported.every((r) => msOf(r.timestamp) < liveFrom)).toBe(true);
    expect(imported.length).toBe(importable().filter((e) => e.ms < liveFrom && !e.userAgent.includes("bot")).length);

    const again = await call("import_posthog", {
      project: "dqnamo",
      posthog_project_id: "479710",
      posthog_api_key: KEY,
    });
    expect(again.structuredContent.import).toMatchObject({ status: "nothing_to_import" });
    expect(JSON.stringify(again.structuredContent)).toContain("Already imported up to");
  });

  it("carries on from where a failed import stopped", async () => {
    const first = await startImport();
    // The first page goes through, then the key stops working.
    posthogFailures.push(null, Response.json({ detail: "API key revoked" }, { status: 401 }));
    await runWorkflow(first.id);
    const [failed] = await imports();
    expect(failed?.status).toBe("failed");

    const second = await startImport();
    expect(second.range.from).toBe(failed?.progress.through);
    await runWorkflow(second.id);
    const ids = stored.map((r) => r.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(importable().length - bots().length);
  });

  it("doesn't write a page twice when a step is retried after its write landed", async () => {
    failAfterWrite = 1;
    await runWorkflow((await startImport()).id);
    const ids = stored.map((r) => r.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(importable().length - bots().length);
    expect((await imports())[0]?.progress.imported).toBe(ids.length);
  });

  it("waits out PostHog's rate limit and carries on", async () => {
    const started = await startImport();
    posthogFailures.push(Response.json({ detail: "Rate limited" }, { status: 429, headers: { "Retry-After": "120" } }));
    await runWorkflow(started.id);
    expect(sleeps).toEqual([120_000]);
    expect((await imports())[0]?.status).toBe("completed");
  });

  it("fails with PostHog's reason when the key stops working", async () => {
    const started = await startImport();
    posthogFailures.push(Response.json({ detail: "API key revoked" }, { status: 401 }));
    await runWorkflow(started.id);
    expect((await imports())[0]).toMatchObject({ status: "failed", error: expect.stringContaining("API key revoked") });
  });

  it("allows one running import per project, even when two start at once", async () => {
    const [a, b] = await Promise.all([
      call("import_posthog", { project: "dqnamo", posthog_project_id: "479710", posthog_api_key: KEY }),
      call("import_posthog", { project: "dqnamo", posthog_project_id: "479710", posthog_api_key: KEY }),
    ]);
    expect([a.isError, b.isError].sort()).toEqual([true, undefined]);
    expect((a.isError ? a : b).content[0]?.text).toContain("already running");
    expect(await imports()).toHaveLength(1);
  });

  it("explains bad input before starting anything", async () => {
    const attempt = (args: object) =>
      call("import_posthog", { project: "dqnamo", posthog_project_id: "479710", posthog_api_key: KEY, ...args });
    expect((await attempt({ posthog_api_key: "phc_token" })).content[0]?.text).toContain("project token");
    expect((await attempt({ posthog_project_id: "phc_abc" })).content[0]?.text).toContain("numeric project ID");
    expect((await attempt({ posthog_api_key: "phx_wrong" })).content[0]?.text).toContain("Query Read scope");
    expect((await attempt({ date_from: "2026-07-02", date_to: "2026-07-01" })).content[0]?.text).toContain(
      "Nothing to import",
    );
    expect(instances.size).toBe(0);

    await startImport();
    expect((await attempt({})).content[0]?.text).toContain("already running");
  });
});

describe("cancel_import and list_imports", () => {
  it("stops a running import and keeps it cancelled", async () => {
    const started = await startImport();
    const cancelled = await call("cancel_import", { import_id: started.id });
    expect(cancelled.structuredContent.import).toMatchObject({ status: "cancelled" });
    expect(instances.get(started.id)?.terminated).toBe(true);

    // A step that was mid-flight can't flip it back.
    await runWorkflow(started.id);
    expect((await imports())[0]?.status).toBe("cancelled");
    expect((await call("cancel_import", { import_id: started.id })).isError).toBe(true);
  });

  it("marks an import failed if its Workflow died without reporting back", async () => {
    const started = await startImport();
    const instance = instances.get(started.id);
    if (instance) instance.status = "errored";
    expect((await imports())[0]).toMatchObject({ status: "failed", error: expect.stringContaining("errored") });
  });
});
