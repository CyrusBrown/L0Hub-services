// Small helpers: ids, times, argument checks, cursors, base64url sizes, mentions.
import { ServiceError, type Obj } from "@l0wservices/core";

export const DAY = 86400;
export const HOUR = 3600;
export const LOCK_AFTER = 3 * DAY;
export const WATCH_FOR = 7 * DAY;
export const ARCHIVE_AFTER = 90 * DAY;
export const MAX_FILE = 700 * 1024;
export const MAX_BODY = 64 * 1024;
export const MAX_MESSAGE = 4 * 1024;
export const MAX_PAGE = 200;
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const bad = (detail: string): ServiceError => new ServiceError("bad_args", detail);

export const iso = (t: number): string => new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
export const isoOrNull = (t: number | null | undefined): string | null => (t === null || t === undefined ? null : iso(t));

/** 16 characters of base64url from 12 random bytes. */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const bytes = (s: string): number => new TextEncoder().encode(s).length;
/** The first n characters (code points). */
export const firstChars = (s: string, n: number): string => Array.from(s).slice(0, n).join("");
export const charLen = (s: string): number => Array.from(s).length;

export function reqString(args: Obj, key: string, min: number, max: number): string {
  const v = args[key];
  if (typeof v !== "string") throw bad(`${key} is a string`);
  const n = charLen(v);
  if (n < min || n > max) throw bad(`${key} is ${min} to ${max} characters`);
  return v;
}

export function optString(args: Obj, key: string, max: number): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw bad(`${key} is a string`);
  if (charLen(v) > max) throw bad(`${key} is at most ${max} characters`);
  return v;
}

export function reqId(args: Obj, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !ID_RE.test(v)) throw bad(`${key} is an id`);
  return v;
}

export function reqSlug(args: Obj, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw bad(`${key} is a topic slug`);
  return checkSlug(v, key);
}

export function checkSlug(v: string, key = "slug"): string {
  if (v.length < 2 || v.length > 32 || !SLUG_RE.test(v)) throw bad(`${key} is 2 to 32 characters: lowercase letters and digits with single dashes`);
  return v;
}

export function optBool(args: Obj, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw bad(`${key} is true or false`);
  return v;
}

/** RFC 3339 -> whole seconds. */
export function timeArg(args: Obj, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) throw bad(`${key} is an RFC 3339 time`);
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw bad(`${key} is an RFC 3339 time`);
  return Math.floor(ms / 1000);
}

export function limitArg(args: Obj): number {
  const v = args.limit;
  if (v === undefined || v === null) return 50;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw bad("limit is a positive integer");
  return Math.min(v, MAX_PAGE);
}

// --- cursors: base64url JSON of the last row's sort key (all keys sort descending, or the one key ascending) -------

export function encodeCursor(values: number[]): string {
  return btoa(JSON.stringify(values)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeCursor(args: Obj, width: number): number[] | undefined {
  const v = args.cursor;
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw bad("cursor is the next of an earlier answer");
  try {
    const s = v.replace(/-/g, "+").replace(/_/g, "/");
    const arr = JSON.parse(atob(s + "=".repeat((4 - (s.length % 4)) % 4)));
    if (Array.isArray(arr) && arr.length === width && arr.every((x) => typeof x === "number" && Number.isFinite(x))) return arr;
  } catch {
    // fall through
  }
  throw bad("cursor is the next of an earlier answer");
}

/** `(a < ?) OR (a = ? AND b < ?) ...` for columns that all sort descending (`dir` ">" for ascending). */
export function keyset(cols: string[], values: number[], dir: "<" | ">"): { sql: string; args: number[] } {
  const parts: string[] = [];
  const args: number[] = [];
  for (let i = 0; i < cols.length; i++) {
    const eq = cols.slice(0, i).map((c) => `${c} = ?`);
    parts.push(`(${[...eq, `${cols[i]} ${dir} ?`].join(" AND ")})`);
    args.push(...values.slice(0, i), values[i]);
  }
  return { sql: `(${parts.join(" OR ")})`, args };
}

// --- files -----------------------------------------------------------------------------------------------------------

/** The decoded size of unpadded base64url `data`, or a bad_args error. */
export function b64uSize(data: unknown): number {
  if (typeof data !== "string" || !/^[A-Za-z0-9_-]*$/.test(data)) throw bad("data is base64url without padding");
  if (data.length % 4 === 1) throw bad("data is not valid base64url");
  return Math.floor((data.length * 3) / 4);
}

export const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

// --- mentions --------------------------------------------------------------------------------------------------------

const MENTION_RE = /(?<![A-Za-z0-9_@.\-/])@([a-z0-9]+(?:-[a-z0-9]+)*)(?:@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?))?/gi;

/** `@name` -> name@domain (a member of this hub); `@name@other.example` as written. Lowercase, distinct, at most 10. */
export function parseMentions(body: string, hubDomain: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const addr = `${m[1]}@${m[2] ?? hubDomain}`.toLowerCase();
    if (!out.includes(addr)) out.push(addr);
    if (out.length >= 10) break;
  }
  return out;
}
