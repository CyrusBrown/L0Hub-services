// The framework's D1 queries (the tables are in migrations/0001_core.sql).
import type { Doc } from "./types";

export const SEEN_KEEP = 9 * 24 * 3600; // messages.md: ids are kept at least 9 days
export const CALLS_KEEP = 30 * 24 * 3600;

export interface Member {
  address: string;
  ourTokenId: string;
  release: string;
  roles: string[];
  joinedAt: number;
}

export interface IssuedToken {
  id: string;
  holder: string;
  holderKid: string;
  revokedAt: number | null;
}

export interface OutboxRow {
  id: string;
  toAddr: string;
  kind: string;
  seq: number;
  host: string;
  envelope: string;
  createdAt: number;
  attempts: number;
  nextAt: number;
}

interface MemberRow {
  address: string;
  our_token_id: string;
  release: string;
  roles: string;
  joined_at: number;
}
interface OutboxDbRow {
  id: string;
  to_addr: string;
  kind: string;
  seq: number;
  host: string;
  envelope: string;
  created_at: number;
  attempts: number;
  next_at: number;
}

const member = (r: MemberRow): Member => ({
  address: r.address,
  ourTokenId: r.our_token_id,
  release: r.release,
  roles: JSON.parse(r.roles) as string[],
  joinedAt: r.joined_at,
});

const outboxRow = (r: OutboxDbRow): OutboxRow => ({
  id: r.id,
  toAddr: r.to_addr,
  kind: r.kind,
  seq: r.seq,
  host: r.host,
  envelope: r.envelope,
  createdAt: r.created_at,
  attempts: r.attempts,
  nextAt: r.next_at,
});

export class Store {
  constructor(readonly db: D1Database) {}

  // --- state ---------------------------------------------------------------------------------

  async getState(key: string): Promise<string | null> {
    return (await this.db.prepare("SELECT value FROM l0w_state WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
  }

  /** Set only if there is no value yet; returns the value that stands. */
  async pinState(key: string, value: string): Promise<string> {
    await this.db.prepare("INSERT OR IGNORE INTO l0w_state (key, value) VALUES (?, ?)").bind(key, value).run();
    return (await this.getState(key)) as string;
  }

  // --- members and tokens --------------------------------------------------------------------

  async getMember(address: string): Promise<Member | null> {
    const r = await this.db.prepare("SELECT * FROM l0w_members WHERE address = ?").bind(address).first<MemberRow>();
    return r ? member(r) : null;
  }

  async listMembers(): Promise<Member[]> {
    return (await this.db.prepare("SELECT * FROM l0w_members ORDER BY address").all<MemberRow>()).results.map(member);
  }

  /** Connect (or reconnect) a member: its token for us is kept, the token we issued is recorded, and a token we issued to
   * it before is revoked. One batch, so a crash never leaves a member without its tokens. */
  async connect(
    address: string,
    theirToken: Doc,
    theirTokenId: string,
    ours: { id: string; holderKid: string },
    release: string,
    roles: string[],
    now: number,
  ): Promise<void> {
    const old = await this.getMember(address);
    const q = (sql: string, ...a: unknown[]) => this.db.prepare(sql).bind(...a);
    const batch = [
      q("INSERT INTO l0w_tokens_issued (id, holder, holder_kid, issued_at) VALUES (?, ?, ?, ?)", ours.id, address, ours.holderKid, now),
      q(
        "INSERT INTO l0w_tokens_held (address, token_id, token, received_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(address) DO UPDATE SET token_id = excluded.token_id, token = excluded.token, received_at = excluded.received_at",
        address,
        theirTokenId,
        JSON.stringify(theirToken),
        now,
      ),
      q(
        "INSERT INTO l0w_members (address, our_token_id, release, roles, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT(address) DO UPDATE SET our_token_id = excluded.our_token_id, release = excluded.release, " +
          "roles = excluded.roles, updated_at = excluded.updated_at",
        address,
        ours.id,
        release,
        JSON.stringify(roles),
        now,
        now,
      ),
    ];
    if (old) batch.push(q("UPDATE l0w_tokens_issued SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL", now, old.ourTokenId));
    await this.db.batch(batch);
  }

  /** Forget a member: revoke the token we issued, drop theirs and anything still queued for it. */
  async disconnect(address: string, now: number): Promise<boolean> {
    const m = await this.getMember(address);
    if (!m) return false;
    const q = (sql: string, ...a: unknown[]) => this.db.prepare(sql).bind(...a);
    await this.db.batch([
      q("UPDATE l0w_tokens_issued SET revoked_at = ? WHERE holder = ? AND revoked_at IS NULL", now, address),
      q("DELETE FROM l0w_tokens_held WHERE address = ?", address),
      q("DELETE FROM l0w_members WHERE address = ?", address),
      q("DELETE FROM l0w_outbox WHERE to_addr = ?", address),
    ]);
    return true;
  }

  async setMemberRoles(address: string, roles: string[], now: number): Promise<void> {
    await this.db.prepare("UPDATE l0w_members SET roles = ?, updated_at = ? WHERE address = ?").bind(JSON.stringify(roles), now, address).run();
  }

  async issuedToken(id: string): Promise<IssuedToken | null> {
    const r = await this.db
      .prepare("SELECT id, holder, holder_kid, revoked_at FROM l0w_tokens_issued WHERE id = ?")
      .bind(id)
      .first<{ id: string; holder: string; holder_kid: string; revoked_at: number | null }>();
    return r ? { id: r.id, holder: r.holder, holderKid: r.holder_kid, revokedAt: r.revoked_at } : null;
  }

  async heldToken(address: string): Promise<Doc | null> {
    const r = await this.db.prepare("SELECT token FROM l0w_tokens_held WHERE address = ?").bind(address).first<{ token: string }>();
    return r ? (JSON.parse(r.token) as Doc) : null;
  }

  // --- seen ids ------------------------------------------------------------------------------

  /** Record an envelope id; false when it was already there (a duplicate). */
  async markSeen(from: string, id: string, now: number): Promise<boolean> {
    const r = await this.db.prepare("INSERT OR IGNORE INTO l0w_seen (from_addr, id, seen_at) VALUES (?, ?, ?)").bind(from, id, now).run();
    return r.meta.changes === 1;
  }

  async forgetSeen(from: string, id: string): Promise<void> {
    await this.db.prepare("DELETE FROM l0w_seen WHERE from_addr = ? AND id = ?").bind(from, id).run();
  }

  // --- the outbox ----------------------------------------------------------------------------

  async nextSeq(address: string): Promise<number> {
    const r = await this.db
      .prepare("INSERT INTO l0w_seq (address, seq) VALUES (?, 1) ON CONFLICT(address) DO UPDATE SET seq = seq + 1 RETURNING seq")
      .bind(address)
      .first<{ seq: number }>();
    return (r as { seq: number }).seq;
  }

  async enqueue(row: Omit<OutboxRow, "attempts" | "nextAt">, now: number): Promise<void> {
    await this.db
      .prepare("INSERT INTO l0w_outbox (id, to_addr, kind, seq, host, envelope, created_at, attempts, next_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)")
      .bind(row.id, row.toAddr, row.kind, row.seq, row.host, row.envelope, row.createdAt, now)
      .run();
  }

  async outboxRow(id: string): Promise<OutboxRow | null> {
    const r = await this.db.prepare("SELECT * FROM l0w_outbox WHERE id = ?").bind(id).first<OutboxDbRow>();
    return r ? outboxRow(r) : null;
  }

  async dueOutbox(now: number, limit = 50): Promise<OutboxRow[]> {
    const r = await this.db.prepare("SELECT * FROM l0w_outbox WHERE next_at <= ? ORDER BY next_at LIMIT ?").bind(now, limit).all<OutboxDbRow>();
    return r.results.map(outboxRow);
  }

  /** Take a row for one delivery attempt: pushes `next_at` out by `lease` seconds; false if another attempt has it. */
  async claim(row: OutboxRow, now: number, lease: number): Promise<boolean> {
    const r = await this.db
      .prepare("UPDATE l0w_outbox SET next_at = ?, attempts = attempts + 1 WHERE id = ? AND next_at = ?")
      .bind(now + lease, row.id, row.nextAt)
      .run();
    return r.meta.changes === 1;
  }

  async reschedule(id: string, nextAt: number, status: number | null): Promise<void> {
    await this.db.prepare("UPDATE l0w_outbox SET next_at = ?, last_status = ? WHERE id = ?").bind(nextAt, status, id).run();
  }

  async deleteOutbox(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM l0w_outbox WHERE id = ?").bind(id).run();
  }

  // --- the call log, upkeep ------------------------------------------------------------------

  async logCall(now: number, from: string, method: string, ok: boolean, code: string | null, ms: number): Promise<void> {
    await this.db.prepare("INSERT INTO l0w_calls (at, from_addr, method, ok, code, ms) VALUES (?, ?, ?, ?, ?, ?)").bind(now, from, method, ok ? 1 : 0, code, ms).run();
  }

  async purge(now: number): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM l0w_seen WHERE seen_at < ?").bind(now - SEEN_KEEP),
      this.db.prepare("DELETE FROM l0w_calls WHERE at < ?").bind(now - CALLS_KEEP),
    ]);
  }

  // --- the directory cache -------------------------------------------------------------------

  async getDirectory(address: string): Promise<{ seq: number; entry: Doc; fetchedAt: number } | null> {
    const r = await this.db.prepare("SELECT seq, entry, fetched_at FROM l0w_directory WHERE address = ?").bind(address).first<{ seq: number; entry: string; fetched_at: number }>();
    return r ? { seq: r.seq, entry: JSON.parse(r.entry) as Doc, fetchedAt: r.fetched_at } : null;
  }

  async putDirectory(address: string, seq: number, entry: Doc, now: number): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO l0w_directory (address, seq, entry, fetched_at) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(address) DO UPDATE SET seq = excluded.seq, entry = excluded.entry, fetched_at = excluded.fetched_at",
      )
      .bind(address, seq, JSON.stringify(entry), now)
      .run();
  }
}
