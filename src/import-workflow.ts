import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { toClickHouseTime } from "./enrich";
import type { Env } from "./env";
import { finishImport, type ImportParams, importedIds, recordProgress } from "./imports";
import { eventFilter, fetchEvents, PosthogError, type PosthogEvent, toEventRow } from "./posthog";
import { unseal } from "./seal";
import { appendEvents } from "./tinybird";

// The PostHog import, as a Workflow (ADR 0009). Each step reads one page of
// events from PostHog, writes it to Tinybird and records progress in D1.
// Steps are safe to retry: a page is read again from the same position, and
// rows an earlier attempt already wrote are skipped.

export const PAGE_SIZE = 2_000;
const HOUR = 3_600_000;
const FIRST_WINDOW_MS = 24 * HOUR;
const MIN_WINDOW_MS = HOUR;
const MAX_WINDOW_MS = 30 * 24 * HOUR;

// Where the import has got to. Pages are read from [fromMs, fromMs + windowMs):
// the window grows while pages come back sparse and shrinks when PostHog times
// out, so neither a quiet year nor a busy day makes a slow query.
export type ImportState = {
  fromMs: number;
  windowMs: number;
  /** Events at exactly fromMs up to this UUID have been read. */
  afterUuid: string | null;
  imported: number;
  skipped: number;
  done: boolean;
};

export type PageResult = { state: ImportState } | { waitMs: number } | { fatal: string };

const PAGE_STEP: WorkflowStepConfig = {
  retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
  timeout: "5 minutes",
};

export function initialState(params: ImportParams): ImportState {
  return { fromMs: params.startMs, windowMs: FIRST_WINDOW_MS, afterUuid: null, imported: 0, skipped: 0, done: false };
}

export async function importPage(env: Env, params: ImportParams, state: ImportState): Promise<PageResult> {
  const source = {
    host: params.host,
    projectId: params.posthogProjectId,
    apiKey: await unseal(params.sealedKey, env.ANON_SALT),
  };
  const filter = eventFilter(params.events);

  let windowMs = state.windowMs;
  let toMs: number;
  let events: PosthogEvent[];
  for (;;) {
    toMs = Math.min(state.fromMs + windowMs, params.untilMs);
    try {
      events = await fetchEvents(source, filter, state.fromMs, toMs, state.afterUuid, PAGE_SIZE);
      break;
    } catch (error) {
      if (!(error instanceof PosthogError)) throw error;
      if (error.kind === "timeout" && windowMs > MIN_WINDOW_MS) {
        windowMs = Math.max(MIN_WINDOW_MS, Math.floor(windowMs / 2));
        continue;
      }
      if (error.kind === "rate_limit") return { waitMs: error.retryAfterMs };
      if (error.kind === "auth" || error.kind === "bad_request") return { fatal: error.message };
      throw error; // PostHog is down, or slow even for an hour: the step retries with backoff.
    }
  }

  const options = {
    projectId: params.projectId,
    salt: env.ANON_SALT,
    visitorIds: params.visitorIds,
    receivedAt: toClickHouseTime(Date.now()),
  };
  const rows = (await Promise.all(events.map((e) => toEventRow(e, options)))).filter((row) => row !== null);
  const first = events[0];
  const last = events.at(-1);
  if (rows.length > 0 && first && last) {
    const written = await importedIds(env, params.projectId, first.ms, last.ms);
    const fresh = rows.filter((row) => !written.has(row.event_id));
    if (fresh.length > 0) await appendEvents(env, fresh, { wait: true });
  }

  const totals = { imported: state.imported + rows.length, skipped: state.skipped + events.length - rows.length };
  const next: ImportState =
    events.length === PAGE_SIZE && last
      ? {
          // A full page: carry on inside the same window, after the last event read.
          fromMs: last.ms,
          windowMs,
          afterUuid: last.uuid,
          ...totals,
          done: false,
        }
      : {
          // The window is exhausted: move to the next one, wider if this one was sparse.
          fromMs: toMs,
          windowMs: events.length < PAGE_SIZE / 4 ? Math.min(MAX_WINDOW_MS, windowMs * 2) : windowMs,
          afterUuid: null,
          ...totals,
          done: toMs >= params.untilMs,
        };
  await recordProgress(env.DB, params.importId, { ...totals, positionMs: next.fromMs });
  return { state: next };
}

export class PosthogImport extends WorkflowEntrypoint<Env, ImportParams> {
  async run(event: Readonly<WorkflowEvent<ImportParams>>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    let state = initialState(params);
    try {
      for (let page = 0; !state.done; page++) {
        const current = state;
        const result = await step.do(`page ${page}`, PAGE_STEP, () => importPage(this.env, params, current));
        if ("waitMs" in result) await step.sleep(`rate limited after page ${page}`, result.waitMs);
        else if ("fatal" in result) throw new Error(result.fatal);
        else state = result.state;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("mark failed", () => finishImport(this.env.DB, params.importId, "failed", message));
      return;
    }
    await step.do("mark completed", () => finishImport(this.env.DB, params.importId, "completed"));
  }
}
