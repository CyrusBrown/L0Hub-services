// Self-migrating D1: the framework's migrations, then the service's own, each applied once and recorded in l0w_migrations.
import { CORE_MIGRATIONS } from "./core-migrations";
import type { Migration } from "./types";

/** Statements separated by a semicolon at the end of a line; `--` comment lines are dropped. (D1's `exec` takes one
 * statement per line, so a migration is run as a batch of prepared statements instead.) */
export function splitStatements(sql: string): string[] {
  const text = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  return text
    .split(/;[ \t]*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function appliedNames(db: D1Database): Promise<Set<string>> {
  const r = await db.prepare("SELECT name FROM l0w_migrations").all<{ name: string }>();
  return new Set(r.results.map((x) => x.name));
}

export async function migrate(db: D1Database, own: Migration[] = []): Promise<void> {
  await db.prepare("CREATE TABLE IF NOT EXISTS l0w_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)").run();
  let done = await appliedNames(db);
  const all = [...CORE_MIGRATIONS, ...own.map((m) => ({ name: `svc:${m.name}`, sql: m.sql }))];
  for (const m of all) {
    if (done.has(m.name)) continue;
    const stmts = splitStatements(m.sql).map((s) => db.prepare(s));
    stmts.push(db.prepare("INSERT INTO l0w_migrations (name, applied_at) VALUES (?, ?)").bind(m.name, Math.floor(Date.now() / 1000)));
    try {
      await db.batch(stmts);
    } catch (e) {
      // another isolate may have just applied it
      done = await appliedNames(db);
      if (!done.has(m.name)) throw e;
    }
  }
}

const ready = new WeakMap<object, Promise<void>>();

/** Migrate once per database binding per isolate; a failure is retried on the next request. */
export function ensureMigrated(db: D1Database, own: Migration[] = []): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = migrate(db, own);
    ready.set(db, p);
    p.catch(() => ready.delete(db));
  }
  return p;
}
