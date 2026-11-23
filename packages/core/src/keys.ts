// The service's keys: derived from SERVICE_SEED, so a redeploy keeps them and there is nothing else to back up.
import { b64, keys } from "@l0w/proto";
import { ConfigError } from "./errors";

/** The `created` time in the keys' JSON. Fixed: it is part of the published self document, and the kids do not depend on it. */
export const KEY_CREATED = "2026-11-22T00:00:00Z";
export const USES = ["sign", "seal", "recover"] as const;

export interface ServiceKeys {
  sign: keys.KeyPair;
  seal: keys.KeyPair;
  recover: keys.KeyPair;
}

/** `HKDF-SHA256(seed, salt = "", info = "l0wservices/1 <use>")`, 32 bytes. */
async function derive(seed: Uint8Array, use: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: b64.utf8(`l0wservices/1 ${use}`) },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function keysFromSeed(seedText: string | undefined): Promise<ServiceKeys> {
  let seed: Uint8Array;
  try {
    seed = b64.decode((seedText ?? "").trim());
  } catch {
    throw new ConfigError("SERVICE_SEED must be the base64url of 32 bytes");
  }
  if (seed.length !== 32) throw new ConfigError("SERVICE_SEED must be the base64url of 32 bytes");
  const out = {} as ServiceKeys;
  for (const use of USES) out[use] = await keys.fromSeed(await derive(seed, use), use, KEY_CREATED);
  return out;
}

const cache = new Map<string, Promise<ServiceKeys>>();

/** Memoized per seed (an isolate serves one service; the map is tiny). */
export function serviceKeys(seedText: string | undefined): Promise<ServiceKeys> {
  const k = (seedText ?? "").trim();
  let p = cache.get(k);
  if (!p) {
    p = keysFromSeed(k);
    cache.set(k, p);
    p.catch(() => cache.delete(k));
  }
  return p;
}
