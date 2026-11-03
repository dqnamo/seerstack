import { SqlBuilder } from "./analytics";
import { toClickHouseTime } from "./enrich";
import type { Env } from "./env";
import { QueryError } from "./errors";
import { parseDay } from "./periods";
import {
  countEvents,
  eventFilter,
  fetchEvents,
  POSTHOG_HOSTS,
  PosthogError,
  type PosthogSource,
  type VisitorIds,
} from "./posthog";
import { seal } from "./seal";
import { query } from "./tinybird";

// Importing past events from PostHog (ADR 0009). import_posthog checks the key
// and the range, records the import in D1 and starts the PosthogImport
// Workflow, which pages through PostHog in the background
// (src/import-workflow.ts). list_imports and cancel_import read and stop it.

export type ImportStatus = "running" | "completed" | "failed" | "cancelled";

// The Workflow's params. Cloudflare stores and shows them, so the API key is sealed.
export type ImportParams = {
  importId: string;
  projectId: string;
  host: string;
  posthogProjectId: string;
  sealedKey: string;
  events?: string[];
  visitorIds: VisitorIds;
  startMs: number;
  untilMs: number;
};

type Row = {
  id: string;
  project_id: string;
  source: string;
  source_project: string;
  status: ImportStatus;
  range_from: string;
  range_until: string;
  options: string;
  estimated: number;
  imported: number;
  skipped: number;
  position: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

type Db = Pick<Env, "TINYBIRD_HOST" | "TINYBIRD_INGEST_TOKEN" | "TINYBIRD_READ_TOKEN">;

const DAY = 86_400_000;
const LIB = "posthog";

// --- D1 ---------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();

async function getImportRow(db: D1Database, id: string): Promise<Row | null> {
  return db.prepare("SELECT * FROM imports WHERE id = ?").bind(id).first<Row>();
}

async function runningImport(db: D1Database, projectId: string): Promise<Row | null> {
  return db.prepare("SELECT * FROM imports WHERE project_id = ? AND status = 'running'").bind(projectId).first<Row>();
}

// Progress is written as totals, so a retried step can't count a page twice.
// Only running imports change: a cancelled one stays cancelled.
export async function recordProgress(
  db: D1Database,
  id: string,
  progress: { imported: number; skipped: number; positionMs: number },
): Promise<void> {
  await db
    .prepare(
      "UPDATE imports SET imported = ?, skipped = ?, position = ?, updated_at = ? WHERE id = ? AND status = 'running'",
    )
    .bind(progress.imported, progress.skipped, iso(progress.positionMs), iso(Date.now()), id)
    .run();
}

export async function finishImport(
  db: D1Database,
  id: string,
  status: Exclude<ImportStatus, "running">,
  error?: string,
): Promise<void> {
  const now = iso(Date.now());
  await db
    .prepare(
      "UPDATE imports SET status = ?, error = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running'",
    )
    .bind(status, error?.slice(0, 2000) ?? null, now, now, id)
    .run();
}

function toSummary(row: Row) {
  const options = JSON.parse(row.options) as { events?: string[]; visitor_ids: VisitorIds };
  const read = row.imported + row.skipped;
  return {
    id: row.id,
    project: row.project_id,
    source: row.source,
    source_project: row.source_project,
    status: row.status,
    range: { from: row.range_from, until: row.range_until },
    events: options.events ?? "pageviews and custom events",
    visitor_ids: options.visitor_ids,
    progress: {
      estimated: row.estimated,
      imported: row.imported,
      skipped: row.skipped,
      percent:
        row.status === "completed" || row.estimated === 0
          ? 100
          : Math.min(99, Math.floor((read / row.estimated) * 100)),
      through: row.position,
    },
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
}

export type ImportSummary = ReturnType<typeof toSummary>;

// --- Tinybird -----------------------------------------------------------------

const timeBound = (b: SqlBuilder, ms: number) => `toDateTime64(${b.bind(toClickHouseTime(ms))}, 3, 'UTC')`;

async function firstAndLast(db: Db, where: (b: SqlBuilder) => string): Promise<{ first: number; last: number } | null> {
  const b = new SqlBuilder();
  const { sql, params } = b.build(
    `SELECT count() AS n, toUnixTimestamp64Milli(min(timestamp)) AS first, toUnixTimestamp64Milli(max(timestamp)) AS last
FROM events WHERE ${where(b)}`,
  );
  const { data } = await query<{ n: string | number; first: string | number; last: string | number }>(db, sql, params);
  const row = data[0];
  return row && Number(row.n) > 0 ? { first: Number(row.first), last: Number(row.last) } : null;
}

// When Seerstack started recording pageviews itself. Imports stop there by
// default, so no visit is counted twice.
export async function firstLivePageviewMs(db: Db, projectId: string): Promise<number | null> {
  const found = await firstAndLast(
    db,
    (b) => `project_id = ${b.bind(projectId)} AND event = ${b.bind("$pageview")} AND lib != ${b.bind(LIB)}`,
  );
  return found?.first ?? null;
}

// IDs of imported events in [fromMs, toMs], to skip what a retried step already wrote.
export async function importedIds(db: Db, projectId: string, fromMs: number, toMs: number): Promise<Set<string>> {
  const b = new SqlBuilder();
  const { sql, params } = b.build(
    `SELECT event_id FROM events
WHERE project_id = ${b.bind(projectId)} AND lib = ${b.bind(LIB)} AND timestamp >= ${timeBound(b, fromMs)} AND timestamp <= ${timeBound(b, toMs)}`,
  );
  const { data } = await query<{ event_id: string }>(db, sql, params);
  return new Set(data.map((row) => row.event_id));
}

// Where earlier imports of the same PostHog project and events stopped
// reading, so running import_posthog again carries on from there. Pages also
// skip rows that are already in Tinybird, so overlapping imports can't
// duplicate events; this just avoids reading them again.
async function resumePosition(
  db: D1Database,
  projectId: string,
  sourceProject: string,
  events: string[] | undefined,
): Promise<number | null> {
  const { results } = await db
    .prepare(
      "SELECT options, position FROM imports WHERE project_id = ? AND source_project = ? AND status != 'running' AND position IS NOT NULL",
    )
    .bind(projectId, sourceProject)
    .all<{ options: string; position: string }>();
  const key = (list?: string[]) => JSON.stringify(list?.length ? [...list].sort() : null);
  const positions = results
    .filter((row) => key((JSON.parse(row.options) as { events?: string[] }).events) === key(events))
    .map((row) => Date.parse(row.position));
  return positions.length > 0 ? Math.max(...positions) : null;
}

// --- tools --------------------------------------------------------------------

// "us", "eu", or a self-hosted URL. PostHog's ingestion hosts (us.i.posthog.com)
// don't serve the query API, so they map to the app host.
export function posthogHost(input = "us"): string {
  const preset = POSTHOG_HOSTS[input.trim().toLowerCase() as keyof typeof POSTHOG_HOSTS];
  if (preset) return preset;
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    throw new QueryError(`"${input}" isn't a PostHog host`, 'Use "us", "eu", or your self-hosted PostHog URL.');
  }
  url.hostname = url.hostname.replace(/^(us|eu)(-assets)?\.i\.posthog\.com$/, "$1.posthog.com");
  return url.origin;
}

function explain(error: unknown): never {
  if (!(error instanceof PosthogError)) throw error;
  const hints: Record<PosthogError["kind"], string> = {
    auth: "Use a personal API key (phx_…) with the Query Read scope, from PostHog → Settings → Personal API keys, and check the project ID and host (us or eu).",
    rate_limit: "PostHog is rate limiting this key. Try again in a few minutes.",
    timeout: "PostHog took too long. Try a shorter range with date_from/date_to.",
    bad_request: "Check the project ID and the event names.",
    unavailable: "Retry in a moment.",
  };
  throw new QueryError(error.message, hints[error.kind]);
}

export type PosthogImportInput = {
  posthog_project_id: string;
  posthog_api_key: string;
  posthog_host?: string;
  date_from?: string;
  date_to?: string;
  events?: string[];
  visitor_ids?: VisitorIds;
};

export async function startPosthogImport(env: Env, projectId: string, input: PosthogImportInput, now = Date.now()) {
  const running = await runningImport(env.DB, projectId);
  if (running) {
    throw new QueryError(
      `Import ${running.id} is already running for ${projectId}`,
      "Check it with list_imports, or stop it with cancel_import.",
    );
  }
  if (!/^\d+$/.test(input.posthog_project_id)) {
    throw new QueryError(
      "posthog_project_id must be PostHog's numeric project ID",
      "It's in the PostHog URL: https://us.posthog.com/project/<id>.",
    );
  }
  if (input.posthog_api_key.startsWith("phc_")) {
    throw new QueryError(
      "That's the project token (phc_…), which can only send events",
      "Create a personal API key (phx_…) with the Query Read scope in PostHog → Settings → Personal API keys.",
    );
  }

  const fromMs = input.date_from ? parseDay(input.date_from, "date_from").getTime() : 0;
  const untilMs = Math.min(
    now,
    input.date_to
      ? parseDay(input.date_to, "date_to").getTime() + DAY
      : ((await firstLivePageviewMs(env, projectId)) ?? now),
  );
  if (untilMs <= fromMs) {
    throw new QueryError(
      "Nothing to import: the range ends before it starts",
      input.date_to
        ? "date_to is before date_from."
        : `Seerstack has recorded ${projectId} itself since ${iso(untilMs)}; imports stop there unless you pass date_to.`,
    );
  }

  const host = posthogHost(input.posthog_host);
  const sourceProject = `${host}/project/${input.posthog_project_id}`;
  const resumeMs = await resumePosition(env.DB, projectId, sourceProject, input.events);
  const fromOrResume = Math.max(fromMs, resumeMs ?? 0);
  const range = { from: iso(fromOrResume), until: iso(untilMs) };
  const alreadyImported = resumeMs !== null && { note: `Already imported up to ${iso(resumeMs)}.` };
  if (fromOrResume >= untilMs) return { status: "nothing_to_import", range, ...alreadyImported };

  const source: PosthogSource = { host, projectId: input.posthog_project_id, apiKey: input.posthog_api_key };
  const filter = eventFilter(input.events);
  const { count, firstMs } = await countEvents(source, filter, fromOrResume, untilMs).catch(explain);
  if (count === 0 || firstMs === null) return { status: "nothing_to_import", range, ...alreadyImported };
  const startMs = Math.max(fromOrResume, firstMs);
  // Run the page query once now, so an incompatible PostHog fails here rather
  // than in the background.
  await fetchEvents(source, filter, startMs, untilMs, null, 1).catch(explain);

  const id = `imp_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const visitorIds = input.visitor_ids ?? "daily";
  const created = iso(now);
  const insert = env.DB.prepare(
    `INSERT INTO imports (id, project_id, source, source_project, status, range_from, range_until, options, estimated, position, created_at, updated_at)
VALUES (?, ?, 'posthog', ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      projectId,
      sourceProject,
      iso(startMs),
      iso(untilMs),
      JSON.stringify({ ...(input.events?.length && { events: input.events }), visitor_ids: visitorIds }),
      count,
      iso(startMs),
      created,
      created,
    )
    .run();
  // Two imports of one project at once could each write a page before seeing
  // the other's rows, so the database allows only one running import each.
  await insert.catch((error: unknown) => {
    if (/UNIQUE/i.test(String(error))) {
      throw new QueryError(`An import is already running for ${projectId}`, "Check it with list_imports.");
    }
    throw error;
  });

  const params: ImportParams = {
    importId: id,
    projectId,
    host,
    posthogProjectId: input.posthog_project_id,
    sealedKey: await seal(input.posthog_api_key, env.ANON_SALT),
    ...(input.events?.length && { events: input.events }),
    visitorIds,
    startMs,
    untilMs,
  };
  try {
    await env.IMPORTS.create({ id, params });
  } catch (error) {
    await finishImport(env.DB, id, "failed", `Couldn't start the import: ${String(error)}`);
    throw error;
  }
  return toSummary((await getImportRow(env.DB, id)) as Row);
}

// An import whose Workflow stopped without reporting back (it shouldn't, but
// a deploy or an outage could) is marked failed when it's next listed.
async function reconcile(env: Env, row: Row): Promise<Row> {
  if (row.status !== "running") return row;
  let state: InstanceStatus;
  try {
    state = await (await env.IMPORTS.get(row.id)).status();
  } catch {
    return row;
  }
  if (state.status === "errored" || state.status === "terminated") {
    await finishImport(env.DB, row.id, "failed", state.error?.message ?? `The import stopped (${state.status})`);
  } else if (state.status === "complete") {
    await finishImport(env.DB, row.id, "completed");
  } else {
    return row;
  }
  return (await getImportRow(env.DB, row.id)) ?? row;
}

export async function listImports(env: Env, projectId?: string): Promise<ImportSummary[]> {
  const { results } = projectId
    ? await env.DB.prepare("SELECT * FROM imports WHERE project_id = ? ORDER BY created_at DESC LIMIT 20")
        .bind(projectId)
        .all<Row>()
    : await env.DB.prepare("SELECT * FROM imports ORDER BY created_at DESC LIMIT 20").all<Row>();
  return Promise.all(results.map(async (row) => toSummary(await reconcile(env, row))));
}

export async function cancelImport(env: Env, id: string): Promise<ImportSummary> {
  const row = await getImportRow(env.DB, id);
  if (!row) throw new QueryError(`Unknown import "${id}"`, "Call list_imports for import IDs.");
  if (row.status !== "running") throw new QueryError(`Import ${id} isn't running (${row.status})`);
  try {
    await (await env.IMPORTS.get(id)).terminate();
  } catch (error) {
    // Already finished between the read above and now; the D1 update below
    // only applies if it's still running.
    console.warn(`Couldn't terminate import ${id}`, error);
  }
  await finishImport(env.DB, id, "cancelled");
  return toSummary((await getImportRow(env.DB, id)) as Row);
}
