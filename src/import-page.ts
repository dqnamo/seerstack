import { escapeHtml, page } from "./auth";
import type { Env } from "./env";
import { QueryError } from "./errors";
import { cancelImport, getImport, type ImportSummary, listImports, startPosthogImport } from "./imports";
import { getProject, listProjects } from "./projects";
import { beginSignIn, type OwnerSession, ownerSession } from "./sign-in";

// /import: the owner signs in with GitHub, picks a project and pastes a
// PostHog personal API key, which goes from the browser to Seerstack and
// never through an agent. /import/:id follows the import until it's done.

type FormValues = {
  project?: string;
  posthog_host?: string;
  posthog_url?: string;
  posthog_project_id?: string;
  visitor_ids?: string;
  date_from?: string;
  date_to?: string;
  events?: string;
};

function headers(): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    // Not no-referrer: with it, browsers send `Origin: null` on our own form
    // posts, which trusted() then refuses.
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
}

const redirect = (location: string) => new Response(null, { status: 303, headers: { Location: location } });

const forbidden = () =>
  page("Not allowed", "<h1>Not allowed</h1><p>Reload the page and try again.</p>", headers(), 403);

// Forms carry the session's CSRF token, and browsers that send Origin must
// send ours.
function trusted(req: Request, form: FormData, session: OwnerSession): boolean {
  const origin = req.headers.get("origin");
  return (!origin || origin === new URL(req.url).origin) && form.get("csrf") === session.csrf;
}

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const when = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—");
const count = (n: number) => n.toLocaleString("en-US");

// --- the form -------------------------------------------------------------------

const option = (value: string, label: string, selected?: string) =>
  `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;

const field = (name: keyof FormValues, values: FormValues) =>
  `name="${name}" value="${escapeHtml(values[name] ?? "")}"`;

function importRows(imports: ImportSummary[]): string {
  if (imports.length === 0) return "<p>None yet.</p>";
  const rows = imports.map(
    (i) => `<tr>
  <td><a href="/import/${escapeHtml(i.id)}">${escapeHtml(i.project)}</a></td>
  <td>${escapeHtml(i.status)}${i.status === "running" ? ` (${i.progress.percent}%)` : ""}</td>
  <td>${count(i.progress.imported)} events</td>
  <td>${when(i.created_at)}</td>
</tr>`,
  );
  return `<table><tr><th>Project</th><th>Status</th><th>Imported</th><th>Started</th></tr>${rows.join("")}</table>`;
}

async function formPage(
  env: Env,
  session: OwnerSession,
  values: FormValues,
  message: { error?: string; notice?: string; link?: string } = {},
  status = 200,
): Promise<Response> {
  const [projects, imports] = await Promise.all([listProjects(env.DB), listImports(env)]);
  const link = message.link ? ` <a href="/import/${escapeHtml(message.link)}">See it</a>.` : "";
  const banner = message.error
    ? `<p class="warn" role="alert">${escapeHtml(message.error)}${link}</p>`
    : message.notice
      ? `<p class="warn">${escapeHtml(message.notice)}</p>`
      : "";
  const form =
    projects.length === 0
      ? "<p>There are no Seerstack projects yet. Create one with <code>create_project</code> first.</p>"
      : `<form method="post" action="/import" autocomplete="off">
  <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
  <label>Seerstack project
    <select name="project">${projects.map((p) => option(p.id, `${p.name} (${p.id})`, values.project)).join("")}</select>
  </label>
  <label>PostHog region
    <select name="posthog_host">${option("us", "US (us.posthog.com)", values.posthog_host)}${option("eu", "EU (eu.posthog.com)", values.posthog_host)}</select>
  </label>
  <label>PostHog project ID
    <input ${field("posthog_project_id", values)} inputmode="numeric" pattern="[0-9]+" required>
    <small class="hint">The number in your PostHog URL: us.posthog.com/project/<strong>12345</strong></small>
  </label>
  <label>Personal API key
    <input name="posthog_api_key" type="password" required spellcheck="false" autocomplete="off">
    <small class="hint">In PostHog → Settings → Personal API keys, create one with only <strong>Query Read</strong> access, limited to this project. Seerstack uses it for this import and doesn't keep it. Delete it in PostHog once the import is done.</small>
  </label>
  <label>Visitors
    <select name="visitor_ids">${option("daily", "Counted per day", values.visitor_ids)}${option("persistent", "Recognised across days", values.visitor_ids)}</select>
    <small class="hint">Match the site's Seerstack script tag: across days only if it has <code>data-persist</code>.</small>
  </label>
  <details>
    <summary>More options</summary>
    <label>Self-hosted PostHog URL
      <input ${field("posthog_url", values)} placeholder="https://posthog.example.com">
      <small class="hint">Used instead of the region.</small>
    </label>
    <label>From <input type="date" ${field("date_from", values)}>
      <small class="hint">Default: PostHog's first event.</small>
    </label>
    <label>To, inclusive <input type="date" ${field("date_to", values)}>
      <small class="hint">Default: when Seerstack started recording the project itself, so nothing is counted twice.</small>
    </label>
    <label>Only these events
      <input ${field("events", values)} placeholder="$pageview, signup">
      <small class="hint">Comma-separated. Default: pageviews and your own events, not PostHog's automatic ones.</small>
    </label>
  </details>
  <p><button>Start import</button></p>
</form>`;
  return page(
    "Import from PostHog",
    `<h1>Import from PostHog</h1>
<p>Copies a project's past events from PostHog into Seerstack, shaped like Seerstack's own tracking. Signed in as <strong>${escapeHtml(session.login)}</strong>.</p>
${banner}
${form}
<h2>Recent imports</h2>
${importRows(imports)}`,
    headers(),
    status,
  );
}

// GET /import
export async function showImportForm(req: Request, env: Env): Promise<Response> {
  const session = await ownerSession(req, env);
  if (!session) return beginSignIn(req, env);
  return formPage(env, session, { project: new URL(req.url).searchParams.get("project") ?? undefined });
}

// POST /import
export async function submitImport(req: Request, env: Env): Promise<Response> {
  const session = await ownerSession(req, env);
  if (!session) return redirect("/import");
  const form = await req.formData();
  if (!trusted(req, form, session)) return forbidden();

  // Everything but the key is shown again if something's wrong.
  const values: FormValues = Object.fromEntries(
    (
      [
        "project",
        "posthog_host",
        "posthog_url",
        "posthog_project_id",
        "visitor_ids",
        "date_from",
        "date_to",
        "events",
      ] as const
    ).map((name) => [name, text(form, name)]),
  );
  const apiKey = text(form, "posthog_api_key");
  if (!values.project || !(await getProject(env.DB, values.project))) {
    return formPage(env, session, values, { error: "Pick a Seerstack project." }, 400);
  }
  if (!values.posthog_project_id || !apiKey) {
    return formPage(env, session, values, { error: "Enter the PostHog project ID and a personal API key." }, 400);
  }

  const running = (await listImports(env, values.project)).find((i) => i.status === "running");
  if (running) {
    return formPage(
      env,
      session,
      values,
      { error: `An import is already running for ${values.project}.`, link: running.id },
      409,
    );
  }

  try {
    const started = await startPosthogImport(env, values.project, {
      posthog_project_id: values.posthog_project_id,
      posthog_api_key: apiKey,
      posthog_host: values.posthog_url ?? values.posthog_host,
      date_from: values.date_from,
      date_to: values.date_to,
      events: values.events
        ?.split(",")
        .map((e) => e.trim())
        .filter(Boolean),
      visitor_ids: values.visitor_ids === "persistent" ? "persistent" : "daily",
    });
    if (!("id" in started)) {
      return formPage(env, session, values, { notice: `Nothing to import. ${started.note ?? ""}`.trim() });
    }
    return redirect(`/import/${encodeURIComponent(started.id)}`);
  } catch (error) {
    if (error instanceof QueryError) {
      const message = error.hint ? `${error.message.replace(/\.?$/, ".")} ${error.hint}` : error.message;
      return formPage(env, session, values, { error: message }, 400);
    }
    console.error(error);
    return formPage(env, session, values, { error: "Something went wrong. Try again in a moment." }, 500);
  }
}

// --- one import -------------------------------------------------------------------

function statusPage(session: OwnerSession, i: ImportSummary, error?: string): Response {
  const running = i.status === "running";
  const read = i.progress.imported + i.progress.skipped;
  const done =
    i.status === "completed"
      ? "<p>Done. You can delete the PostHog API key now.</p>"
      : i.status === "failed"
        ? `<p class="warn" role="alert">${escapeHtml(i.error ?? "The import failed.")}</p><p>Start it again from the import page: it carries on from where it stopped.</p>`
        : i.status === "cancelled"
          ? "<p>Cancelled. Events imported so far stay; starting again carries on from here.</p>"
          : "";
  const cancel = running
    ? `<form method="post" action="/import/${escapeHtml(i.id)}/cancel">
  <input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">
  <button>Cancel import</button>
</form>`
    : "";
  return page(
    `Import ${i.status}`,
    `${running ? '<meta http-equiv="refresh" content="5">' : ""}
<h1>Import ${escapeHtml(i.status)}</h1>
<p>From <strong>${escapeHtml(i.source_project)}</strong> into <strong>${escapeHtml(i.project)}</strong>: ${when(i.range.from)} to ${when(i.range.until)}.</p>
${error ? `<p class="warn" role="alert">${escapeHtml(error)}</p>` : ""}
<progress value="${i.status === "completed" ? 1 : read}" max="${i.status === "completed" ? 1 : Math.max(i.progress.estimated, read, 1)}"></progress>
<p>${count(i.progress.imported)} imported and ${count(i.progress.skipped)} skipped (bots and repeat views) of about ${count(i.progress.estimated)}. Read up to ${when(i.progress.through)}.</p>
${done}
${cancel}
<p><a href="/import">All imports</a></p>`,
    headers(),
  );
}

const notFound = () =>
  page("Not found", '<h1>No such import</h1><p><a href="/import">All imports</a></p>', headers(), 404);

// GET /import/:id
export async function showImport(req: Request, env: Env, id: string): Promise<Response> {
  const session = await ownerSession(req, env);
  if (!session) return beginSignIn(req, env);
  const found = await getImport(env, id);
  return found ? statusPage(session, found) : notFound();
}

// POST /import/:id/cancel
export async function submitCancel(req: Request, env: Env, id: string): Promise<Response> {
  const session = await ownerSession(req, env);
  if (!session) return redirect(`/import/${encodeURIComponent(id)}`);
  if (!trusted(req, await req.formData(), session)) return forbidden();
  try {
    await cancelImport(env, id);
  } catch (error) {
    if (!(error instanceof QueryError)) throw error;
    const found = await getImport(env, id);
    return found ? statusPage(session, found, error.message) : notFound();
  }
  return redirect(`/import/${encodeURIComponent(id)}`);
}
