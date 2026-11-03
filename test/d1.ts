import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS = resolve(import.meta.dirname, "../migrations");

// A D1Database stand-in backed by node:sqlite, with the real migrations applied.
// Covers the prepare().bind().first()/all()/run() calls the app makes.
export function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const migrations = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
  for (const file of migrations.sort()) db.exec(readFileSync(resolve(MIGRATIONS, file), "utf8"));

  const statement = (sql: string, args: SQLInputValue[] = []) => ({
    bind: (...next: SQLInputValue[]) => statement(sql, next),
    first: async <T>() => ((db.prepare(sql).get(...args) as T | undefined) ?? null) as T | null,
    all: async <T>() => ({ results: db.prepare(sql).all(...args) as T[], success: true, meta: {} }),
    run: async () => ({ success: true, meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });

  return { prepare: (sql: string) => statement(sql) } as unknown as D1Database;
}
