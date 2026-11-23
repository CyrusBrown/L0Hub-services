// For a service that prefers wrangler's `migrations_dir` to the self-migrating `migrations` option:
//   node ../../packages/core/scripts/merge-migrations.mjs migrations dist/migrations
// copies the framework's migrations (0001...) and then the service's own (name them 0100_..., 0101_...) into one folder.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [own, out] = process.argv.slice(2);
if (!own || !out) {
  console.error("usage: merge-migrations.mjs <the service's migrations dir> <output dir>");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const core = join(import.meta.dirname, "..", "migrations");
for (const [dir, files] of [[core, readdirSync(core)], [own, readdirSync(own)]]) {
  for (const f of files.filter((x) => x.endsWith(".sql")).sort()) copyFileSync(join(dir, f), join(out, f));
}
