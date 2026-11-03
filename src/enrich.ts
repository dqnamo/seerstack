// Server-side enrichment: derived from the request, never trusted from the client.

export type UrlParts = {
  host: string;
  path: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_term: string;
  utm_content: string;
};

export function parseUrl(raw: string): UrlParts {
  const empty = { host: "", path: "", utm_source: "", utm_medium: "", utm_campaign: "", utm_term: "", utm_content: "" };
  if (!raw) return empty;
  try {
    const u = new URL(raw);
    const q = u.searchParams;
    return {
      host: u.hostname.replace(/^www\./, ""),
      path: u.pathname || "/",
      utm_source: q.get("utm_source") ?? q.get("ref") ?? "",
      utm_medium: q.get("utm_medium") ?? "",
      utm_campaign: q.get("utm_campaign") ?? "",
      utm_term: q.get("utm_term") ?? "",
      utm_content: q.get("utm_content") ?? "",
    };
  } catch {
    return empty;
  }
}

// Only external referrers matter for attribution, so a same-host referrer (an
// internal or SPA navigation) yields an empty referrer_domain.
export function referrerDomain(referrer: string, pageHost: string): string {
  if (!referrer) return "";
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, "");
    return host === pageHost ? "" : host;
  } catch {
    return "";
  }
}

export type UserAgentParts = { browser: string; os: string; device: string };

const BROWSERS: [RegExp, string][] = [
  [/edg(e|a|ios)?\//i, "Edge"],
  [/opr\/|opera/i, "Opera"],
  [/samsungbrowser/i, "Samsung Internet"],
  [/firefox|fxios/i, "Firefox"],
  [/chrome|crios|chromium/i, "Chrome"],
  [/safari/i, "Safari"],
];

const OSES: [RegExp, string][] = [
  [/windows/i, "Windows"],
  [/iphone|ipad|ipod/i, "iOS"],
  [/android/i, "Android"],
  [/cros/i, "ChromeOS"],
  [/mac os x|macintosh/i, "macOS"],
  [/linux/i, "Linux"],
];

const BOTS =
  /bot|crawler|spider|crawling|headless|lighthouse|preview|slurp|facebookexternalhit|curl|wget|python-requests/i;

export function isBot(ua: string): boolean {
  return !ua || BOTS.test(ua);
}

export function parseUserAgent(ua: string): UserAgentParts {
  if (!ua) return { browser: "", os: "", device: "" };
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? "Other";
  const os = OSES.find(([re]) => re.test(ua))?.[1] ?? "Other";
  const device = /ipad|tablet/i.test(ua) ? "tablet" : /mobi|iphone|android/i.test(ua) ? "mobile" : "desktop";
  return { browser, os, device };
}

// ClickHouse DateTime64 wants "YYYY-MM-DD HH:MM:SS.sss" in UTC.
export function toClickHouseTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Cookieless visitors get an ID that is stable for one UTC day and can't be
// linked across days, because the day is part of the hash.
export async function cookielessId(
  salt: string,
  projectId: string,
  ip: string,
  ua: string,
  now: number,
): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10);
  return `c_${(await sha256Hex(`${salt}|${day}|${projectId}|${ip}|${ua}`)).slice(0, 24)}`;
}
