// Every envelope this service sends (welcome, reply, event) is made once (sealed to the member's current seal key, signed,
// carrying the member's token, with the next seq for that member), kept in D1 and resent as the same bytes until the
// member's instance answers 2xx, answers a 4xx (other than 408/429), or the envelope is 7 days old (messages.md "The outbox").
import { errors, messages } from "@l0w/proto";
import type { Config } from "./config";
import type { Hub } from "./hub";
import type { ServiceKeys } from "./keys";
import type { OutboxRow, Store } from "./store";
import type { Obj, ServiceEnv } from "./types";

export const RETRY_MIN = 30; // seconds
export const RETRY_MAX = 3600;
export const OUTBOX_KEEP = 7 * 24 * 3600;
const LEASE = 120; // seconds a claimed row stays out of other attempts
const TIMEOUT_MS = 15_000;

/** 30 s, 60 s, 2 min ... capped at 1 h, after `attempts` attempts. */
export const backoff = (attempts: number): number => Math.min(RETRY_MAX, RETRY_MIN * 2 ** Math.max(0, attempts - 1));

export class Outbox {
  constructor(
    private env: ServiceEnv,
    private cfg: Config,
    private store: Store,
    private hub: Hub,
    private keys: ServiceKeys,
    private now: () => number,
  ) {}

  /** Make the envelope and queue it. Returns its id, or null when `to` is not connected to this service. Throws
   * HubUnavailable when the member's directory entry can't be had, and a protocol error when the body is not valid
   * for the kind (for a reply: over 1 MiB). */
  async enqueue(kind: string, to: string, body: Obj): Promise<string | null> {
    to = to.toLowerCase();
    const token = await this.store.heldToken(to);
    if (!token) return null;
    const entry = await this.hub.entry(to);
    if (!entry) return null;
    const seq = await this.store.nextSeq(to);
    const env = await messages.makeEnvelope(this.keys.sign, this.keys.sign.kid, this.cfg.address, to, entry.sealKey, kind, body, seq, token);
    const id = messages.envelopePayload(env).id as string;
    const t = this.now();
    await this.store.enqueue({ id, toAddr: to, kind, seq, host: entry.instanceHost, envelope: JSON.stringify(env), createdAt: t }, t);
    return id;
  }

  /** One POST of the stored bytes. Through the hub binding when there is one (the hub's Worker routes by Host); otherwise to
   * the hostname itself, or, for an http development hub, to HUB_BASE with the Host header set (as the fake hub expects). */
  private async post(row: OutboxRow): Promise<number> {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: row.envelope,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };
    const path = "/api/peer/v0/inbox";
    let res: Response;
    if (this.env.HUB) res = await this.env.HUB.fetch(`https://${row.host}${path}`, init);
    else if (this.cfg.hubBase.startsWith("http://")) {
      res = await fetch(this.cfg.hubBase + path, { ...init, headers: { ...(init.headers as Record<string, string>), host: row.host } });
    } else res = await fetch(`https://${row.host}${path}`, init);
    await res.body?.cancel();
    return res.status;
  }

  /** Attempt one claimed row and settle it. Returns what happened. */
  async attempt(row: OutboxRow): Promise<"sent" | "dropped" | "retry" | "busy"> {
    const t = this.now();
    if (!(await this.store.claim(row, t, LEASE))) return "busy";
    const attempts = row.attempts + 1;
    let status: number | null = null;
    try {
      status = await this.post(row);
    } catch {
      status = null; // the instance is offline, or the hub could not reach it
    }
    if (status !== null && status >= 200 && status < 300) {
      await this.store.deleteOutbox(row.id);
      return "sent";
    }
    const final = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
    if (final || t - row.createdAt >= OUTBOX_KEEP) {
      await this.store.deleteOutbox(row.id);
      if (!final) console.warn(`outbox: gave up on ${row.kind} to ${row.toAddr} after ${attempts} attempts`);
      else console.warn(`outbox: ${row.kind} to ${row.toAddr} refused with ${status}`);
      return "dropped";
    }
    await this.store.reschedule(row.id, t + backoff(attempts), status);
    return "retry";
  }

  /** The rows that are due (the cron handler's loop). */
  async flush(limit = 50): Promise<{ sent: number; dropped: number; retry: number }> {
    const out = { sent: 0, dropped: 0, retry: 0 };
    for (const row of await this.store.dueOutbox(this.now(), limit)) {
      const r = await this.attempt(row);
      if (r !== "busy") out[r]++;
    }
    return out;
  }

  /** Try a just-queued envelope at once (after the inbox has answered). */
  async deliverNow(id: string): Promise<void> {
    const row = await this.store.outboxRow(id);
    if (row) await this.attempt(row);
  }
}

export const isProtocolError = (e: unknown): e is errors.ProtocolError => e instanceof errors.ProtocolError;
