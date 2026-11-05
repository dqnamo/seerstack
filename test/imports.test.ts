import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryError } from "../src/errors";
import { PAGE_SIZE } from "../src/import-workflow";
import { type PosthogImportInput, startPosthogImport } from "../src/imports";
import type { EventRow } from "../src/normalize";
import { type ImportWorld, importWorld, MINUTE, msOf, POSTHOG_KEY, T0 } from "./import-world";

// The import end to end: starting it, the Workflow paging through PostHog, and
// list_imports / cancel_import over MCP.

type Summary = {
  id: string;
  status: string;
  range: { from: string; until: string };
  progress: { estimated: number; imported: number; skipped: number; percent: number; through: string };
  error: string | null;
};

let w: ImportWorld;
beforeEach(async () => {
  w = await importWorld();
  vi.stubGlobal("fetch", vi.fn(w.fetch));
});
afterEach(() => vi.unstubAllGlobals());

const input = (args: Partial<PosthogImportInput> = {}): PosthogImportInput => ({
  posthog_project_id: "479710",
  posthog_api_key: POSTHOG_KEY,
  ...args,
});
const start = (args: Partial<PosthogImportInput> = {}) => startPosthogImport(w.env, "dqnamo", input(args));
const startImport = async (args: Partial<PosthogImportInput> = {}) => (await start(args)) as Summary;
// What a refused start says, message and hint together.
const refusal = (args: Partial<PosthogImportInput>) =>
  start(args).then(
    () => "",
    (e: QueryError) => `${e.message} ${e.hint ?? ""}`,
  );
const imports = async () =>
  ((await w.call("list_imports", { project: "dqnamo" })).structuredContent.imports ?? []) as unknown as Summary[];

describe("startPosthogImport and the Workflow", () => {
  it("imports every pageview and custom event once, in the background, and reports progress", async () => {
    const started = await startImport();
    expect(started).toMatchObject({ status: "running", progress: { estimated: w.importable().length, imported: 0 } });
    expect(started.range.from).toBe(new Date(T0).toISOString());
    expect(JSON.stringify([...w.instances.values()][0]?.params)).not.toContain(POSTHOG_KEY);

    await w.runWorkflow(started.id);

    const ids = w.stored.map((r) => r.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(w.importable().length - w.bots().length);
    expect(w.stored.every((r) => r.lib === "posthog" && r.project_id === "dqnamo")).toBe(true);
    expect(w.stored.find((r) => r.event === "experiment_card_clicked")?.properties).toBe(
      JSON.stringify({ experiment: "playing-cards" }),
    );
    expect(w.stored.some((r) => r.event.startsWith("$auto") || r.event === "$pageleave")).toBe(false);

    const [done] = await imports();
    expect(done).toMatchObject({
      status: "completed",
      progress: { imported: ids.length, skipped: w.bots().length, percent: 100 },
      error: null,
    });
    expect(w.importable().length).toBeGreaterThan(2 * PAGE_SIZE);
  });

  it("stops where Seerstack's own tracking begins, and carries on from the last import", async () => {
    const liveFrom = T0 + 10 * 60 * MINUTE;
    w.stored.push({
      project_id: "dqnamo",
      event: "$pageview",
      lib: "seerstack-web",
      timestamp: new Date(liveFrom).toISOString().replace("T", " ").replace("Z", ""),
      event_id: "live-1",
    } as EventRow);

    const first = await startImport();
    expect(first.range.until).toBe(new Date(liveFrom).toISOString());
    await w.runWorkflow(first.id);
    const imported = w.stored.filter((r) => r.lib === "posthog");
    expect(imported.every((r) => msOf(r.timestamp) < liveFrom)).toBe(true);
    expect(imported.length).toBe(w.importable().filter((e) => e.ms < liveFrom && !e.userAgent.includes("bot")).length);

    const again = await start();
    expect(again).toMatchObject({
      status: "nothing_to_import",
      note: expect.stringContaining("Already imported up to"),
    });
  });

  it("carries on from where a failed import stopped", async () => {
    const first = await startImport();
    // The first page goes through, then the key stops working.
    w.posthogFailures.push(null, Response.json({ detail: "API key revoked" }, { status: 401 }));
    await w.runWorkflow(first.id);
    const [failed] = await imports();
    expect(failed?.status).toBe("failed");

    const second = await startImport();
    expect(second.range.from).toBe(failed?.progress.through);
    await w.runWorkflow(second.id);
    const ids = w.stored.map((r) => r.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(w.importable().length - w.bots().length);
  });

  it("doesn't write a page twice when a step is retried after its write landed", async () => {
    w.failAfterWrite = 1;
    await w.runWorkflow((await startImport()).id);
    const ids = w.stored.map((r) => r.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(w.importable().length - w.bots().length);
    expect((await imports())[0]?.progress.imported).toBe(ids.length);
  });

  it("waits out PostHog's rate limit and carries on", async () => {
    const started = await startImport();
    w.posthogFailures.push(
      Response.json({ detail: "Rate limited" }, { status: 429, headers: { "Retry-After": "120" } }),
    );
    await w.runWorkflow(started.id);
    expect(w.sleeps).toEqual([120_000]);
    expect((await imports())[0]?.status).toBe("completed");
  });

  it("fails with PostHog's reason when the key stops working", async () => {
    const started = await startImport();
    w.posthogFailures.push(Response.json({ detail: "API key revoked" }, { status: 401 }));
    await w.runWorkflow(started.id);
    expect((await imports())[0]).toMatchObject({ status: "failed", error: expect.stringContaining("API key revoked") });
  });

  it("allows one running import per project, even when two start at once", async () => {
    const results = await Promise.allSettled([start(), start()]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(QueryError);
    expect(String(rejected.reason.message)).toContain("already running");
    expect(await imports()).toHaveLength(1);
  });

  it("explains bad input before starting anything", async () => {
    expect(await refusal({ posthog_api_key: "phc_token" })).toContain("project token");
    expect(await refusal({ posthog_project_id: "phc_abc" })).toContain("numeric project ID");
    expect(await refusal({ posthog_api_key: "phx_wrong" })).toContain("Query Read scope");
    expect(await refusal({ date_from: "2026-07-02", date_to: "2026-07-01" })).toContain("Nothing to import");
    expect(w.instances.size).toBe(0);

    await startImport();
    expect(await refusal({})).toContain("already running");
  });

  it("keeps finished Workflow instances, and the sealed key in them, for a day", async () => {
    const create = vi.spyOn(w.env.IMPORTS, "create");
    await startImport();
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      retention: { successRetention: "1 day", errorRetention: "1 day" },
    });
  });
});

describe("list_imports, cancel_import and import_posthog over MCP", () => {
  it("stops a running import and keeps it cancelled", async () => {
    const started = await startImport();
    const cancelled = await w.call("cancel_import", { import_id: started.id });
    expect(cancelled.structuredContent.import).toMatchObject({ status: "cancelled" });
    expect(w.instances.get(started.id)?.terminated).toBe(true);

    // A step that was mid-flight can't flip it back.
    await w.runWorkflow(started.id);
    expect((await imports())[0]?.status).toBe("cancelled");
    expect((await w.call("cancel_import", { import_id: started.id })).isError).toBe(true);
  });

  it("marks an import failed if its Workflow died, or disappeared, without reporting back", async () => {
    const started = await startImport();
    const instance = w.instances.get(started.id);
    if (instance) instance.status = "errored";
    expect((await imports())[0]).toMatchObject({ status: "failed", error: expect.stringContaining("errored") });

    w.instances.clear();
    await w.env.DB.prepare("UPDATE imports SET status = 'running', error = NULL").run();
    expect((await imports())[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("without reporting"),
    });
  });

  it("hands out a link to the import page instead of taking a key", async () => {
    const result = await w.call("import_posthog", { project: "dqnamo" });
    expect(result.structuredContent).toMatchObject({ url: "https://seerstack.com/import?project=dqnamo" });
    const unknown = (await w.call("import_posthog", { project: "nope" })).content[0]?.text;
    expect(unknown).toContain('Unknown project "nope"');
    expect(w.instances.size).toBe(0);
  });
});
