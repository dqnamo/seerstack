import type { Env } from "./env";
import { QueryError } from "./errors";
import type { EventRow } from "./normalize";
import { MAX_RESULT_ROWS, validateSql, wrapForExecution } from "./sql-guard";

type TinybirdEnv = Pick<Env, "TINYBIRD_HOST" | "TINYBIRD_INGEST_TOKEN" | "TINYBIRD_READ_TOKEN">;

export type TinybirdJson<T> = {
  meta: { name: string; type: string }[];
  data: T[];
  rows: number;
  statistics?: { elapsed: number; rows_read: number; bytes_read: number };
};

// Appends rows through the Events API (NDJSON). With `wait`, Tinybird answers
// only once the rows are written, so they can be read back straight away.
export async function appendEvents(env: TinybirdEnv, rows: EventRow[], opts: { wait?: boolean } = {}): Promise<void> {
  const res = await fetch(`${env.TINYBIRD_HOST}/v0/events?name=events${opts.wait ? "&wait=true" : ""}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.TINYBIRD_INGEST_TOKEN}` },
    body: rows.map((row) => JSON.stringify(row)).join("\n"),
  });
  if (!res.ok) throw new Error(`Tinybird append failed: ${res.status} ${await res.text()}`);
  const result = (await res.json().catch(() => ({}))) as { quarantined_rows?: number };
  if (result.quarantined_rows) console.warn(`Tinybird quarantined ${result.quarantined_rows} event rows`);
}

function toQueryError(status: number, raw: string): QueryError {
  let message = raw;
  try {
    message = (JSON.parse(raw) as { error?: string }).error ?? raw;
  } catch {}
  // Drop wrapForExecution's wrapper so the error quotes the agent's own SQL.
  message = message
    .replace(/SELECT \* FROM \(\n/g, "")
    .replace(/\n\) LIMIT \d+ SETTINGS [^\n]*(\nFORMAT JSON)?/g, "")
    .replace(/\(query_id=[^)]*\)/g, "")
    .replace(/\s*Contact support@tinybird\.co[^.]*\./g, "")
    .trim();
  if (/TIMEOUT_EXCEEDED|timeout/i.test(message)) {
    return new QueryError(
      "Query took longer than 10 seconds",
      "Narrow the time range, filter by event, or aggregate first.",
    );
  }
  if (status === 401 || status === 403) {
    return new QueryError("Tinybird rejected the read token", "Check TINYBIRD_READ_TOKEN and TINYBIRD_HOST.");
  }
  if (status === 429) return new QueryError("Too many queries", "Wait a second and retry.");
  if (status >= 500) return new QueryError("Tinybird is unavailable", "Retry in a moment.");
  return new QueryError(message.slice(0, 2000), "Fix the SQL and retry. Call get_schema for columns and examples.");
}

// Runs a query with the read-only token. A query that starts with `%` is a
// Tinybird template: `{{String(name)}}` placeholders are bound from `params`
// by Tinybird, so values never need escaping here.
export async function query<T = Record<string, unknown>>(
  env: TinybirdEnv,
  sql: string,
  params: Record<string, string> = {},
): Promise<TinybirdJson<T>> {
  const res = await fetch(`${env.TINYBIRD_HOST}/v0/sql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TINYBIRD_READ_TOKEN}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ ...params, q: `${sql}\nFORMAT JSON` }),
  });
  const raw = await res.text();
  if (!res.ok) throw toQueryError(res.status, raw);
  return JSON.parse(raw) as TinybirdJson<T>;
}

export type SqlResult = {
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  stats: { elapsed_ms: number; rows_read: number; bytes_read: number };
};

// Agent-written SQL: validated, then capped on rows, time and memory.
export async function runSql(env: TinybirdEnv, sql: string): Promise<SqlResult> {
  const json = await query(env, wrapForExecution(validateSql(sql)));
  const rows = json.data.slice(0, MAX_RESULT_ROWS);
  return {
    columns: json.meta,
    rows,
    row_count: rows.length,
    truncated: json.data.length > MAX_RESULT_ROWS,
    stats: {
      elapsed_ms: Math.round((json.statistics?.elapsed ?? 0) * 1000),
      rows_read: json.statistics?.rows_read ?? 0,
      bytes_read: json.statistics?.bytes_read ?? 0,
    },
  };
}
