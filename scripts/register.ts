// Register (or update) a service with a hub's admin API: PUT <hub>/v0/admin/services/<name>.
//
//   SERVICE_SEED=... ADMIN_TOKEN=... pnpm register --hub https://hub.example --name board --kind board \
//     --title Board --description "Topics and posts" --docs https://hub.example/services/board \
//     --roles moderator,poster --ext-git https://git.example/l0wservices.git --ext-commit <40 hex> --ext-path extensions/board
//
// Every option may also come from a JSON file (--config service.json, keys as the long option names without the dashes,
// e.g. {"name": "board", "extCommit": "..."}) or an environment variable (HUB_BASE, SERVICE_SEED, ADMIN_TOKEN).
// --dry-run prints what would be sent. The seed and the token are never printed.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { registerWithHub, type RegisterSpec } from "@l0wservices/core";

const { values: v } = parseArgs({
  options: {
    config: { type: "string" },
    hub: { type: "string" },
    name: { type: "string" },
    kind: { type: "string" },
    title: { type: "string" },
    description: { type: "string" },
    docs: { type: "string" },
    roles: { type: "string" },
    "ext-git": { type: "string" },
    "ext-commit": { type: "string" },
    "ext-path": { type: "string" },
    default: { type: "string" },
    seq: { type: "string" },
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (v.help) {
  console.log("usage: pnpm register --hub <url> --name <name> --kind <kind> --title <title> [--description ..] [--docs <https url>]\n" +
    "         [--roles a,b] [--ext-git <https url> --ext-commit <hex> --ext-path <dir>] [--default on|off] [--seq N] [--config file.json] [--dry-run]\n" +
    "       env: SERVICE_SEED, ADMIN_TOKEN, HUB_BASE");
  process.exit(0);
}

const file: Record<string, unknown> = v.config ? JSON.parse(readFileSync(v.config, "utf8")) : {};
const pick = (opt: string, camel: string, env?: string): string | undefined => {
  const x = (v as Record<string, unknown>)[opt] ?? file[camel] ?? file[opt] ?? (env ? process.env[env] : undefined);
  return x === undefined ? undefined : String(x);
};
const need = (x: string | undefined, what: string): string => {
  if (!x) {
    console.error(`missing ${what}`);
    return process.exit(2);
  }
  return x;
};

const rolesRaw = (v.roles ?? file.roles) as string | string[] | undefined;
const roles = Array.isArray(rolesRaw) ? rolesRaw : (rolesRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const extGit = pick("ext-git", "extGit");
const spec: RegisterSpec = {
  seed: need(process.env.SERVICE_SEED, "SERVICE_SEED (environment)"),
  name: need(pick("name", "name"), "--name"),
  kind: need(pick("kind", "kind"), "--kind"),
  title: need(pick("title", "title"), "--title"),
  description: pick("description", "description"),
  docs: pick("docs", "docs"),
  roles,
  extension: extGit ? { git: extGit, commit: need(pick("ext-commit", "extCommit"), "--ext-commit"), path: need(pick("ext-path", "extPath"), "--ext-path") } : undefined,
  default: (pick("default", "default") ?? "on") as "on" | "off",
  seq: pick("seq", "seq") === undefined ? undefined : Number(pick("seq", "seq")),
};
if (spec.default !== "on" && spec.default !== "off") {
  console.error("--default must be on or off");
  process.exit(2);
}

try {
  const r = await registerWithHub({
    hub: need(pick("hub", "hub", "HUB_BASE"), "--hub (or HUB_BASE)"),
    adminToken: v["dry-run"] ? "" : need(process.env.ADMIN_TOKEN, "ADMIN_TOKEN (environment)"),
    spec,
    dryRun: v["dry-run"],
  });
  if (v["dry-run"]) console.log(JSON.stringify({ address: r.address, body: r.body }, null, 2));
  else console.log(`${r.status === 201 ? "registered" : "updated"} ${r.address}\n${JSON.stringify(r.response, null, 2)}`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
