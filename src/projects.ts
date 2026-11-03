import { sha256Hex } from "./enrich";
import { QueryError } from "./errors";

// Projects live in D1 and are managed through the MCP tools. Each has a public
// key (pk_…) for the browser script tag and a secret key (sk_…) for
// server-side events. Only the secret key's hash is stored.

export type Project = { id: string; name: string; domains: string[]; public_key: string; created_at: string };

type Row = { id: string; name: string; domains: string; public_key: string; created_at: string };

const COLUMNS = "id, name, domains, public_key, created_at";
const KEY_CACHE_MS = 60_000;

const toProject = (row: Row): Project => ({ ...row, domains: JSON.parse(row.domains) as string[] });

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const newPublicKey = () => `pk_${randomHex(16)}`;
const newSecretKey = () => `sk_${randomHex(24)}`;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Accepts "saintdex.com", "https://www.saintdex.com/path" or "localhost" and
// keeps the bare hostname; subdomains are matched by originAllowed.
export function normalizeDomain(input: string): string {
  const trimmed = input.trim().toLowerCase();
  let host = trimmed;
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname;
  } catch {}
  host = host.replace(/^www\./, "");
  if (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".")) {
    throw new QueryError(`"${input}" isn't a domain`, 'Pass hostnames like "saintdex.com" or "localhost".');
  }
  return host;
}

// Browser events must come from one of the project's domains or a subdomain.
// A project with no domains takes server events only.
export function originAllowed(project: Pick<Project, "domains">, origin: string | undefined): boolean {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return project.domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

// --- lookups --------------------------------------------------------------

// Ingest resolves a key on every request, so lookups are cached per isolate.
// A rotated key can keep working in other isolates for up to a minute.
const keyCache = new Map<string, { project: Project | null; expires: number }>();

async function cachedLookup(cacheKey: string, load: () => Promise<Project | null>): Promise<Project | null> {
  const hit = keyCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.project;
  const project = await load();
  keyCache.set(cacheKey, { project, expires: Date.now() + KEY_CACHE_MS });
  return project;
}

export function clearKeyCache(): void {
  keyCache.clear();
}

export async function projectByPublicKey(db: D1Database, key: string): Promise<Project | null> {
  if (!/^pk_[0-9a-f]{32}$/.test(key)) return null;
  return cachedLookup(key, async () => {
    const row = await db.prepare(`SELECT ${COLUMNS} FROM projects WHERE public_key = ?`).bind(key).first<Row>();
    return row ? toProject(row) : null;
  });
}

export async function projectBySecretKey(db: D1Database, key: string): Promise<Project | null> {
  if (!/^sk_[0-9a-f]{48}$/.test(key)) return null;
  const hash = await sha256Hex(key);
  return cachedLookup(hash, async () => {
    const row = await db.prepare(`SELECT ${COLUMNS} FROM projects WHERE secret_key_hash = ?`).bind(hash).first<Row>();
    return row ? toProject(row) : null;
  });
}

export async function listProjects(db: D1Database): Promise<Project[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM projects ORDER BY created_at`).all<Row>();
  return results.map(toProject);
}

export async function getProject(db: D1Database, id: string): Promise<Project | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM projects WHERE id = ?`).bind(id).first<Row>();
  return row ? toProject(row) : null;
}

// --- changes --------------------------------------------------------------

export async function createProject(
  db: D1Database,
  input: { name: string; id?: string; domains?: string[] },
): Promise<{ project: Project; secret_key: string }> {
  const id = input.id ?? slugify(input.name);
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) {
    throw new QueryError(
      `"${id}" isn't a valid project ID`,
      "Use lowercase letters, numbers and dashes, e.g. saintdex.",
    );
  }
  if (await getProject(db, id)) {
    throw new QueryError(`A project with ID "${id}" already exists`, "Pick another id, or use update_project.");
  }
  const project: Project = {
    id,
    name: input.name.trim(),
    domains: [...new Set((input.domains ?? []).map(normalizeDomain))],
    public_key: newPublicKey(),
    created_at: new Date().toISOString(),
  };
  const secretKey = newSecretKey();
  await db
    .prepare(
      "INSERT INTO projects (id, name, domains, public_key, secret_key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      project.id,
      project.name,
      JSON.stringify(project.domains),
      project.public_key,
      await sha256Hex(secretKey),
      project.created_at,
    )
    .run();
  return { project, secret_key: secretKey };
}

export async function updateProject(
  db: D1Database,
  id: string,
  changes: { name?: string; domains?: string[] },
): Promise<Project> {
  const current = await getProject(db, id);
  if (!current) throw new QueryError(`Unknown project "${id}"`, "Call list_projects for project IDs.");
  const next: Project = {
    ...current,
    name: changes.name?.trim() || current.name,
    domains: changes.domains ? [...new Set(changes.domains.map(normalizeDomain))] : current.domains,
  };
  await db
    .prepare("UPDATE projects SET name = ?, domains = ? WHERE id = ?")
    .bind(next.name, JSON.stringify(next.domains), id)
    .run();
  clearKeyCache();
  return next;
}

export async function rotateKeys(
  db: D1Database,
  id: string,
  which: "public" | "secret" | "both",
): Promise<{ project: Project; secret_key?: string }> {
  const current = await getProject(db, id);
  if (!current) throw new QueryError(`Unknown project "${id}"`, "Call list_projects for project IDs.");
  const project = which === "secret" ? current : { ...current, public_key: newPublicKey() };
  const secretKey = which === "public" ? undefined : newSecretKey();
  await db
    .prepare("UPDATE projects SET public_key = ?, secret_key_hash = COALESCE(?, secret_key_hash) WHERE id = ?")
    .bind(project.public_key, secretKey ? await sha256Hex(secretKey) : null, id)
    .run();
  clearKeyCache();
  return { project, ...(secretKey && { secret_key: secretKey }) };
}
