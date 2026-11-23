// Talking to the hub: its signing key (pinned the first time, then followed through signed rotations) and the directory.
import { b64, docs, errors, keys, payloads as P } from "@l0w/proto";
import type { Config } from "./config";
import { HubUnavailable } from "./errors";
import type { Store } from "./store";
import type { Doc, ServiceEnv } from "./types";

export const DIRECTORY_TTL = 300; // seconds a directory entry is used without asking again (identity.md)
const TIMEOUT_MS = 10_000;
const PIN = "hub_key";

/** A member's (or service's) verified directory entry. */
export interface Entry {
  address: string;
  seq: number;
  signKey: keys.Key;
  sealKey: keys.Key;
  /** The instance hostname the hub assigned: envelopes are delivered to `https://<instance>/api/peer/v0/inbox`. */
  instanceHost: string;
  /** The signed rotation documents in the self-description. */
  history: Doc[];
}

const sealOrSign = (list: unknown[], use: string): Promise<keys.Key> => {
  const k = list.find((x) => (x as { use?: string }).use === use);
  return keys.Key.fromJSON(k);
};

export class Hub {
  constructor(
    private env: ServiceEnv,
    private cfg: Config,
    private store: Store,
    private now: () => number,
  ) {}

  /** A request to the hub's own host (capabilities, directory). Through the service binding when there is one. */
  async get(path: string): Promise<Response> {
    const url = this.cfg.hubBase + path;
    const init: RequestInit = { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) };
    try {
      return await (this.env.HUB ? this.env.HUB.fetch(url, init) : fetch(url, init));
    } catch (e) {
      throw new HubUnavailable(`the hub did not answer: ${(e as Error).message}`);
    }
  }

  private async json(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      throw new HubUnavailable("the hub sent something that is not JSON");
    }
  }

  // --- the hub's key ---------------------------------------------------------------------------

  private async capabilities(): Promise<{ key: keys.Key; payload: docs.Obj }> {
    const res = await this.get("/.well-known/l0wagent/hub");
    if (res.status !== 200) throw new HubUnavailable(`the hub's capabilities answered ${res.status}`);
    let payload: docs.Obj;
    try {
      payload = await P.verifyHub(await this.json(res), undefined, this.now());
    } catch (e) {
      if (e instanceof errors.ProtocolError) throw new HubUnavailable(`the hub's capabilities do not verify: ${e.detail}`);
      throw e;
    }
    if (String(payload.domain).toLowerCase() !== this.cfg.domain) throw new HubUnavailable("the hub's domain is not HUB_DOMAIN");
    const key = await sealOrSign(payload.keys, "sign");
    return { key, payload };
  }

  /** The hub's signing key: the one pinned the first time this service asks, so nothing later can swap it silently. */
  async hubKey(): Promise<keys.Key> {
    const pinned = await this.store.getState(PIN);
    if (pinned) return keys.Key.fromJSON(JSON.parse(pinned));
    const { key } = await this.capabilities();
    return keys.Key.fromJSON(JSON.parse(await this.store.pinState(PIN, JSON.stringify(key.toJSON()))));
  }

  /** The pinned key did not verify something the hub served: look at the capabilities, and move the pin only along
   * rotation documents signed by the pinned key (capabilities.md `history`). Anything else is an alarm: unavailable. */
  private async refreshHubKey(old: keys.Key): Promise<keys.Key> {
    const { key, payload } = await this.capabilities();
    if (key.kid === old.kid) return old;
    let cur = old;
    const history: Doc[] = Array.isArray(payload.history) ? payload.history : [];
    for (let i = 0; i <= history.length && cur.kid !== key.kid; i++) {
      const next = history.find((d) => {
        try {
          return JSON.parse(b64.fromUtf8(b64.decode(d.payload))).old === cur.kid;
        } catch {
          return false;
        }
      });
      if (!next) break;
      try {
        const rot = await P.verifyRotation(next, cur, null, this.now());
        cur = await keys.Key.fromJSON(rot.new);
      } catch {
        break;
      }
    }
    if (cur.kid !== key.kid) throw new HubUnavailable("the hub's key changed and no rotation signed by the pinned key explains it");
    await this.store.db.prepare("UPDATE l0w_state SET value = ? WHERE key = ?").bind(JSON.stringify(key.toJSON()), PIN).run();
    return key;
  }

  // --- the directory ---------------------------------------------------------------------------

  private async parse(entry: Doc, name: string, hubKey: keys.Key): Promise<docs.Obj> {
    return P.verifyDirectoryEntry(entry, hubKey, { hubDomain: this.cfg.domain, name, now: this.now() });
  }

  /** The verified directory entry of `address`; null when it is not a (current) member of this hub: another domain,
   * unknown (404), left (410) or moved (301). Cached for five minutes. Throws HubUnavailable when the hub can't say. */
  async entry(address: string, opts: { refresh?: boolean } = {}): Promise<Entry | null> {
    let name: string;
    let domain: string;
    try {
      [name, domain] = P.splitAddress(address);
    } catch {
      return null;
    }
    if (domain !== this.cfg.domain) return null;
    address = `${name}@${domain}`;
    const cached = await this.store.getDirectory(address);
    if (cached && !opts.refresh && this.now() - cached.fetchedAt < DIRECTORY_TTL) return this.toEntry(address, await this.parse(cached.entry, name, await this.hubKey()), cached.entry);

    const res = await this.get(`/.well-known/l0wagent/members/${encodeURIComponent(name)}`);
    if (res.status === 404 || res.status === 410 || res.status === 301) return null;
    if (res.status !== 200) throw new HubUnavailable(`the directory answered ${res.status}`);
    const doc = (await this.json(res)) as Doc;
    let hubKey = await this.hubKey();
    let payload: docs.Obj;
    try {
      payload = await this.parse(doc, name, hubKey);
    } catch (e) {
      if (!(e instanceof errors.SignatureError)) throw this.bad(e);
      hubKey = await this.refreshHubKey(hubKey);
      try {
        payload = await this.parse(doc, name, hubKey);
      } catch (e2) {
        throw this.bad(e2);
      }
    }
    if (cached && payload.seq < cached.seq) throw new HubUnavailable("the directory entry went back to an older seq");
    await this.store.putDirectory(address, payload.seq, doc, this.now());
    return this.toEntry(address, payload, doc);
  }

  private bad(e: unknown): Error {
    return e instanceof errors.ProtocolError ? new HubUnavailable(`the hub served a bad directory entry: ${e.detail}`) : (e as Error);
  }

  private async toEntry(address: string, p: docs.Obj, _doc: Doc): Promise<Entry> {
    return {
      address,
      seq: p.seq,
      signKey: await sealOrSign(p.keys, "sign"),
      sealKey: await sealOrSign(p.keys, "seal"),
      instanceHost: p.hostnames.instance,
      history: p.history ?? [],
    };
  }
}

/** True when `to` is reached from `from` by following the rotations in `history` (each names the key it replaces and the new
 * key). The self-description they sit in is signed by the member and countersigned by the hub, which only does so for
 * chains it has checked, so the walk reads the payloads and does not re-verify each rotation's signature. */
export function rotatedFrom(history: Doc[], from: string, to: string): boolean {
  if (from === to) return true;
  const next = new Map<string, string>();
  for (const d of history) {
    try {
      const p = JSON.parse(b64.fromUtf8(b64.decode(d.payload)));
      if (typeof p.old === "string" && typeof p.new?.kid === "string") next.set(p.old, p.new.kid);
    } catch {
      /* a malformed entry never matches */
    }
  }
  let cur = from;
  for (let i = 0; i <= history.length; i++) {
    const n = next.get(cur);
    if (n === undefined) return false;
    if (n === to) return true;
    cur = n;
  }
  return false;
}
