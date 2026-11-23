// A minimal in-memory D1 for tests, over node:sqlite (the same approach as the hub's test/d1.ts). Empty: the service migrates it.
import { DatabaseSync } from "node:sqlite";

class Stmt {
  private args: unknown[] = [];
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
  ) {}
  bind(...a: unknown[]): this {
    this.args = a;
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...(this.args as never[])) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] };
  }
  async run(): Promise<{ meta: { changes: number } }> {
    const r = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { meta: { changes: Number(r.changes) } };
  }
  /** Run without wrapping (for batch). */
  runSync(): { meta: { changes: number } } {
    const r = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { meta: { changes: Number(r.changes) } };
  }
}

export function fakeD1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  return {
    raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    // a batch is one transaction, as in D1
    batch: async (stmts: Stmt[]) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database & { raw: DatabaseSync };
}
