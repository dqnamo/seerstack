import type { WorkflowStep } from "cloudflare:workers";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../src/env";
import { PosthogImport } from "../src/import-workflow";
import type { ImportParams } from "../src/imports";
import { mcpHandler } from "../src/index";
import type { EventRow } from "../src/normalize";
import { clearKeyCache, createProject } from "../src/projects";
import { fakeD1 } from "./d1";

// Stand-ins for everything an import touches: PostHog's query API (answering
// the import's own HogQL from a fixture), Tinybird (an in-memory events table),
// the Workflows runtime (instances run when a test says so) and GitHub sign-in.

export const OWNER = "1";
export const POSTHOG_KEY = "phx_test_key";
export const T0 = Date.parse("2026-06-21T08:00:00.000Z");
export const MINUTE = 60_000;
const CHROME = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

export type Fixture = { uuid: string; event: string; ms: number; userAgent: string; properties?: string };
type Instance = { params: ImportParams; status: InstanceStatus["status"]; terminated: boolean };
type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, never> };

export const msOf = (timestamp: string) => Date.parse(`${timestamp.replace(" ", "T")}Z`);

// Three pageviews a minute for 25 hours, so pages end mid-millisecond, every
// 50th from a bot; 2,500 server events sharing one millisecond (more than a
// page); PostHog's automatic events; and a custom event.
function fixture(): Fixture[] {
  const events: Fixture[] = Array.from({ length: 4_500 }, (_, i) => ({
    uuid: `0197a1b2-0000-7000-8000-${String(i).padStart(12, "0")}`,
    event: "$pageview",
    ms: T0 + Math.floor(i / 3) * MINUTE,
    userAgent: i % 50 === 0 ? "Googlebot/2.1" : CHROME,
  }));
  for (let i = 0; i < 2_500; i++) {
    events.push({
      uuid: `0197a1b2-0000-7000-a000-${String(i).padStart(12, "0")}`,
      event: "invoice_sent",
      ms: T0 + 30 * MINUTE,
      userAgent: "",
    });
  }
  events.push(
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
  return events;
}

export type ImportWorld = Awaited<ReturnType<typeof importWorld>>;

export async function importWorld() {
  clearKeyCache();
  const world = {
    posthogEvents: fixture(),
    /** Queued answers for the next PostHog requests; null answers normally. */
    posthogFailures: [] as (Response | null)[],
    stored: [] as EventRow[],
    /** Tinybird appends that land and then fail, like a lost connection. */
    failAfterWrite: 0,
    instances: new Map<string, Instance>(),
    sleeps: [] as number[],
    githubUser: { id: Number(OWNER), login: "owner" },
    env: undefined as unknown as Env,
    importable: () => world.posthogEvents.filter((e) => e.event === "$pageview" || !e.event.startsWith("$")),
    bots: () => world.importable().filter((e) => e.userAgent.includes("bot")),
    fetch: upstream,
    runWorkflow,
    call,
  };

  function posthog(request: Request, sql: string): Response {
    if (request.headers.get("authorization") !== `Bearer ${POSTHOG_KEY}`) {
      return Response.json({ detail: "Invalid personal API key." }, { status: 401 });
    }
    const failure = world.posthogFailures.shift();
    if (failure) return failure;
    const from = Number(/toUnixTimestamp64Milli\(timestamp\) >= (\d+)/.exec(sql)?.[1]);
    const to = Number(/toUnixTimestamp64Milli\(timestamp\) < (\d+)/.exec(sql)?.[1]);
    const names = /event IN \(([^)]*)\)/.exec(sql)?.[1]?.split(", ");
    // ClickHouse compares strings byte by byte.
    const matching = world.posthogEvents
      .filter((e) => e.ms >= from && e.ms < to)
      .filter((e) => (names ? names.includes(`'${e.event}'`) : e.event === "$pageview" || !e.event.startsWith("$")))
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

  function tinybirdSql(form: URLSearchParams): Response {
    const q = form.get("q") ?? "";
    const p = (n: number) => form.get(`p${n}`) ?? "";
    if (q.includes("SELECT event_id")) {
      const rows = world.stored.filter(
        (r) => r.project_id === p(0) && r.lib === p(1) && r.timestamp >= p(2) && r.timestamp <= p(3),
      );
      return Response.json({ data: rows.map((r) => ({ event_id: r.event_id })) });
    }
    // firstLivePageviewMs: project, event, lib
    const rows = world.stored.filter((r) => r.project_id === p(0) && r.event === p(1) && r.lib !== p(2));
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
      if (url.searchParams.get("wait") !== "true") throw new Error("Imports must write with wait=true");
      for (const line of (await request.text()).split("\n")) world.stored.push(JSON.parse(line) as EventRow);
      if (world.failAfterWrite-- > 0) throw new TypeError("network connection lost");
      return Response.json({ successful_rows: 1, quarantined_rows: 0 });
    }
    if (url.pathname === "/v0/sql") return tinybirdSql(new URLSearchParams(await request.text()));
    if (url.href === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gh-token" });
    if (url.href === "https://api.github.com/user") return Response.json(world.githubUser);
    throw new Error(`Unexpected fetch: ${request.url}`);
  }

  const workflows = {
    create: async ({ id, params }: { id: string; params: ImportParams }) => {
      world.instances.set(id, { params, status: "queued", terminated: false });
      return { id };
    },
    get: async (id: string) => {
      const instance = world.instances.get(id);
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
      world.sleeps.push(ms);
    },
  } as unknown as WorkflowStep;

  async function runWorkflow(id: string) {
    const instance = world.instances.get(id);
    if (!instance) throw new Error(`No instance ${id}`);
    instance.status = "running";
    await new PosthogImport({} as ExecutionContext, world.env).run(
      { payload: instance.params, timestamp: new Date(), instanceId: id, workflowName: "seerstack-posthog-import" },
      step,
    );
    instance.status = "complete";
  }

  async function call(name: string, args: object): Promise<ToolResult> {
    const res = await mcpHandler.fetch(
      new Request("https://seerstack.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }),
      world.env,
      { waitUntil() {}, passThroughOnException() {}, props: { githubId: OWNER, login: "owner" } } as never,
    );
    return ((await res.json()) as { result: ToolResult }).result;
  }

  world.env = {
    DB: fakeD1(),
    IMPORTS: workflows as unknown as Env["IMPORTS"],
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
  await createProject(world.env.DB, { name: "dqnamo", domains: ["dqnamo.com"] });
  return world;
}
