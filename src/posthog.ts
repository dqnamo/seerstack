import { isBot, parseUrl, parseUserAgent, referrerDomain, sha256Hex, toClickHouseTime } from "./enrich";
import { type EventRow, MAX_PROPERTIES_BYTES } from "./normalize";

// Reads events out of PostHog's query API and turns them into rows that look
// as if Seerstack's own tracker had recorded them (ADR 0009).

export const POSTHOG_HOSTS = { us: "https://us.posthog.com", eu: "https://eu.posthog.com" } as const;

export type PosthogSource = { host: string; projectId: string; apiKey: string };

export type VisitorIds = "daily" | "persistent";

export type PosthogEvent = {
  uuid: string;
  event: string;
  ms: number;
  distinctId: string;
  url: string;
  referrer: string;
  prevPathname: string;
  userAgent: string;
  browser: string;
  os: string;
  deviceType: string;
  country: string;
  region: string;
  city: string;
  deviceId: string;
  identified: boolean;
  properties: string;
};

// Column order matches readEvent(). Named properties let PostHog read its
// materialized columns instead of the whole JSON; only non-pageview events
// need their custom properties.
const EVENT_COLUMNS = [
  "toString(uuid)",
  "event",
  "toUnixTimestamp64Milli(timestamp)",
  "distinct_id",
  "properties.$current_url",
  "properties.$referrer",
  "properties.$prev_pageview_pathname",
  "properties.$raw_user_agent",
  "properties.$browser",
  "properties.$os",
  "properties.$device_type",
  "properties.$geoip_country_code",
  "properties.$geoip_subdivision_1_name",
  "properties.$geoip_city_name",
  "properties.$device_id",
  "properties.$is_identified",
  "if(event = '$pageview', '', properties)",
];

const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));

function readEvent(row: unknown[]): PosthogEvent {
  return {
    uuid: text(row[0]),
    event: text(row[1]),
    ms: Number(row[2]),
    distinctId: text(row[3]),
    url: text(row[4]),
    referrer: text(row[5]),
    prevPathname: text(row[6]),
    userAgent: text(row[7]),
    browser: text(row[8]),
    os: text(row[9]),
    deviceType: text(row[10]),
    country: text(row[11]),
    region: text(row[12]),
    city: text(row[13]),
    deviceId: text(row[14]),
    identified: row[15] === true || row[15] === "true",
    properties: typeof row[16] === "object" && row[16] !== null ? JSON.stringify(row[16]) : text(row[16]),
  };
}

// --- HogQL ------------------------------------------------------------------

function literal(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function integer(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error(`Not an integer: ${value}`);
  return String(value);
}

// By default: pageviews and the site's own events. PostHog's automatic events
// ($autocapture, $pageleave, $web_vitals, $exception, ...) have no Seerstack
// equivalent.
export function eventFilter(events?: string[]): string {
  if (!events || events.length === 0) return "(event = '$pageview' OR NOT startsWith(event, '$'))";
  return `event IN (${events.map(literal).join(", ")})`;
}

// [fromMs, toMs). The whole-second bounds let PostHog prune by its date-sorted
// key; the millisecond bounds make the range exact.
function timeRange(fromMs: number, toMs: number): string {
  return [
    `timestamp >= toDateTime(${integer(Math.floor(fromMs / 1000))})`,
    `toUnixTimestamp64Milli(timestamp) >= ${integer(fromMs)}`,
    `timestamp < toDateTime(${integer(Math.ceil(toMs / 1000))})`,
    `toUnixTimestamp64Milli(timestamp) < ${integer(toMs)}`,
  ].join(" AND ");
}

export function summaryQuery(filter: string, fromMs: number, toMs: number): string {
  return `SELECT count(), min(toUnixTimestamp64Milli(timestamp)) FROM events WHERE ${timeRange(fromMs, toMs)} AND ${filter}`;
}

// One page of events in (millisecond, UUID) order. PostHog refuses OFFSET for
// personal API keys, so pages are keyset-paginated: with `afterUuid`, events
// at exactly fromMs are read only after that UUID, however many share it.
export function pageQuery(
  filter: string,
  fromMs: number,
  toMs: number,
  afterUuid: string | null,
  limit: number,
): string {
  const conditions = [timeRange(fromMs, toMs), filter];
  if (afterUuid !== null) {
    if (!/^[0-9a-f-]{36}$/i.test(afterUuid)) throw new Error(`Not a UUID: ${afterUuid}`);
    conditions.push(
      `(toUnixTimestamp64Milli(timestamp) > ${integer(fromMs)} OR toString(uuid) > ${literal(afterUuid)})`,
    );
  }
  return `SELECT ${EVENT_COLUMNS.join(", ")} FROM events WHERE ${conditions.join(" AND ")} ORDER BY toUnixTimestamp64Milli(timestamp), toString(uuid) LIMIT ${integer(limit)}`;
}

// --- API --------------------------------------------------------------------

export type PosthogErrorKind = "auth" | "rate_limit" | "timeout" | "bad_request" | "unavailable";

export class PosthogError extends Error {
  constructor(
    message: string,
    readonly kind: PosthogErrorKind,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

const MINUTE = 60_000;

function toPosthogError(status: number, raw: string, retryAfter: string | null): PosthogError {
  let detail = raw.slice(0, 500);
  try {
    const body = JSON.parse(raw) as { detail?: string; error?: string; code?: string };
    detail = [body.code, body.detail ?? body.error].filter(Boolean).join(": ") || detail;
  } catch {}
  if (status === 401 || status === 403) {
    return new PosthogError(`PostHog refused the API key (${status}): ${detail}`, "auth");
  }
  if (status === 429) {
    const seconds = Number(retryAfter);
    // The hourly read budget for personal API keys needs a longer wait than
    // the per-minute request limit.
    const fallback = /budget/i.test(detail) ? 15 * MINUTE : MINUTE;
    return new PosthogError(
      `PostHog rate limit: ${detail}`,
      "rate_limit",
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : fallback,
    );
  }
  if (/timeout|timed out|too long|execution time/i.test(detail) || status === 504) {
    return new PosthogError(`PostHog query timed out: ${detail}`, "timeout");
  }
  if (status >= 500) return new PosthogError(`PostHog is unavailable (${status}): ${detail}`, "unavailable");
  return new PosthogError(`PostHog rejected the query (${status}): ${detail}`, "bad_request");
}

export async function posthogQuery(source: PosthogSource, hogql: string, name: string): Promise<unknown[][]> {
  const res = await fetch(`${source.host}/api/projects/${encodeURIComponent(source.projectId)}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${source.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query: hogql }, name }),
  });
  const raw = await res.text();
  if (!res.ok) throw toPosthogError(res.status, raw, res.headers.get("retry-after"));
  const body = JSON.parse(raw) as { results?: unknown[][]; error?: string };
  if (body.error) throw toPosthogError(400, JSON.stringify({ detail: body.error }), null);
  return body.results ?? [];
}

export async function countEvents(
  source: PosthogSource,
  filter: string,
  fromMs: number,
  toMs: number,
): Promise<{ count: number; firstMs: number | null }> {
  const [row] = await posthogQuery(source, summaryQuery(filter, fromMs, toMs), "seerstack import: count");
  const count = Number(row?.[0] ?? 0);
  return { count, firstMs: count > 0 ? Number(row?.[1]) : null };
}

export async function fetchEvents(
  source: PosthogSource,
  filter: string,
  fromMs: number,
  toMs: number,
  afterUuid: string | null,
  limit: number,
): Promise<PosthogEvent[]> {
  const rows = await posthogQuery(source, pageQuery(filter, fromMs, toMs, afterUuid, limit), "seerstack import: page");
  return rows.map(readEvent);
}

// --- mapping ----------------------------------------------------------------

// PostHog's $browser/$os/$device_type, for events without a raw user agent,
// mapped onto the values parseUserAgent() produces.
const BROWSERS: [RegExp, string][] = [
  [/edge/i, "Edge"],
  [/opera/i, "Opera"],
  [/samsung/i, "Samsung Internet"],
  [/firefox/i, "Firefox"],
  [/chrome/i, "Chrome"],
  [/safari/i, "Safari"],
];
const OSES: [RegExp, string][] = [
  [/windows/i, "Windows"],
  [/ios/i, "iOS"],
  [/android/i, "Android"],
  [/chrome ?os/i, "ChromeOS"],
  [/mac/i, "macOS"],
  [/linux/i, "Linux"],
];
const pick = (value: string, table: [RegExp, string][]) =>
  value ? (table.find(([re]) => re.test(value))?.[1] ?? "Other") : "";

function deviceOf(e: PosthogEvent): { browser: string; os: string; device: string } {
  if (e.userAgent) return parseUserAgent(e.userAgent);
  const device = e.deviceType.toLowerCase();
  return {
    browser: pick(e.browser, BROWSERS),
    os: pick(e.os, OSES),
    device: ["desktop", "mobile", "tablet"].includes(device) ? device : "",
  };
}

// The live tracker credits the page's referrer on load, and the previous page
// on SPA navigations. PostHog keeps the tab's first referrer on every event, so
// navigations take their referrer from $prev_pageview_pathname instead.
function referrerOf(e: PosthogEvent, origin: string): string {
  if (e.event === "$pageview" && e.prevPathname && origin) return `${origin}${e.prevPathname}`;
  return e.referrer === "$direct" ? "" : e.referrer;
}

// Only the event's own properties: PostHog's $-prefixed ones are its metadata.
function customProperties(raw: string): string {
  if (!raw) return "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "{}";
  }
  if (typeof parsed !== "object" || parsed === null) return "{}";
  return JSON.stringify(Object.fromEntries(Object.entries(parsed).filter(([key]) => !key.startsWith("$"))));
}

export type MapOptions = { projectId: string; salt: string; visitorIds: VisitorIds; receivedAt: string };

// Visitor IDs follow the site's tracker: daily IDs (c_) unless the script tag
// has data-persist (p_). They're hashed so they can't be linked back to
// PostHog's IDs.
async function visitorId(id: string, ms: number, o: MapOptions): Promise<string> {
  if (o.visitorIds === "persistent") {
    return `p_${(await sha256Hex(`${o.salt}|${o.projectId}|posthog|${id}`)).slice(0, 32)}`;
  }
  const day = new Date(ms).toISOString().slice(0, 10);
  return `c_${(await sha256Hex(`${o.salt}|${day}|${o.projectId}|posthog|${id}`)).slice(0, 24)}`;
}

// Returns null for events the live tracker wouldn't have recorded: bots, and
// navigations that stay on the same path.
export async function toEventRow(e: PosthogEvent, o: MapOptions): Promise<EventRow | null> {
  if (!e.uuid || !e.event || !Number.isFinite(e.ms)) return null;
  if (e.userAgent && isBot(e.userAgent)) return null;

  const urlParts = parseUrl(e.url);
  let origin = "";
  try {
    origin = new URL(e.url).origin;
  } catch {}
  if (e.event === "$pageview" && e.prevPathname && e.prevPathname === urlParts.path) return null;

  const properties = e.event === "$pageview" ? "{}" : customProperties(e.properties);
  if (properties.length > MAX_PROPERTIES_BYTES) return null;

  const userId = e.identified ? e.distinctId : "";
  const anonymousId = await visitorId(e.deviceId || e.distinctId, e.ms, o);
  const referrer = referrerOf(e, origin);

  return {
    project_id: o.projectId,
    event_id: e.uuid,
    timestamp: toClickHouseTime(e.ms),
    received_at: o.receivedAt,
    event: e.event,
    distinct_id: userId || anonymousId,
    user_id: userId,
    anonymous_id: anonymousId,
    properties,
    url: e.url,
    ...urlParts,
    referrer,
    referrer_domain: referrerDomain(referrer, urlParts.host),
    country: e.country,
    region: e.region,
    city: e.city,
    ...deviceOf(e),
    lib: "posthog",
  };
}
