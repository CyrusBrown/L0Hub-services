// Settings read from the Worker's env.
import { names, payloads as P } from "@l0w/proto";
import { ConfigError } from "./errors";
import type { ServiceEnv, ServiceOptions } from "./types";

export interface Config {
  name: string;
  address: string;
  /** Lowercase, may carry a port (development). */
  domain: string;
  /** `scheme://host[:port]`, no trailing slash. */
  hubBase: string;
  /** role -> member addresses (lowercase). Only roles the service may grant. */
  roles: Map<string, Set<string>>;
}

function parseRoles(text: string | undefined, domain: string, allowed: string[] | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (text === undefined || text.trim() === "") return out;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError("ROLES is not valid JSON");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError("ROLES must be a JSON object of role -> [members]");
  for (const [role, who] of Object.entries(raw as Record<string, unknown>)) {
    if (!P.validRole(role)) throw new ConfigError(`ROLES: ${JSON.stringify(role)} is not a role name`);
    if (!Array.isArray(who) || !who.every((w) => typeof w === "string")) throw new ConfigError(`ROLES.${role} must be a list of addresses`);
    if (allowed !== undefined && !allowed.includes(role)) continue; // a role this service does not grant is never honored
    out.set(role, new Set(who.map((w) => (w.includes("@") ? w : `${w}@${domain}`).toLowerCase())));
  }
  return out;
}

export function loadConfig(env: ServiceEnv, opts: ServiceOptions<never>): Config {
  const domain = (env.HUB_DOMAIN ?? "").trim().toLowerCase();
  if (!domain) throw new ConfigError("HUB_DOMAIN is not set");
  let base: URL;
  try {
    base = new URL((env.HUB_BASE ?? "").trim());
  } catch {
    throw new ConfigError("HUB_BASE is not a URL");
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new ConfigError("HUB_BASE must be http(s)");
  try {
    names.validateName(opts.name);
  } catch (e) {
    throw new ConfigError(`service name ${JSON.stringify(opts.name)}: ${(e as Error).message}`);
  }
  if (opts.roles && !opts.roles.every(P.validRole)) throw new ConfigError("roles must be short names");
  return {
    name: opts.name,
    address: `${opts.name}@${domain}`,
    domain,
    hubBase: `${base.protocol}//${base.host}`,
    roles: parseRoles(env.ROLES, domain, opts.roles),
  };
}

/** The role names `address` holds under the current `ROLES`, sorted. */
export function rolesOf(cfg: Config, address: string): string[] {
  const a = address.toLowerCase();
  return [...cfg.roles].filter(([, who]) => who.has(a)).map(([r]) => r).sort();
}
