import { describe, expect, it } from "vitest";
import { bucketKeys, defaultInterval, previousRange, resolveRange } from "../src/periods";

const NOW = new Date("2026-11-02T15:30:00Z"); // a Monday
const iso = (r: { from: Date; to: Date }) => [r.from.toISOString(), r.to.toISOString()];

describe("resolveRange", () => {
  it("resolves periods in UTC", () => {
    expect(iso(resolveRange({ period: "today" }, NOW))).toEqual([
      "2026-11-02T00:00:00.000Z",
      "2026-11-02T15:30:00.000Z",
    ]);
    expect(iso(resolveRange({ period: "yesterday" }, NOW))).toEqual([
      "2026-11-01T00:00:00.000Z",
      "2026-11-02T00:00:00.000Z",
    ]);
    expect(iso(resolveRange({}, NOW))[0]).toBe("2026-10-27T00:00:00.000Z"); // 7d includes today
    expect(iso(resolveRange({ period: "12mo" }, NOW))[0]).toBe("2025-12-01T00:00:00.000Z");
  });

  it("treats date_to as inclusive", () => {
    expect(iso(resolveRange({ date_from: "2026-10-01", date_to: "2026-10-31" }, NOW))).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    ]);
    expect(() => resolveRange({ date_from: "2026-10-01" }, NOW)).toThrow(/both/);
    expect(() => resolveRange({ date_from: "10/01/2026", date_to: "2026-10-02" }, NOW)).toThrow(/date_from/);
    expect(() => resolveRange({ date_from: "2026-10-05", date_to: "2026-10-01" }, NOW)).toThrow(/before/);
  });
});

it("previousRange is the same length immediately before", () => {
  const range = resolveRange({ period: "yesterday" }, NOW);
  expect(iso(previousRange(range))).toEqual(["2026-10-31T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
});

describe("buckets", () => {
  it("picks an interval from the range length", () => {
    expect(defaultInterval(resolveRange({ period: "24h" }, NOW))).toBe("hour");
    expect(defaultInterval(resolveRange({ period: "90d" }, NOW))).toBe("day");
    expect(defaultInterval(resolveRange({ period: "12mo" }, NOW))).toBe("month");
  });

  it("matches ClickHouse's bucket strings", () => {
    const range = { from: new Date("2026-11-02T13:15:00Z"), to: new Date("2026-11-02T15:30:00Z") };
    expect(bucketKeys(range, "hour")).toEqual(["2026-11-02 13:00:00", "2026-11-02 14:00:00", "2026-11-02 15:00:00"]);
    expect(bucketKeys(resolveRange({ period: "30d" }, NOW), "week")[0]).toBe("2026-09-28"); // Monday
    expect(bucketKeys(resolveRange({ period: "12mo" }, NOW), "month")).toHaveLength(12);
  });
});
