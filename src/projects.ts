// Every project Seerstack tracks. Add one here and redeploy.
//
// The key is the project ID you put in the script tag (`data-project`) and in
// server-side events. `domains` are the sites allowed to send browser events,
// subdomains included; add "localhost" while developing. A backend-only
// project can leave `domains` empty, since server events use INGEST_KEY.

export type Project = { name: string; domains: string[] };

export const PROJECTS: Record<string, Project> = {
  example: { name: "Example", domains: ["example.com"] },
};

export function originAllowed(project: Project, origin: string | undefined): boolean {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return project.domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
