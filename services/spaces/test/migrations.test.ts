import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SPACES_MIGRATIONS } from "../src/migrations";

it("src/migrations.ts matches migrations/*.sql (run `pnpm gen`)", () => {
  const dir = join(import.meta.dirname, "..", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => ({ name: f.replace(/\.sql$/, ""), sql: readFileSync(join(dir, f), "utf8") }));
  expect(SPACES_MIGRATIONS).toEqual(files);
});
