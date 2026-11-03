import { beforeEach, describe, expect, it } from "vitest";
import { QueryError } from "../src/errors";
import {
  clearKeyCache,
  createProject,
  listProjects,
  normalizeDomain,
  originAllowed,
  projectByPublicKey,
  projectBySecretKey,
  rotateKeys,
  slugify,
  updateProject,
} from "../src/projects";
import { fakeD1 } from "./d1";

let db: D1Database;
beforeEach(() => {
  db = fakeD1();
  clearKeyCache();
});

describe("createProject", () => {
  it("creates a project with a public key and a secret key that resolve back to it", async () => {
    const { project, secret_key } = await createProject(db, {
      name: "Saintdex",
      domains: ["https://www.saintdex.com/"],
    });
    expect(project).toMatchObject({ id: "saintdex", name: "Saintdex", domains: ["saintdex.com"] });
    expect(project.public_key).toMatch(/^pk_[0-9a-f]{32}$/);
    expect(secret_key).toMatch(/^sk_[0-9a-f]{48}$/);
    expect((await projectByPublicKey(db, project.public_key))?.id).toBe("saintdex");
    expect((await projectBySecretKey(db, secret_key))?.id).toBe("saintdex");
    expect(await listProjects(db)).toHaveLength(1);
  });

  it("stores only the secret key's hash", async () => {
    const { secret_key } = await createProject(db, { name: "Saintdex" });
    const row = await db.prepare("SELECT * FROM projects").first<Record<string, string>>();
    expect(Object.values(row ?? {})).not.toContain(secret_key);
  });

  it("rejects duplicate and invalid IDs", async () => {
    await createProject(db, { name: "Saintdex" });
    await expect(createProject(db, { name: "Saintdex" })).rejects.toThrow(/already exists/);
    await expect(createProject(db, { name: "x", id: "Bad ID!" })).rejects.toThrow(QueryError);
    await expect(createProject(db, { name: "x", domains: ["not a domain"] })).rejects.toThrow(/isn't a domain/);
  });
});

describe("keys", () => {
  it("rejects unknown and malformed keys", async () => {
    expect(await projectByPublicKey(db, `pk_${"0".repeat(32)}`)).toBeNull();
    expect(await projectByPublicKey(db, "nope")).toBeNull();
    expect(await projectBySecretKey(db, `pk_${"0".repeat(32)}`)).toBeNull();
  });

  it("rotates the secret key, the public key, or both", async () => {
    const { project, secret_key } = await createProject(db, { name: "App" });
    const secret = await rotateKeys(db, "app", "secret");
    expect(secret.project.public_key).toBe(project.public_key);
    expect(await projectBySecretKey(db, secret_key)).toBeNull();
    expect((await projectBySecretKey(db, secret.secret_key ?? ""))?.id).toBe("app");

    const pub = await rotateKeys(db, "app", "public");
    expect(pub.secret_key).toBeUndefined();
    expect(await projectByPublicKey(db, project.public_key)).toBeNull();
    expect((await projectBySecretKey(db, secret.secret_key ?? ""))?.id).toBe("app");
  });
});

it("updates names and domains", async () => {
  await createProject(db, { name: "App", domains: ["a.com"] });
  expect(await updateProject(db, "app", { domains: ["b.com", "localhost"] })).toMatchObject({
    name: "App",
    domains: ["b.com", "localhost"],
  });
  await expect(updateProject(db, "missing", { name: "x" })).rejects.toThrow(/Unknown project/);
});

describe("helpers", () => {
  it("slugifies names and normalizes domains", () => {
    expect(slugify("Saint Dex — Catholic Saints!")).toBe("saint-dex-catholic-saints");
    expect(normalizeDomain("https://www.Saintdex.com/path")).toBe("saintdex.com");
    expect(normalizeDomain("localhost")).toBe("localhost");
  });

  it("allows a project's domains and their subdomains only", () => {
    const project = { domains: ["site.com"] };
    expect(originAllowed(project, "https://site.com")).toBe(true);
    expect(originAllowed(project, "https://www.site.com")).toBe(true);
    expect(originAllowed(project, "https://notsite.com")).toBe(false);
    expect(originAllowed(project, undefined)).toBe(false);
    expect(originAllowed({ domains: [] }, "https://site.com")).toBe(false);
  });
});
