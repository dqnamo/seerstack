import { describe, expect, it } from "vitest";
import { BadRequest, extractEvents, normalizeEvents, type RequestContext } from "../src/normalize";

const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
const NOW = Date.parse("2026-11-02T12:00:00Z");

const browser: RequestContext = {
  projects: { site: { name: "Site", domains: ["site.com"] }, api: { name: "API", domains: [] } },
  now: NOW,
  trusted: false,
  origin: "https://www.site.com",
  ip: "1.2.3.4",
  userAgent: CHROME,
  country: "GB",
  region: "England",
  city: "London",
  salt: "salt",
};
const server: RequestContext = { ...browser, trusted: true, origin: undefined, userAgent: "node" };

describe("extractEvents", () => {
  it("accepts a single event or a batch that inherits the project", () => {
    expect(extractEvents({ project: "site", event: "x" })).toEqual([{ project: "site", event: "x" }]);
    expect(extractEvents({ project: "site", batch: [{ event: "a" }, { event: "b", project: "api" }] })).toEqual([
      { project: "site", event: "a" },
      { project: "api", event: "b" },
    ]);
  });

  it("rejects bodies that aren't events", () => {
    expect(() => extractEvents([])).toThrow(BadRequest);
    expect(() => extractEvents({ foo: 1 })).toThrow(BadRequest);
    expect(() => extractEvents({ batch: new Array(501).fill({ event: "x" }) })).toThrow(/500/);
  });
});

describe("normalizeEvents", () => {
  it("enriches browser pageviews from the request", async () => {
    const { rows } = await normalizeEvents(
      [
        {
          project: "site",
          event: "$pageview",
          url: "https://www.site.com/pricing?utm_source=hn&utm_campaign=launch",
          referrer: "https://www.google.com/search?q=x",
          timestamp: "2020-01-01T00:00:00Z",
        },
      ],
      browser,
    );
    expect(rows[0]).toMatchObject({
      project_id: "site",
      event: "$pageview",
      host: "site.com",
      path: "/pricing",
      utm_source: "hn",
      utm_campaign: "launch",
      referrer_domain: "google.com",
      country: "GB",
      city: "London",
      browser: "Chrome",
      os: "macOS",
      device: "desktop",
      timestamp: "2026-11-02 12:00:00.000", // browser clocks are ignored
    });
    expect(rows[0]?.anonymous_id).toMatch(/^c_[0-9a-f]{24}$/);
    expect(rows[0]?.distinct_id).toBe(rows[0]?.anonymous_id);
  });

  it("gives a visitor the same cookieless ID all day, and a new one tomorrow", async () => {
    const id = async (ctx: RequestContext) =>
      (await normalizeEvents([{ project: "site", event: "x" }], ctx)).rows[0]?.anonymous_id;
    const today = await id(browser);
    expect(await id({ ...browser, now: NOW + 3600_000 })).toBe(today);
    expect(await id({ ...browser, now: NOW + 86_400_000 })).not.toBe(today);
    expect(await id({ ...browser, ip: "5.6.7.8" })).not.toBe(today);
  });

  it("treats same-site referrers as internal", async () => {
    const { rows } = await normalizeEvents(
      [{ project: "site", event: "$pageview", url: "https://site.com/b", referrer: "https://www.site.com/a" }],
      browser,
    );
    expect(rows[0]?.referrer_domain).toBe("");
  });

  it("rejects browser events from other origins, unknown projects and bots", async () => {
    const wrongOrigin = await normalizeEvents([{ project: "site", event: "x" }], {
      ...browser,
      origin: "https://evil.com",
    });
    expect(wrongOrigin).toMatchObject({ rows: [], rejected: 1 });
    expect(wrongOrigin.errors[0]).toMatch(/evil\.com/);

    expect(await normalizeEvents([{ project: "nope", event: "x" }], browser)).toMatchObject({ rows: [], rejected: 1 });
    expect(
      await normalizeEvents([{ project: "site", event: "x" }], { ...browser, userAgent: "Googlebot/2.1" }),
    ).toMatchObject({
      rows: [],
      rejected: 1,
    });
    // A bare-domain origin matches; a lookalike doesn't.
    expect(
      (await normalizeEvents([{ project: "site", event: "x" }], { ...browser, origin: "https://site.com" })).rows,
    ).toHaveLength(1);
    expect(
      (await normalizeEvents([{ project: "site", event: "x" }], { ...browser, origin: "https://notsite.com" })).rows,
    ).toHaveLength(0);
  });

  it("lets servers send to any project, keep their timestamps and skip request geo", async () => {
    const { rows } = await normalizeEvents(
      [
        {
          project: "api",
          event: "signup",
          user_id: "u_1",
          properties: { plan: "pro" },
          timestamp: "2026-10-01T09:30:00Z",
        },
      ],
      server,
    );
    expect(rows[0]).toMatchObject({
      project_id: "api",
      user_id: "u_1",
      distinct_id: "u_1",
      anonymous_id: "",
      properties: '{"plan":"pro"}',
      timestamp: "2026-10-01 09:30:00.000",
      country: "",
      browser: "",
      lib: "server",
    });
  });

  it("caps timestamps in the future and rejects oversized properties", async () => {
    const { rows, rejected } = await normalizeEvents(
      [
        { project: "api", event: "a", timestamp: NOW + 86_400_000 },
        { project: "api", event: "b", properties: { big: "x".repeat(40_000) } },
        { project: "api" },
      ],
      server,
    );
    expect(rows.map((r) => r.timestamp)).toEqual(["2026-11-02 13:00:00.000"]);
    expect(rejected).toBe(2);
  });
});
