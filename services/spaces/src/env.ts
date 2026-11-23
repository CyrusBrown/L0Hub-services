import type { ServiceEnv } from "@l0wservices/core";

export interface SpacesEnv extends ServiceEnv {
  /** R2 bucket for the encrypted blobs, keyed `<space>/<blob id>`. */
  BLOBS: R2Bucket;
  /** One Durable Object per space (class `Space`): everything that must be atomic goes through it. */
  SPACE: DurableObjectNamespace;
  /** Secret: signs transfer tickets (HMAC-SHA256). Any long random string. */
  TICKET_KEY: string;
  /** The hostname transfer URLs use. Default `spaces.<HUB_DOMAIN>`. */
  SERVICE_HOST?: string;
  /** Limits (numbers as strings, as wrangler vars are). */
  QUOTA_BYTES?: string;
  MAX_FILE_BYTES?: string;
  MAX_SPACES_PER_CREATOR?: string;
  MAX_MEMBERS_PER_SPACE?: string;
}

export interface Limits {
  quota: number;
  maxFile: number;
  spaces: number;
  members: number;
}

const num = (v: string | undefined, dflt: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isInteger(n) && n > 0 ? n : dflt;
};

export const DEFAULT_QUOTA = 1024 * 1024 * 1024;
export const DEFAULT_MAX_FILE = 95 * 1024 * 1024;
export const MAX_BLOBS_MISSING = 500;
/** The stored form of a blob is `0x01` + ciphertext + 16-byte tag: this much longer than the contents. */
export const BLOB_OVERHEAD = 17;
export const TICKET_TTL = 15 * 60;
export const DELETE_GRACE = 7 * 24 * 3600;
export const BLOB_KEEP = 90 * 24 * 3600; // a blob no version of this long uses may be dropped
export const ORPHAN_KEEP = 7 * 24 * 3600; // an upload that no pushed version ever used
export const LOCK_DEFAULT_HOURS = 24;
export const LOCK_MAX_HOURS = 72;
export const MAX_LOCKS = 200;

export function limits(env: Partial<SpacesEnv>): Limits {
  return {
    quota: num(env.QUOTA_BYTES, DEFAULT_QUOTA),
    maxFile: num(env.MAX_FILE_BYTES, DEFAULT_MAX_FILE),
    spaces: num(env.MAX_SPACES_PER_CREATOR, 10),
    members: num(env.MAX_MEMBERS_PER_SPACE, 20),
  };
}
