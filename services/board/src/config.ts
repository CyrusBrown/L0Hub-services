// The operator's settings (Worker vars) and who holds which role (ROLES, the same variable the framework reads).
import type { ServiceEnv } from "@l0wservices/core";

export interface BoardEnv extends ServiceEnv {
  /** Secret. When unset, the operator's admin API (`/v0/admin/*`) answers 404. */
  ADMIN_TOKEN?: string;
  /** Posts (proposals included) per member per rolling 24 hours. Default 5. */
  POSTS_PER_DAY?: string | number;
  /** Discussion messages per member per 24 hours. Default 10. */
  MESSAGES_PER_DAY?: string | number;
  /** File uploads per member per 24 hours. Default 20. */
  FILES_PER_DAY?: string | number;
  /** A member's first N posts are held for a moderator. Default 2. */
  HELD_FIRST_POSTS?: string | number;
  /** Watches per member. Default 5. */
  MAX_WATCHES?: string | number;
  /** Cap on topics that aren't archived (board-requests not counted); 0 or unset: no cap. */
  MAX_TOPICS?: string | number;
}

export interface Limits {
  postsPerDay: number;
  messagesPerDay: number;
  filesPerDay: number;
  heldFirstPosts: number;
  maxWatches: number;
  maxTopics: number;
}

function num(v: string | number | undefined, dflt: number): number {
  if (v === undefined || v === null || String(v).trim() === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

export function limitsOf(env: BoardEnv): Limits {
  return {
    postsPerDay: num(env.POSTS_PER_DAY, 5),
    messagesPerDay: num(env.MESSAGES_PER_DAY, 10),
    filesPerDay: num(env.FILES_PER_DAY, 20),
    heldFirstPosts: num(env.HELD_FIRST_POSTS, 2),
    maxWatches: num(env.MAX_WATCHES, 5),
    maxTopics: num(env.MAX_TOPICS, 0),
  };
}

/** role -> lowercase addresses, as the framework reads ROLES (a bare name is a member of this hub). */
function rolesTable(env: BoardEnv): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let raw: unknown;
  try {
    raw = JSON.parse(env.ROLES ?? "{}");
  } catch {
    return out;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const domain = env.HUB_DOMAIN.trim().toLowerCase();
  for (const [role, who] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(who)) continue;
    out.set(role, new Set(who.filter((w): w is string => typeof w === "string").map((w) => (w.includes("@") ? w : `${w}@${domain}`).toLowerCase())));
  }
  return out;
}

/** The roles `address` holds under the current ROLES (sorted). */
export function rolesOf(env: BoardEnv, address: string): string[] {
  const a = address.toLowerCase();
  return [...rolesTable(env)].filter(([, who]) => who.has(a)).map(([r]) => r).sort();
}

export const isModerator = (env: BoardEnv, address: string): boolean => rolesTable(env).get("moderator")?.has(address.toLowerCase()) ?? false;

export function moderators(env: BoardEnv): string[] {
  return [...(rolesTable(env).get("moderator") ?? [])];
}
