import { toClickHouseTime } from "./enrich";
import type { Env } from "./env";
import { QueryError } from "./errors";
import { BUCKET_SQL, bucketKeys, type Interval, previousRange, type Range } from "./periods";
import { query } from "./tinybird";

// The prebuilt questions behind the MCP tools. Each `*Sql` function returns a
// Tinybird template plus its params; the matching function runs it and shapes
// the result.

type Db = Pick<Env, "TINYBIRD_HOST" | "TINYBIRD_INGEST_TOKEN" | "TINYBIRD_READ_TOKEN">;

export const DIMENSIONS = [
  "event",
  "path",
  "host",
  "referrer_domain",
  "referrer",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "country",
  "region",
  "city",
  "browser",
  "os",
  "device",
] as const;

// Empty values (direct traffic, no UTM, ...) are shown as "(none)", and
// filtering on "(none)" matches them.
const NONE = "(none)";
const PAGEVIEW = "$pageview";
const IDENTIFY = "$identify";
const SESSION_GAP_SECONDS = 30 * 60;

export type Filters = Record<string, string>;
export type Sql = { sql: string; params: Record<string, string> };

// Every value goes through bind() and becomes a `{{String(pN)}}` placeholder
// that Tinybird fills in. Only allowlisted column names and validated numbers
// are written into the SQL directly.
export class SqlBuilder {
  readonly params: Record<string, string> = {};
  private count = 0;

  bind(value: string): string {
    const name = `p${this.count++}`;
    this.params[name] = value;
    return `{{String(${name})}}`;
  }

  column(dimension: string): string {
    if ((DIMENSIONS as readonly string[]).includes(dimension)) return dimension;
    const property = /^properties\.(.+)$/.exec(dimension)?.[1];
    if (property) return `JSONExtractString(properties, ${this.bind(property)})`;
    throw new QueryError(
      `Unknown dimension "${dimension}"`,
      `Use one of ${DIMENSIONS.join(", ")}, or properties.<key>.`,
    );
  }

  scope(project: string, range: Range, filters: Filters = {}): string[] {
    return [
      `project_id = ${this.bind(project)}`,
      `timestamp >= toDateTime64(${this.bind(toClickHouseTime(range.from.getTime()))}, 3, 'UTC')`,
      `timestamp < toDateTime64(${this.bind(toClickHouseTime(range.to.getTime()))}, 3, 'UTC')`,
      ...Object.entries(filters).map(
        ([dimension, value]) => `${this.column(dimension)} = ${this.bind(value === NONE ? "" : value)}`,
      ),
    ];
  }

  build(body: string): Sql {
    return { sql: `%\n${body}`, params: this.params };
  }
}

const where = (conditions: string[]) => `WHERE ${conditions.join("\n  AND ")}`;
const num = (value: unknown) => Number(value ?? 0);
const rangeJson = (range: Range) => ({ from: range.from.toISOString(), to: range.to.toISOString() });

function positiveInt(value: number, name: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new QueryError(`${name} must be 1-${max}`);
  return value;
}

// --- overview -------------------------------------------------------------

const METRICS = [
  "visitors",
  "pageviews",
  "sessions",
  "bounce_rate",
  "avg_session_seconds",
  "views_per_session",
  "events",
] as const;
type Metrics = Record<(typeof METRICS)[number], number>;

// Sessions are derived, not tracked: a visitor's pageviews more than 30
// minutes apart start a new session.
export function overviewSql(project: string, range: Range, filters?: Filters): Sql {
  const b = new SqlBuilder();
  const scope = b.scope(project, range, filters);
  const pageview = b.bind(PAGEVIEW);
  return b.build(`WITH
  views AS (
    SELECT distinct_id, timestamp FROM events
    ${where([...scope, `event = ${pageview}`])}
  ),
  marked AS (
    SELECT distinct_id, timestamp,
      dateDiff('second', lagInFrame(timestamp, 1, toDateTime64(0, 3, 'UTC')) OVER (PARTITION BY distinct_id ORDER BY timestamp ROWS BETWEEN 1 PRECEDING AND CURRENT ROW), timestamp) > ${SESSION_GAP_SECONDS} AS is_new
    FROM views
  ),
  sessions AS (
    SELECT distinct_id, session, count() AS views, dateDiff('second', min(timestamp), max(timestamp)) AS seconds
    FROM (
      SELECT distinct_id, timestamp, sum(is_new) OVER (PARTITION BY distinct_id ORDER BY timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS session
      FROM marked
    )
    GROUP BY distinct_id, session
  )
SELECT
  uniqExact(distinct_id) AS visitors,
  sum(views) AS pageviews,
  count() AS sessions,
  if(count() = 0, 0, round(countIf(views = 1) / count() * 100, 1)) AS bounce_rate,
  if(count() = 0, 0, round(avg(seconds))) AS avg_session_seconds,
  if(count() = 0, 0, round(sum(views) / count(), 2)) AS views_per_session,
  (SELECT count() FROM events ${where([...scope, `event != ${pageview}`])}) AS events
FROM sessions`);
}

async function metrics(db: Db, project: string, range: Range, filters?: Filters): Promise<Metrics> {
  const { sql, params } = overviewSql(project, range, filters);
  const row = (await query(db, sql, params)).data[0] ?? {};
  return Object.fromEntries(METRICS.map((m) => [m, num(row[m])])) as Metrics;
}

export async function overview(db: Db, project: string, range: Range, filters?: Filters, compare = true) {
  const previous = previousRange(range);
  const [now, before] = await Promise.all([
    metrics(db, project, range, filters),
    compare ? metrics(db, project, previous, filters) : undefined,
  ]);
  if (!before) return { project, range: rangeJson(range), metrics: now };
  const change = Object.fromEntries(
    METRICS.map((m) => [m, before[m] === 0 ? null : Math.round(((now[m] - before[m]) / before[m]) * 1000) / 10]),
  );
  return {
    project,
    range: rangeJson(range),
    metrics: now,
    previous: { range: rangeJson(previous), metrics: before },
    change_pct: change,
  };
}

// --- timeseries -----------------------------------------------------------

export function timeseriesSql(
  project: string,
  range: Range,
  interval: Interval,
  event: string,
  filters?: Filters,
): Sql {
  const b = new SqlBuilder();
  const conditions = [...b.scope(project, range, filters), `event = ${b.bind(event)}`];
  return b.build(`SELECT ${BUCKET_SQL[interval]} AS bucket, uniqExact(distinct_id) AS visitors, count() AS events
FROM events
${where(conditions)}
GROUP BY bucket
ORDER BY bucket`);
}

export async function timeseries(
  db: Db,
  project: string,
  range: Range,
  interval: Interval,
  event: string,
  filters?: Filters,
) {
  const keys = bucketKeys(range, interval);
  const { sql, params } = timeseriesSql(project, range, interval, event, filters);
  const rows = (await query<{ bucket: string; visitors: unknown; events: unknown }>(db, sql, params)).data;
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  return {
    project,
    range: rangeJson(range),
    interval,
    event,
    series: keys.map((bucket) => {
      const row = byBucket.get(bucket);
      return { bucket, visitors: num(row?.visitors), events: num(row?.events) };
    }),
  };
}

// --- breakdown ------------------------------------------------------------

export function breakdownSql(
  project: string,
  range: Range,
  dimension: string,
  event: string | undefined,
  filters: Filters | undefined,
  limit: number,
): Sql {
  const b = new SqlBuilder();
  const conditions = b.scope(project, range, filters);
  if (event) conditions.push(`event = ${b.bind(event)}`);
  return b.build(`SELECT ${b.column(dimension)} AS value, uniqExact(distinct_id) AS visitors, count() AS events
FROM events
${where(conditions)}
GROUP BY value
ORDER BY visitors DESC, events DESC
LIMIT ${positiveInt(limit, "limit", 1000)}`);
}

export async function breakdown(
  db: Db,
  project: string,
  range: Range,
  dimension: string,
  event: string | undefined,
  filters: Filters | undefined,
  limit: number,
) {
  const { sql, params } = breakdownSql(project, range, dimension, event, filters, limit);
  const rows = (await query<{ value: string; visitors: unknown; events: unknown }>(db, sql, params)).data;
  return {
    project,
    range: rangeJson(range),
    dimension,
    event: event ?? "(all events)",
    rows: rows.map((r) => ({
      value: r.value === "" ? NONE : r.value,
      visitors: num(r.visitors),
      events: num(r.events),
    })),
  };
}

// --- events ---------------------------------------------------------------

export function eventsSql(project: string, range: Range): Sql {
  const b = new SqlBuilder();
  return b.build(`SELECT
  event,
  count() AS events,
  uniqExact(distinct_id) AS users,
  toString(max(timestamp)) AS last_seen,
  groupUniqArrayArray(50)(JSONExtractKeys(properties)) AS property_keys
FROM events
${where(b.scope(project, range))}
GROUP BY event
ORDER BY events DESC
LIMIT 500`);
}

export async function listEvents(db: Db, project: string, range: Range) {
  const { sql, params } = eventsSql(project, range);
  const rows = (await query<Record<string, unknown>>(db, sql, params)).data;
  return {
    project,
    range: rangeJson(range),
    events: rows.map((r) => ({ ...r, events: num(r.events), users: num(r.users) })),
  };
}

// --- funnel ---------------------------------------------------------------

export type FunnelStep = { event: string; path?: string };

// People are user_id when known. Anonymous visitors who later called identify
// (same anonymous_id) count as that user, so a funnel can start before signup.
export function funnelSql(project: string, range: Range, steps: FunnelStep[], windowSeconds: number): Sql {
  if (steps.length < 2 || steps.length > 10) throw new QueryError("A funnel needs 2-10 steps");
  const b = new SqlBuilder();
  const conditions = steps.map((s) =>
    s.path ? `event = ${b.bind(s.event)} AND path = ${b.bind(s.path)}` : `event = ${b.bind(s.event)}`,
  );
  const names = [...new Set(steps.map((s) => s.event))].map((e) => b.bind(e));
  return b.build(`WITH aliases AS (
  SELECT anonymous_id, any(user_id) AS alias FROM events
  WHERE project_id = ${b.bind(project)} AND event = ${b.bind(IDENTIFY)} AND user_id != '' AND anonymous_id != ''
  GROUP BY anonymous_id
)
SELECT level, count() AS people FROM (
  SELECT
    coalesce(nullIf(events.user_id, ''), nullIf(aliases.alias, ''), events.anonymous_id) AS person,
    windowFunnel(${positiveInt(windowSeconds, "window", 90 * 86_400)})(toDateTime(timestamp), ${conditions.map((c) => `(${c})`).join(", ")}) AS level
  FROM events
  LEFT JOIN aliases ON aliases.anonymous_id = events.anonymous_id
  ${where([...b.scope(project, range), `event IN (${names.join(", ")})`])}
  GROUP BY person
)
WHERE person != '' AND level > 0
GROUP BY level
ORDER BY level`);
}

export async function funnel(db: Db, project: string, range: Range, steps: FunnelStep[], windowSeconds: number) {
  const { sql, params } = funnelSql(project, range, steps, windowSeconds);
  const rows = (await query<{ level: unknown; people: unknown }>(db, sql, params)).data;
  // windowFunnel returns the furthest step reached; step N counts everyone at level >= N.
  const reached = steps.map((_, i) =>
    rows.filter((r) => num(r.level) >= i + 1).reduce((sum, r) => sum + num(r.people), 0),
  );
  const pct = (a: number, b: number | undefined) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    project,
    range: rangeJson(range),
    window_seconds: windowSeconds,
    steps: steps.map((s, i) => ({
      step: i + 1,
      ...s,
      people: reached[i] ?? 0,
      conversion_from_previous_pct: i === 0 ? 100 : pct(reached[i] ?? 0, reached[i - 1]),
      conversion_overall_pct: pct(reached[i] ?? 0, reached[0]),
    })),
  };
}

// --- projects -------------------------------------------------------------

export async function projectActivity(db: Db) {
  const rows = (
    await query<{ project_id: string; events: unknown; visitors: unknown; last_event: string }>(
      db,
      `SELECT project_id, count() AS events, uniqExact(distinct_id) AS visitors, toString(max(timestamp)) AS last_event
FROM events
WHERE timestamp >= now() - INTERVAL 30 DAY
GROUP BY project_id`,
    )
  ).data;
  return new Map(
    rows.map((r) => [
      r.project_id,
      { events_30d: num(r.events), visitors_30d: num(r.visitors), last_event: r.last_event },
    ]),
  );
}
