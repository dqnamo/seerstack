import { QueryError } from "./errors";

// Time ranges for the analytics tools. Everything is UTC and half-open:
// [from, to).

export const PERIODS = ["today", "yesterday", "24h", "7d", "30d", "90d", "12mo"] as const;
export type Period = (typeof PERIODS)[number];
export const INTERVALS = ["hour", "day", "week", "month"] as const;
export type Interval = (typeof INTERVALS)[number];
export type Range = { from: Date; to: Date };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_BUCKETS = 2_000;

const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const daysAgo = (today: Date, n: number) => new Date(today.getTime() - n * DAY);

export function parseDay(value: string, name: string): Date {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(ms)) throw new QueryError(`${name} must be a date like 2026-11-02`);
  return new Date(ms);
}

export function resolveRange(opts: { period?: Period; date_from?: string; date_to?: string }, now = new Date()): Range {
  if (opts.date_from || opts.date_to) {
    if (!opts.date_from || !opts.date_to) throw new QueryError("Pass both date_from and date_to, or a period");
    const from = parseDay(opts.date_from, "date_from");
    const to = new Date(parseDay(opts.date_to, "date_to").getTime() + DAY); // date_to is inclusive
    if (to <= from) throw new QueryError("date_to is before date_from");
    return { from, to };
  }
  const today = startOfDay(now);
  switch (opts.period ?? "7d") {
    case "today":
      return { from: today, to: now };
    case "yesterday":
      return { from: daysAgo(today, 1), to: today };
    case "24h":
      return { from: new Date(now.getTime() - DAY), to: now };
    case "7d":
      return { from: daysAgo(today, 6), to: now };
    case "30d":
      return { from: daysAgo(today, 29), to: now };
    case "90d":
      return { from: daysAgo(today, 89), to: now };
    case "12mo":
      return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)), to: now };
  }
}

// The same length of time immediately before `range`, for comparisons.
export function previousRange(range: Range): Range {
  const length = range.to.getTime() - range.from.getTime();
  return { from: new Date(range.from.getTime() - length), to: range.from };
}

export function defaultInterval(range: Range): Interval {
  const days = (range.to.getTime() - range.from.getTime()) / DAY;
  return days <= 2 ? "hour" : days <= 92 ? "day" : "month";
}

// The ClickHouse expression that buckets `timestamp`, and the TypeScript
// equivalent used to zero-fill buckets with no events. Weeks start on Monday.
export const BUCKET_SQL: Record<Interval, string> = {
  hour: "toString(toStartOfHour(toDateTime(timestamp)))",
  day: "toString(toDate(timestamp))",
  week: "toString(toMonday(timestamp))",
  month: "toString(toStartOfMonth(timestamp))",
};

function floorTo(d: Date, interval: Interval): Date {
  switch (interval) {
    case "hour":
      return new Date(Math.floor(d.getTime() / HOUR) * HOUR);
    case "day":
      return startOfDay(d);
    case "week":
      return daysAgo(startOfDay(d), (d.getUTCDay() + 6) % 7);
    case "month":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
}

function step(d: Date, interval: Interval): Date {
  switch (interval) {
    case "hour":
      return new Date(d.getTime() + HOUR);
    case "day":
      return new Date(d.getTime() + DAY);
    case "week":
      return new Date(d.getTime() + 7 * DAY);
    case "month":
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
}

function bucketKey(d: Date, interval: Interval): string {
  const iso = d.toISOString();
  return interval === "hour" ? `${iso.slice(0, 10)} ${iso.slice(11, 13)}:00:00` : iso.slice(0, 10);
}

export function bucketKeys(range: Range, interval: Interval): string[] {
  const keys: string[] = [];
  for (let d = floorTo(range.from, interval); d < range.to; d = step(d, interval)) {
    keys.push(bucketKey(d, interval));
    if (keys.length > MAX_BUCKETS) throw new QueryError(`Too many ${interval} buckets`, "Use a larger interval.");
  }
  return keys;
}
