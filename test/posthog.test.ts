import { afterEach, describe, expect, it, vi } from "vitest";
import {
  eventFilter,
  type MapOptions,
  type PosthogError,
  type PosthogEvent,
  pageQuery,
  posthogQuery,
  toEventRow,
} from "../src/posthog";

const CHROME_MAC = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const T = Date.parse("2026-07-01T10:00:00.000Z");

const pageview = (overrides: Partial<PosthogEvent> = {}): PosthogEvent => ({
  uuid: "0197a1b2-0000-7000-8000-000000000001",
  event: "$pageview",
  ms: T,
  distinctId: "0197a1b2-anon",
  url: "https://www.dqnamo.com/experiments/playing-cards?utm_source=x",
  referrer: "https://twitter.com/dqnamo",
  prevPathname: "",
  userAgent: CHROME_MAC,
  browser: "Chrome",
  os: "Mac OS X",
  deviceType: "Desktop",
  country: "GB",
  region: "England",
  city: "London",
  deviceId: "0197a1b2-anon",
  identified: false,
  properties: "",
  ...overrides,
});

const options: MapOptions = {
  projectId: "dqnamo",
  salt: "salt",
  visitorIds: "daily",
  receivedAt: "2026-11-03 12:00:00.000",
};

describe("toEventRow", () => {
  it("maps a pageview the way the tracker would have recorded it", async () => {
    const row = await toEventRow(pageview(), options);
    expect(row).toMatchObject({
      project_id: "dqnamo",
      event_id: "0197a1b2-0000-7000-8000-000000000001",
      timestamp: "2026-07-01 10:00:00.000",
      event: "$pageview",
      user_id: "",
      properties: "{}",
      host: "dqnamo.com",
      path: "/experiments/playing-cards",
      utm_source: "x",
      referrer: "https://twitter.com/dqnamo",
      referrer_domain: "twitter.com",
      country: "GB",
      region: "England",
      city: "London",
      browser: "Chrome",
      os: "macOS",
      device: "desktop",
      lib: "posthog",
    });
    expect(row?.anonymous_id).toMatch(/^c_[0-9a-f]{24}$/);
    expect(row?.distinct_id).toBe(row?.anonymous_id);
  });

  it("credits SPA navigations to the previous page, not PostHog's first referrer", async () => {
    const row = await toEventRow(pageview({ prevPathname: "/" }), options);
    expect(row).toMatchObject({ referrer: "https://www.dqnamo.com/", referrer_domain: "" });
  });

  it("treats $direct as no referrer", async () => {
    expect(await toEventRow(pageview({ referrer: "$direct" }), options)).toMatchObject({
      referrer: "",
      referrer_domain: "",
    });
  });

  it("skips bots and navigations that stay on the same path", async () => {
    expect(await toEventRow(pageview({ userAgent: "Googlebot/2.1" }), options)).toBeNull();
    expect(await toEventRow(pageview({ prevPathname: "/experiments/playing-cards" }), options)).toBeNull();
  });

  it("gives a visitor a new daily ID each day, like the cookieless tracker", async () => {
    const day1 = await toEventRow(pageview(), options);
    const later = await toEventRow(pageview({ ms: T + 3_600_000 }), options);
    const day2 = await toEventRow(pageview({ ms: T + 86_400_000 }), options);
    const other = await toEventRow(pageview({ deviceId: "someone-else" }), options);
    expect(later?.anonymous_id).toBe(day1?.anonymous_id);
    expect(day2?.anonymous_id).not.toBe(day1?.anonymous_id);
    expect(other?.anonymous_id).not.toBe(day1?.anonymous_id);
  });

  it("keeps one ID across days for sites with data-persist", async () => {
    const persistent = { ...options, visitorIds: "persistent" as const };
    const day1 = await toEventRow(pageview(), persistent);
    const day2 = await toEventRow(pageview({ ms: T + 86_400_000 }), persistent);
    expect(day1?.anonymous_id).toMatch(/^p_[0-9a-f]{32}$/);
    expect(day2?.anonymous_id).toBe(day1?.anonymous_id);
  });

  it("keeps a custom event's own properties and an identified user's ID", async () => {
    const row = await toEventRow(
      pageview({
        event: "experiment_card_clicked",
        properties: JSON.stringify({ experiment: "playing-cards", $browser: "Chrome", $set: { a: 1 } }),
        identified: true,
        distinctId: "user-42",
      }),
      options,
    );
    expect(row).toMatchObject({ event: "experiment_card_clicked", user_id: "user-42", distinct_id: "user-42" });
    expect(JSON.parse(row?.properties ?? "")).toEqual({ experiment: "playing-cards" });
    expect(row?.anonymous_id).toMatch(/^c_/);
  });

  it("falls back to PostHog's browser, OS and device names without a raw user agent", async () => {
    const row = await toEventRow(
      pageview({ userAgent: "", browser: "Mobile Safari", os: "iOS", deviceType: "Mobile" }),
      options,
    );
    expect(row).toMatchObject({ browser: "Safari", os: "iOS", device: "mobile" });
    const unknown = await toEventRow(pageview({ userAgent: "", browser: "", os: "", deviceType: "" }), options);
    expect(unknown).toMatchObject({ browser: "", os: "", device: "" });
  });
});

describe("HogQL", () => {
  it("selects pageviews and the site's own events by default, and escapes event names", () => {
    expect(eventFilter()).toBe("(event = '$pageview' OR NOT startsWith(event, '$'))");
    expect(eventFilter(["signup", "it's\\"])).toBe("event IN ('signup', 'it\\'s\\\\')");
  });

  it("pages in (millisecond, UUID) order, after the last event read", () => {
    const uuid = "0197a1b2-0000-7000-8000-000000000001";
    const sql = pageQuery(eventFilter(), 1_751_364_000_123, 1_751_450_400_000, uuid, 2000);
    expect(sql).toContain("timestamp >= toDateTime(1751364000)");
    expect(sql).toContain("toUnixTimestamp64Milli(timestamp) >= 1751364000123");
    expect(sql).toContain("timestamp < toDateTime(1751450400)");
    expect(sql).toContain(`(toUnixTimestamp64Milli(timestamp) > 1751364000123 OR toString(uuid) > '${uuid}')`);
    expect(sql).toMatch(/ORDER BY toUnixTimestamp64Milli\(timestamp\), toString\(uuid\) LIMIT 2000$/);
    expect(pageQuery(eventFilter(), 0, 1, null, 1)).not.toContain("toString(uuid) >");
    expect(() => pageQuery(eventFilter(), 0, 1, "x' OR 1", 1)).toThrow();
  });
});

describe("posthogQuery", () => {
  afterEach(() => vi.unstubAllGlobals());
  const source = { host: "https://us.posthog.com", projectId: "479710", apiKey: "phx_key" };

  const failWith = async (status: number, body: object, headers: Record<string, string> = {}) => {
    vi.stubGlobal("fetch", async () => Response.json(body, { status, headers }));
    return posthogQuery(source, "SELECT 1", "test").then(
      () => {
        throw new Error("expected PostHog to fail");
      },
      (e: unknown) => e as PosthogError,
    );
  };

  it("sends a HogQL query with the personal API key", async () => {
    const fetchMock = vi.fn(async () => Response.json({ results: [[1, 2]] }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await posthogQuery(source, "SELECT 1", "test")).toEqual([[1, 2]]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://us.posthog.com/api/projects/479710/query/");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer phx_key");
    expect(JSON.parse(init.body as string)).toMatchObject({ query: { kind: "HogQLQuery", query: "SELECT 1" } });
  });

  it("tells auth, rate limits, timeouts and bad queries apart", async () => {
    expect((await failWith(401, { detail: "Invalid key" })).kind).toBe("auth");
    expect(await failWith(429, { detail: "Rate limited" }, { "Retry-After": "30" })).toMatchObject({
      kind: "rate_limit",
      retryAfterMs: 30_000,
    });
    expect(await failWith(429, { code: "api_queries_budget_exceeded", detail: "Budget" })).toMatchObject({
      kind: "rate_limit",
      retryAfterMs: 15 * 60_000,
    });
    expect((await failWith(500, { detail: "Query exceeded the timeout" })).kind).toBe("timeout");
    expect((await failWith(503, { detail: "Down" })).kind).toBe("unavailable");
    expect((await failWith(400, { detail: "Unknown table" })).kind).toBe("bad_request");
  });
});
