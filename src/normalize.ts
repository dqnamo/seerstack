import { cookielessId, isBot, parseUrl, parseUserAgent, referrerDomain, toClickHouseTime } from "./enrich";

export const MAX_BATCH = 500;
const MAX_PROPERTIES_BYTES = 32 * 1024;
const MAX_FUTURE_MS = 60 * 60 * 1000;
const MAX_ERRORS = 10;

export type EventRow = {
  project_id: string;
  event_id: string;
  timestamp: string;
  received_at: string;
  event: string;
  distinct_id: string;
  user_id: string;
  anonymous_id: string;
  properties: string;
  url: string;
  host: string;
  path: string;
  referrer: string;
  referrer_domain: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
  country: string;
  region: string;
  city: string;
  browser: string;
  os: string;
  device: string;
  lib: string;
};

export type RequestContext = {
  /** Resolved from the request's key; every event in it belongs to this project. */
  projectId: string;
  now: number;
  /** Sent with the secret key: a server, so no request-derived geo/device or cookieless ID. */
  trusted: boolean;
  ip: string;
  userAgent: string;
  country: string;
  region: string;
  city: string;
  salt: string;
};

export class BadRequest extends Error {}

type RawEvent = Record<string, unknown>;

function isRecord(value: unknown): value is RawEvent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string {
  if (typeof value === "string") return value.slice(0, max);
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, max);
  return "";
}

// Accepts one event, or `{ batch: [...] }`. Browser bodies also carry the
// project's public `key`.
export function extractEvents(body: unknown): RawEvent[] {
  if (!isRecord(body)) throw new BadRequest("Body must be a JSON object");
  if (Array.isArray(body.batch)) {
    if (body.batch.length > MAX_BATCH) throw new BadRequest(`At most ${MAX_BATCH} events per batch`);
    return body.batch;
  }
  if (typeof body.event === "string") return [body];
  throw new BadRequest("Expected an event with an `event` name, or a `batch` array");
}

export async function normalizeEvents(
  events: unknown[],
  ctx: RequestContext,
): Promise<{ rows: EventRow[]; rejected: number; errors: string[] }> {
  const rows: EventRow[] = [];
  const errors: string[] = [];
  let rejected = 0;
  const reject = (index: number, reason: string) => {
    rejected++;
    if (errors.length < MAX_ERRORS) errors.push(`batch[${index}]: ${reason}`);
  };

  // Browser events from bots aren't analytics.
  if (!ctx.trusted && isBot(ctx.userAgent)) return { rows, rejected: events.length, errors: ["bot user agent"] };

  const receivedAt = toClickHouseTime(ctx.now);
  const device = ctx.trusted ? { browser: "", os: "", device: "" } : parseUserAgent(ctx.userAgent);
  const geo = ctx.trusted ? { country: "", region: "", city: "" } : ctx;
  const cookieless = ctx.trusted ? "" : await cookielessId(ctx.salt, ctx.projectId, ctx.ip, ctx.userAgent, ctx.now);

  for (const [index, raw] of events.entries()) {
    if (!isRecord(raw)) {
      reject(index, "event must be an object");
      continue;
    }
    const event = str(raw.event, 200);
    if (!event) {
      reject(index, "missing `event`");
      continue;
    }
    const properties = isRecord(raw.properties) ? JSON.stringify(raw.properties) : "{}";
    if (properties.length > MAX_PROPERTIES_BYTES) {
      reject(index, "properties over 32 KB");
      continue;
    }

    // Browser clocks are unreliable, so only servers (which may backfill) set
    // their own timestamps.
    const clientMs =
      typeof raw.timestamp === "string"
        ? Date.parse(raw.timestamp)
        : typeof raw.timestamp === "number"
          ? raw.timestamp
          : Number.NaN;
    const ts = ctx.trusted && Number.isFinite(clientMs) ? Math.min(clientMs, ctx.now + MAX_FUTURE_MS) : ctx.now;

    const userId = str(raw.user_id, 200);
    const anonymousId = str(raw.anonymous_id, 200) || cookieless;

    const url = str(raw.url, 2000);
    const referrer = str(raw.referrer, 2000);
    const urlParts = parseUrl(url);

    rows.push({
      project_id: ctx.projectId,
      event_id: str(raw.event_id, 100) || crypto.randomUUID(),
      timestamp: toClickHouseTime(ts),
      received_at: receivedAt,
      event,
      distinct_id: userId || anonymousId,
      user_id: userId,
      anonymous_id: anonymousId,
      properties,
      url,
      ...urlParts,
      referrer,
      referrer_domain: referrerDomain(referrer, urlParts.host),
      country: geo.country,
      region: geo.region,
      city: geo.city,
      ...device,
      lib: str(raw.lib, 50) || (ctx.trusted ? "server" : ""),
    });
  }

  return { rows, rejected, errors };
}
