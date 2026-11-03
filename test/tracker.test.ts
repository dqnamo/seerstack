import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { TRACKER_JS } from "../src/tracker";

type Sent = { key: string; event: string; anonymous_id?: string; user_id?: string; referrer: string; url: string };
type Storage = Map<string, string> | "blocked";

// Runs /s.js against a fake page and collects what it sends.
function loadTracker(attributes: Record<string, string>, storage: Storage = new Map(), path = "/a") {
  const sent: Sent[] = [];
  const location = {
    href: `https://site.com${path}`,
    origin: "https://site.com",
    pathname: path,
    hostname: "site.com",
    protocol: "https:",
  };
  const window: { seerstack?: { track: (e: string, p?: object) => void; identify: (id: string) => void } } & Record<
    string,
    unknown
  > = {
    addEventListener() {},
  };
  const blocked = () => {
    throw new Error("SecurityError");
  };
  runInNewContext(TRACKER_JS, {
    window,
    document: {
      currentScript: {
        src: "https://seerstack.com/s.js",
        getAttribute: (name: string) => attributes[name] ?? null,
        hasAttribute: (name: string) => name in attributes,
      },
      referrer: "https://news.ycombinator.com/",
    },
    location,
    navigator: { webdriver: false, sendBeacon: (_url: string, body: string) => sent.push(JSON.parse(body)) > 0 },
    localStorage:
      storage === "blocked"
        ? { getItem: blocked, setItem: blocked }
        : { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
    history: { pushState() {} },
    crypto,
    URL,
  });
  return { sent, seerstack: window.seerstack };
}

const KEY = { "data-key": "pk_test" };

describe("tracker", () => {
  it("stores nothing by default, leaving the visitor ID to the server", () => {
    const storage = new Map<string, string>();
    const { sent } = loadTracker(KEY, storage);
    expect(sent).toEqual([expect.objectContaining({ key: "pk_test", event: "$pageview", url: "https://site.com/a" })]);
    expect(sent[0]?.anonymous_id).toBeUndefined();
    expect(storage.size).toBe(0);
  });

  it("with data-persist, keeps one random visitor ID across page loads", () => {
    const storage = new Map<string, string>();
    const first = loadTracker({ ...KEY, "data-persist": "" }, storage);
    const id = first.sent[0]?.anonymous_id;
    expect(id).toMatch(/^p_[0-9a-f]{32}$/);
    expect(storage.get("seerstack_id")).toBe(id);

    const nextDay = loadTracker({ ...KEY, "data-persist": "" }, storage, "/b");
    expect(nextDay.sent[0]?.anonymous_id).toBe(id);

    nextDay.seerstack?.identify("u_1");
    expect(nextDay.sent.at(-1)).toMatchObject({ event: "$identify", user_id: "u_1", anonymous_id: id });
  });

  it("falls back to the server's ID when storage is blocked", () => {
    const { sent } = loadTracker({ ...KEY, "data-persist": "" }, "blocked");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.anonymous_id).toBeUndefined();
  });

  it("sends nothing for an ignored browser or a missing key", () => {
    expect(loadTracker(KEY, new Map([["seerstack_ignore", "1"]])).sent).toHaveLength(0);
    expect(loadTracker({}).sent).toHaveLength(0);
  });
});
