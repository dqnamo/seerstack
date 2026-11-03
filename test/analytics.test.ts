import { describe, expect, it } from "vitest";
import { breakdownSql, funnelSql, overviewSql, timeseriesSql } from "../src/analytics";
import { QueryError } from "../src/errors";

const RANGE = { from: new Date("2026-10-27T00:00:00Z"), to: new Date("2026-11-02T00:00:00Z") };
const HOSTILE = "x' OR 1=1 --";

describe("query builders", () => {
  it("bind every value as a template param and never inline it", () => {
    const { sql, params } = breakdownSql(
      "site",
      RANGE,
      "properties.plan",
      HOSTILE,
      { path: HOSTILE, country: "(none)" },
      10,
    );
    expect(sql.startsWith("%\n")).toBe(true);
    expect(sql).not.toContain(HOSTILE);
    expect(sql).not.toContain("'site'");
    expect(Object.values(params)).toEqual(
      expect.arrayContaining(["site", "plan", HOSTILE, "", "2026-10-27 00:00:00.000", "2026-11-02 00:00:00.000"]),
    );
    for (const placeholder of sql.matchAll(/\{\{String\((p\d+)\)\}\}/g))
      expect(params).toHaveProperty(placeholder[1] as string);
  });

  it("reject unknown dimensions and filters", () => {
    expect(() => breakdownSql("site", RANGE, "event_id; DROP", undefined, undefined, 10)).toThrow(QueryError);
    expect(() => timeseriesSql("site", RANGE, "day", "$pageview", { "1=1 OR path": "x" })).toThrow(/Unknown dimension/);
  });

  it("validate limits and funnel steps", () => {
    expect(() => breakdownSql("site", RANGE, "path", undefined, undefined, 0)).toThrow(/limit/);
    expect(() => funnelSql("site", RANGE, [{ event: "a" }], 3600)).toThrow(/2-10 steps/);
    const { sql, params } = funnelSql(
      "site",
      RANGE,
      [{ event: "$pageview", path: "/pricing" }, { event: "signup" }],
      3600,
    );
    expect(sql).toContain("windowFunnel(3600)");
    expect(Object.values(params)).toEqual(expect.arrayContaining(["/pricing", "signup", "$identify"]));
  });

  it("derive sessions from 30 minute gaps", () => {
    expect(overviewSql("site", RANGE).sql).toContain("> 1800");
  });
});
