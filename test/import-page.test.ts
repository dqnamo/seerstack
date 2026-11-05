import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/index";
import { createProject } from "../src/projects";
import { type ImportWorld, importWorld, POSTHOG_KEY } from "./import-world";

// The /import page: GitHub sign-in for the owner, the form that takes the
// PostHog key, and the status page.

const SITE = "https://seerstack.com";

let w: ImportWorld;
beforeEach(async () => {
  w = await importWorld();
  vi.stubGlobal("fetch", vi.fn(w.fetch));
});
afterEach(() => vi.unstubAllGlobals());

const cookieFrom = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0] ?? "";

const get = (path: string, cookie = "") => app.request(`${SITE}${path}`, { headers: { Cookie: cookie } }, w.env);

const post = (path: string, fields: Record<string, string>, cookie: string, headers: Record<string, string> = {}) =>
  app.request(
    `${SITE}${path}`,
    { method: "POST", body: new URLSearchParams(fields), headers: { Cookie: cookie, Origin: SITE, ...headers } },
    w.env,
  );

// Goes through GitHub sign-in and returns the session cookie.
async function signIn(path = "/import"): Promise<string> {
  const toGithub = await get(path);
  const state = new URL(toGithub.headers.get("location") ?? "").searchParams.get("state") ?? "";
  const back = await get(`/callback/import?code=gh-code&state=${state}`, cookieFrom(toGithub, "seerstack_signin"));
  return cookieFrom(back, "seerstack_session");
}

const csrfOf = async (res: Response) => /name="csrf" value="([^"]+)"/.exec(await res.text())?.[1] ?? "";

async function startFromForm(session: string, fields: Record<string, string> = {}) {
  const csrf = await csrfOf(await get("/import", session));
  return post(
    "/import",
    {
      csrf,
      project: "dqnamo",
      posthog_host: "us",
      posthog_project_id: "479710",
      posthog_api_key: POSTHOG_KEY,
      visitor_ids: "daily",
      ...fields,
    },
    session,
  );
}

describe("signing in", () => {
  it("sends you to GitHub, then back to the page as the owner", async () => {
    const toGithub = await get("/import?project=dqnamo");
    expect(toGithub.status).toBe(302);
    const github = new URL(toGithub.headers.get("location") ?? "");
    expect(github.origin + github.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(github.searchParams.get("redirect_uri")).toBe(`${SITE}/callback/import`);
    expect(github.searchParams.get("code_challenge_method")).toBe("S256");
    expect(toGithub.headers.getSetCookie()[0]).toMatch(
      /^seerstack_signin=.+; Path=\/callback\/import; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );

    const back = await get(
      `/callback/import?code=gh-code&state=${github.searchParams.get("state")}`,
      cookieFrom(toGithub, "seerstack_signin"),
    );
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/import?project=dqnamo");
    expect(back.headers.getSetCookie().join("\n")).toMatch(/seerstack_session=.+; Path=\/import; .*HttpOnly; Secure/);

    const form = await get("/import?project=dqnamo", cookieFrom(back, "seerstack_session"));
    const html = await form.text();
    expect(form.status).toBe(200);
    expect(html).toContain("Signed in as <strong>owner</strong>");
    expect(html).toContain('<option value="dqnamo" selected>');
    expect(form.headers.get("cache-control")).toBe("no-store");
    expect(form.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // no-referrer would make browsers post `Origin: null`, which the form refuses.
    expect(form.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("refuses anyone but the owner, and forged, replayed or tampered sign-ins", async () => {
    const toGithub = await get("/import");
    const signInCookie = cookieFrom(toGithub, "seerstack_signin");
    const state = new URL(toGithub.headers.get("location") ?? "").searchParams.get("state");

    expect((await get(`/callback/import?code=c&state=wrong`, signInCookie)).status).toBe(403);
    expect((await get(`/callback/import?code=c&state=${state}`)).status).toBe(403);

    w.githubUser = { id: 2, login: "someone" };
    const stranger = await get(`/callback/import?code=c&state=${state}`, signInCookie);
    expect(stranger.status).toBe(403);
    expect(await stranger.text()).toContain("someone can&#39;t use this Seerstack");
    expect(stranger.headers.getSetCookie().join()).not.toContain("seerstack_session");

    w.githubUser = { id: 1, login: "owner" };
    const session = await signIn();
    const tampered = `${session.slice(0, -2)}xx`;
    expect((await get("/import", tampered)).status).toBe(302);
    // A session minted for another owner stops working when the owner changes.
    w.env.ALLOWED_GITHUB_USER_ID = "3";
    expect((await get("/import", session)).status).toBe(302);
  });
});

describe("the import form", () => {
  it("starts an import, then follows it to the end, without keeping the key", async () => {
    const session = await signIn();
    const started = await startFromForm(session);
    expect(started.status).toBe(303);
    const statusPath = started.headers.get("location") ?? "";
    expect(statusPath).toMatch(/^\/import\/imp_[0-9a-f]{16}$/);

    const id = statusPath.split("/").pop() ?? "";
    const row = await w.env.DB.prepare("SELECT * FROM imports WHERE id = ?").bind(id).first();
    expect(JSON.stringify(row)).not.toContain(POSTHOG_KEY);
    expect(JSON.stringify(w.instances.get(id)?.params)).not.toContain(POSTHOG_KEY);

    const running = await (await get(statusPath, session)).text();
    expect(running).toContain("<h1>Import running</h1>");
    expect(running).toContain('<meta http-equiv="refresh" content="5">');
    expect(running).toContain("Cancel import");

    await w.runWorkflow(id);
    const done = await (await get(statusPath, session)).text();
    expect(done).toContain("<h1>Import completed</h1>");
    expect(done).toContain("You can delete the PostHog API key now");
    expect(done).not.toContain("http-equiv");

    const again = await startFromForm(session);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Nothing to import. Already imported up to");
  });

  it("points to the running import instead of starting another", async () => {
    const session = await signIn();
    const statusPath = (await startFromForm(session)).headers.get("location") ?? "";
    const second = await startFromForm(session);
    expect(second.status).toBe(409);
    expect(await second.text()).toContain(`already running for dqnamo. <a href="${statusPath}">See it</a>`);
    expect(w.instances.size).toBe(1);
  });

  it("shows PostHog's refusal on the form, keeping everything but the key", async () => {
    const session = await signIn();
    const refused = await startFromForm(session, { posthog_api_key: "phx_wrong_key" });
    const html = await refused.text();
    expect(refused.status).toBe(400);
    expect(html).toContain("PostHog refused the API key (401): Invalid personal API key. Use a personal API key");
    expect(html).toContain('name="posthog_project_id" value="479710"');
    expect(html).not.toContain("phx_wrong_key");
    expect(w.instances.size).toBe(0);
  });

  it("only takes posts from the signed-in page", async () => {
    const session = await signIn();
    const csrf = await csrfOf(await get("/import", session));
    const fields = { project: "dqnamo", posthog_project_id: "479710", posthog_api_key: POSTHOG_KEY };

    expect((await post("/import", fields, session)).status).toBe(403);
    expect((await post("/import", { ...fields, csrf: "forged" }, session)).status).toBe(403);
    expect((await post("/import", { ...fields, csrf }, session, { Origin: "https://evil.example" })).status).toBe(403);
    const signedOut = await post("/import", { ...fields, csrf }, "");
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe("/import");
    expect(w.instances.size).toBe(0);
  });

  it("cancels from the status page", async () => {
    const session = await signIn();
    const statusPath = (await startFromForm(session)).headers.get("location") ?? "";
    const csrf = await csrfOf(await get(statusPath, session));

    expect((await post(`${statusPath}/cancel`, { csrf: "forged" }, session)).status).toBe(403);
    const cancelled = await post(`${statusPath}/cancel`, { csrf }, session);
    expect(cancelled.status).toBe(303);
    expect(await (await get(statusPath, session)).text()).toContain("<h1>Import cancelled</h1>");
    expect(w.instances.get(statusPath.split("/").pop() ?? "")?.terminated).toBe(true);
    expect((await get("/import/imp_missing", session)).status).toBe(404);
  });

  it("escapes what it shows", async () => {
    await createProject(w.env.DB, { name: "<script>alert(1)</script>", id: "xss" });
    const html = await (await get("/import", await signIn())).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&#60;script&#62;alert(1)");
  });
});
