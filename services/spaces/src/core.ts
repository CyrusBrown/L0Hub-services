// The state changes that must be atomic, as a plain class over D1 and R2. The Durable Object (`Space`) runs one command at
// a time per space, so a check and the write that depends on it never interleave with another caller's. Nothing here sees
// a space key or a plaintext: it works on signed documents the Worker has already verified.
import { ServiceError, type Obj } from "@l0wservices/core";
import { BLOB_KEEP, DELETE_GRACE, LOCK_DEFAULT_HOURS, LOCK_MAX_HOURS, MAX_LOCKS, ORPHAN_KEEP, type Limits } from "./env";
import { lockView, SpacesDb, type LockRow, type MemberRow, type SpaceRow } from "./store";

export interface Ev {
  to: string;
  event: string;
  data: Obj;
}
export interface Outcome {
  result: Obj;
  events: Ev[];
}

/** A key document the Worker verified, with the fields the state checks need. */
export interface KeyIn {
  doc: unknown;
  member: string;
  epoch: number;
  memberKid: string;
}

export interface CoreEnv {
  DB: D1Database;
  BLOBS: R2Bucket;
}

const err = (code: string, detail: string, extra: Record<string, unknown> = {}) => new ServiceError(code, detail, extra);
const none = (result: Obj = {}): Outcome => ({ result, events: [] });
const GC_BATCH = 200;

export class SpaceCore {
  readonly q: SpacesDb;
  private db: D1Database;
  private blobs: R2Bucket;

  constructor(env: CoreEnv, readonly lim: Limits) {
    this.db = env.DB;
    this.blobs = env.BLOBS;
    this.q = new SpacesDb(env.DB, lim);
  }

  async run(cmd: string, a: Obj): Promise<Outcome> {
    const fn = (this as unknown as Record<string, unknown>)[`cmd_${cmd}`];
    if (typeof fn !== "function") throw err("internal", `no command ${cmd}`);
    return (fn as (a: Obj) => Promise<Outcome>).call(this, a);
  }

  // --- helpers ---------------------------------------------------------------------------------

  private async live(id: string): Promise<SpaceRow> {
    const sp = await this.q.space(id);
    if (!sp) throw err("not_found", "no such space");
    return sp;
  }

  /** The caller as a full member of the space (an invitee is `not_member`, a stranger gets `not_found`). */
  private async asMember(id: string, who: string): Promise<{ sp: SpaceRow; me: MemberRow }> {
    const sp = await this.live(id);
    const me = await this.q.member(id, who);
    if (!me) throw err("not_found", "no such space");
    if (me.state !== "member") throw err("not_member", "accept the invitation first");
    return { sp, me };
  }

  private creatorOnly(sp: SpaceRow, who: string): void {
    if (sp.creator !== who) throw err("not_allowed", "only the space's creator may do this");
  }

  private put(sql: string, ...a: unknown[]) {
    return this.db.prepare(sql).bind(...a);
  }

  private keyStmt(space: string, k: KeyIn, now: number) {
    return this.put(
      "INSERT INTO space_keys (space, epoch, member, member_kid, doc, created_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(space, epoch, member) DO UPDATE SET member_kid = excluded.member_kid, doc = excluded.doc, created_at = excluded.created_at",
      space,
      k.epoch,
      k.member,
      k.memberKid,
      JSON.stringify(k.doc),
      now,
    );
  }

  private async membersEvent(sp: SpaceRow, to: string[]): Promise<Ev[]> {
    const members = (await this.q.view(sp)).members;
    return to.map((t) => ({ to: t, event: "members", data: { space: sp.id, members } }));
  }

  // --- spaces ----------------------------------------------------------------------------------

  async cmd_create(a: { id: string; name: string; creator: string; key: KeyIn; now: number }): Promise<Outcome> {
    if (await this.q.anySpace(a.id)) throw err("exists", "that space id is taken");
    if (await this.db.prepare("SELECT 1 AS x FROM spaces WHERE creator = ? AND name = ? AND deleted_at IS NULL").bind(a.creator, a.name).first()) {
      throw err("exists", "you already have a space with that name");
    }
    const n = await this.db.prepare("SELECT count(*) AS n FROM spaces WHERE creator = ? AND deleted_at IS NULL").bind(a.creator).first<{ n: number }>();
    if ((n?.n ?? 0) >= this.lim.spaces) throw err("limit_reached", `at most ${this.lim.spaces} spaces per creator`);
    const here = "EXISTS (SELECT 1 FROM spaces WHERE id = ?)";
    try {
      await this.db.batch([
        // the count is checked again inside the insert, so two spaces made at once can't both slip under the limit
        this.put(
          "INSERT INTO spaces (id, name, creator, epoch, seq, head, created_at) SELECT ?, ?, ?, 1, 0, NULL, ? " +
            "WHERE (SELECT count(*) FROM spaces WHERE creator = ? AND deleted_at IS NULL) < ?",
          a.id,
          a.name,
          a.creator,
          a.now,
          a.creator,
          this.lim.spaces,
        ),
        this.put(`INSERT INTO space_members (space, address, state, since, since_epoch) SELECT ?, ?, 'member', ?, 1 WHERE ${here}`, a.id, a.creator, a.now, a.id),
        this.put(
          `INSERT INTO space_keys (space, epoch, member, member_kid, doc, created_at) SELECT ?, 1, ?, ?, ?, ? WHERE ${here}`,
          a.id,
          a.creator,
          a.key.memberKid,
          JSON.stringify(a.key.doc),
          a.now,
          a.id,
        ),
      ]);
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error).message))) throw err("exists", "you already have a space with that name");
      throw e;
    }
    const sp = await this.q.space(a.id);
    if (!sp) throw err("limit_reached", `at most ${this.lim.spaces} spaces per creator`);
    return none({ space: await this.q.view(sp) });
  }

  async cmd_invite(a: { space: string; by: string; member: string; keys: KeyIn[]; now: number }): Promise<Outcome> {
    const sp = await this.live(a.space);
    this.creatorOnly(sp, a.by);
    // a key for every epoch 1..current, one each: the head's files may use blobs of older epochs
    const seen = new Set<number>();
    for (const k of a.keys) {
      if (k.member !== a.member) throw err("bad_args", "a key is for another member");
      if (k.epoch < 1 || k.epoch > sp.epoch) throw err("bad_epoch", `the space is at epoch ${sp.epoch}`, { epoch: sp.epoch });
      if (seen.has(k.epoch)) throw err("bad_args", `two keys for epoch ${k.epoch}`);
      seen.add(k.epoch);
    }
    const lacking = Array.from({ length: sp.epoch }, (_, i) => i + 1).filter((e) => !seen.has(e));
    if (lacking.length) throw err("missing_keys", "a key for every epoch is needed", { epochs: lacking });
    const had = await this.q.member(sp.id, a.member);
    if (had?.state === "member") throw err("exists", "already a member");
    if (!had && (await this.q.members(sp.id)).length >= this.lim.members) throw err("limit_reached", `at most ${this.lim.members} members per space`);
    await this.db.batch([
      this.put(
        "INSERT INTO space_members (space, address, state, since, since_epoch) VALUES (?, ?, 'invited', ?, ?) " +
          "ON CONFLICT(space, address) DO UPDATE SET since = excluded.since, since_epoch = excluded.since_epoch",
        sp.id,
        a.member,
        a.now,
        1,
      ),
      ...a.keys.map((k) => this.keyStmt(sp.id, k, a.now)),
    ]);
    return { result: { space: await this.q.view(sp) }, events: [{ to: a.member, event: "invited", data: { space: sp.id, name: sp.name, creator: sp.creator } }] };
  }

  async cmd_accept(a: { space: string; by: string; now: number }): Promise<Outcome> {
    const sp = await this.live(a.space);
    const me = await this.q.member(sp.id, a.by);
    if (!me) throw err("not_found", "no such invitation");
    if (me.state === "member") return none({ space: await this.q.view(sp) });
    await this.put("UPDATE space_members SET state = 'member', since = ? WHERE space = ? AND address = ?", a.now, sp.id, a.by).run();
    return { result: { space: await this.q.view(sp) }, events: await this.membersEvent(sp, await this.q.memberAddresses(sp.id, [a.by])) };
  }

  async cmd_decline(a: { space: string; by: string }): Promise<Outcome> {
    const sp = await this.live(a.space);
    const me = await this.q.member(sp.id, a.by);
    if (!me || me.state !== "invited") throw err("not_found", "no such invitation");
    await this.db.batch([
      this.put("DELETE FROM space_members WHERE space = ? AND address = ?", sp.id, a.by),
      this.put("DELETE FROM space_keys WHERE space = ? AND member = ?", sp.id, a.by),
    ]);
    return { result: {}, events: await this.membersEvent(sp, await this.q.memberAddresses(sp.id)) };
  }

  async cmd_leave(a: { space: string; by: string }): Promise<Outcome> {
    const { sp } = await this.asMember(a.space, a.by);
    if (sp.creator === a.by) throw err("not_allowed", "the creator can't leave: delete the space instead");
    await this.db.batch([
      this.put("DELETE FROM space_members WHERE space = ? AND address = ?", sp.id, a.by),
      this.put("DELETE FROM space_keys WHERE space = ? AND member = ?", sp.id, a.by),
      this.put("DELETE FROM locks WHERE space = ? AND holder = ?", sp.id, a.by),
    ]);
    return { result: {}, events: await this.membersEvent(sp, await this.q.memberAddresses(sp.id)) };
  }

  async cmd_remove(a: { space: string; by: string; member: string; keys: KeyIn[]; now: number }): Promise<Outcome> {
    const sp = await this.live(a.space);
    this.creatorOnly(sp, a.by);
    const target = await this.q.member(sp.id, a.member);
    if (!target) throw err("not_found", "no such member");
    if (a.member === sp.creator) throw err("bad_args", "the creator can't be removed: delete the space instead");
    const all = await this.q.members(sp.id);
    if (target.state === "invited") {
      // an invitee never received the key (keys.get waits for accept), so withdrawing the invitation starts no epoch
      await this.db.batch([
        this.put("DELETE FROM space_members WHERE space = ? AND address = ?", sp.id, a.member),
        this.put("DELETE FROM space_keys WHERE space = ? AND member = ?", sp.id, a.member),
      ]);
      const events: Ev[] = [{ to: a.member, event: "removed", data: { space: sp.id } }, ...(await this.membersEvent(sp, await this.q.memberAddresses(sp.id, [a.by])))];
      return { result: { space: await this.q.view(sp) }, events };
    }
    const next = sp.epoch + 1;
    const remaining = all.filter((m) => m.address !== a.member).map((m) => m.address);
    const given = new Map<string, KeyIn>();
    for (const k of a.keys) {
      if (k.epoch !== next) throw err("bad_epoch", `the keys must be for epoch ${next}`, { epoch: next });
      if (!remaining.includes(k.member)) throw err("bad_args", `a key for ${k.member}, who is not remaining`);
      if (given.has(k.member)) throw err("bad_args", `two keys for ${k.member}`);
      given.set(k.member, k);
    }
    const missing = remaining.filter((m) => !given.has(m));
    if (missing.length) throw err("missing_keys", "a key for every remaining member is needed", { members: missing });
    const stmts = [
      this.put("DELETE FROM space_members WHERE space = ? AND address = ?", sp.id, a.member),
      this.put("DELETE FROM space_keys WHERE space = ? AND member = ?", sp.id, a.member),
      this.put("DELETE FROM locks WHERE space = ?", sp.id),
      this.put("UPDATE spaces SET epoch = ? WHERE id = ? AND epoch = ?", next, sp.id, sp.epoch),
      ...[...given.values()].map((k) => this.keyStmt(sp.id, k, a.now)),
    ];
    await this.db.batch(stmts);
    const sp2 = { ...sp, epoch: next };
    const rest = await this.q.memberAddresses(sp.id, [a.by]);
    const events: Ev[] = [
      { to: a.member, event: "removed", data: { space: sp.id } },
      ...(await this.membersEvent(sp2, rest)),
      ...rest.map((to) => ({ to, event: "epoch", data: { space: sp.id, epoch: next } })),
    ];
    return { result: { space: await this.q.view(sp2) }, events };
  }

  async cmd_keysPut(a: { space: string; by: string; keys: KeyIn[]; now: number }): Promise<Outcome> {
    const sp = await this.live(a.space);
    this.creatorOnly(sp, a.by);
    const stmts = [];
    for (const k of a.keys) {
      const m = await this.q.member(sp.id, k.member);
      if (!m) throw err("not_member", `${k.member} is not in the space`);
      if (k.epoch > sp.epoch || k.epoch < m.since_epoch) throw err("bad_epoch", `${k.member} has keys for epochs ${m.since_epoch} to ${sp.epoch}`, { epoch: sp.epoch });
      stmts.push(this.keyStmt(sp.id, k, a.now));
    }
    if (stmts.length) await this.db.batch(stmts);
    return none();
  }

  async cmd_delete(a: { space: string; by: string; now: number }): Promise<Outcome> {
    const sp = await this.live(a.space);
    this.creatorOnly(sp, a.by);
    await this.put("UPDATE spaces SET deleted_at = ? WHERE id = ?", a.now, sp.id).run();
    const to = (await this.q.members(sp.id)).map((m) => m.address).filter((x) => x !== a.by);
    return { result: {}, events: to.map((t) => ({ to: t, event: "deleted", data: { space: sp.id } })) };
  }

  /** Drop a space deleted a week ago: its blobs, then its rows. */
  async cmd_drop(a: { space: string; now: number }): Promise<Outcome> {
    const sp = await this.q.anySpace(a.space);
    if (!sp || sp.deleted_at === null || sp.deleted_at > a.now - DELETE_GRACE) return none();
    let cursor: string | undefined;
    do {
      const page = await this.blobs.list({ prefix: `${sp.id}/`, cursor });
      if (page.objects.length) await this.blobs.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    const tables = ["space_members", "space_keys", "versions", "version_blobs", "blobs", "locks"];
    await this.db.batch([...tables.map((t) => this.put(`DELETE FROM ${t} WHERE space = ?`, sp.id)), this.put("DELETE FROM spaces WHERE id = ?", sp.id)]);
    return none();
  }

  // --- versions --------------------------------------------------------------------------------

  async cmd_push(a: { space: string; by: string; doc: unknown; id: string; seq: number; parent: string | null; epoch: number; blobs: string[]; now: number }): Promise<Outcome> {
    const { sp } = await this.asMember(a.space, a.by);
    const head = { seq: sp.seq, version: sp.head };
    // the same version again (a retry whose reply was lost) is a success, not a conflict
    const same = await this.db.prepare("SELECT id FROM versions WHERE space = ? AND seq = ?").bind(sp.id, a.seq).first<{ id: string }>();
    if (same && same.id === a.id) return none({ seq: a.seq, version: a.id });
    if (a.epoch !== sp.epoch || a.seq !== sp.seq + 1 || a.parent !== sp.head) throw err("conflict", "the head has moved", { head });
    const list = JSON.stringify(a.blobs);
    const missing = (
      await this.db
        .prepare("SELECT j.value AS id FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM blobs WHERE space = ? AND id = j.value)")
        .bind(list, sp.id)
        .all<{ id: string }>()
    ).results.map((r) => r.id);
    if (missing.length) throw err("missing_blobs", "upload every blob first", { missing: missing.slice(0, 500) });
    const fresh = await this.db
      .prepare(
        "SELECT COALESCE(SUM(b.size), 0) AS n FROM blobs b JOIN json_each(?) j ON j.value = b.id WHERE b.space = ? " +
          "AND NOT EXISTS (SELECT 1 FROM version_blobs v WHERE v.space = b.space AND v.blob = b.id)",
      )
      .bind(list, sp.id)
      .first<{ n: number }>();
    const used = (await this.q.liveSize(sp.id)) + (fresh?.n ?? 0);
    if (used > this.lim.quota) throw err("quota_exceeded", `the space would use ${used} of ${this.lim.quota} bytes`, { size: used, quota: this.lim.quota });
    await this.db.batch([
      this.put("INSERT INTO versions (space, seq, id, doc, author, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", sp.id, a.seq, a.id, JSON.stringify(a.doc), a.by, a.epoch, a.now),
      this.put("INSERT INTO version_blobs (space, seq, blob) SELECT ?, ?, value FROM json_each(?)", sp.id, a.seq, list),
      this.put("UPDATE spaces SET seq = ?, head = ? WHERE id = ? AND seq = ?", a.seq, a.id, sp.id, sp.seq),
    ]);
    const to = await this.q.memberAddresses(sp.id, [a.by]);
    return { result: { seq: a.seq, version: a.id }, events: to.map((t) => ({ to: t, event: "head", data: { space: sp.id, seq: a.seq, version: a.id, author: a.by } })) };
  }

  // --- blobs -----------------------------------------------------------------------------------

  /** Before an upload: the member still belongs, the quota has room, and the ticket is used up. `exists`: nothing to write. */
  async cmd_blobBegin(a: { space: string; by: string; id: string; size: number; mac: string; exp: number; now: number }): Promise<Outcome> {
    const { sp } = await this.asMember(a.space, a.by);
    const have = await this.db.prepare("SELECT size FROM blobs WHERE space = ? AND id = ?").bind(sp.id, a.id).first<{ size: number }>();
    if (!have) {
      const stored = await this.q.storedSize(sp.id);
      if (stored + a.size > this.lim.quota) throw err("quota_exceeded", "the space is full", { size: stored, quota: this.lim.quota });
    }
    await this.claim(a.mac, a.exp);
    return none({ exists: !!have });
  }

  async cmd_blobCommit(a: { space: string; id: string; size: number; now: number }): Promise<Outcome> {
    await this.put("INSERT OR IGNORE INTO blobs (space, id, size, created_at) VALUES (?, ?, ?, ?)", a.space, a.id, a.size, a.now).run();
    return none();
  }

  /** The upload failed after its ticket was used: give the ticket back, so the same URL can be tried again. */
  async cmd_ticketRelease(a: { mac: string }): Promise<Outcome> {
    await this.put("DELETE FROM tickets WHERE mac = ?", a.mac).run();
    return none();
  }

  /** Before a download: the member still belongs, the blob is stored, and the ticket is used up. */
  async cmd_blobGet(a: { space: string; by: string; id: string; mac: string; exp: number }): Promise<Outcome> {
    const { sp } = await this.asMember(a.space, a.by);
    const have = await this.db.prepare("SELECT size FROM blobs WHERE space = ? AND id = ?").bind(sp.id, a.id).first<{ size: number }>();
    if (!have) throw err("not_found", "no such blob");
    await this.claim(a.mac, a.exp);
    return none({ size: have.size });
  }

  private async claim(mac: string, exp: number): Promise<void> {
    const r = await this.db.prepare("INSERT OR IGNORE INTO tickets (mac, expires) VALUES (?, ?)").bind(mac, exp).run();
    if (r.meta.changes !== 1) throw err("ticket_used", "that URL was used already");
  }

  /** Drop blobs nothing needs: an upload no version used for a week, a blob no version of the last 90 days used (the head's
   * blobs always stay). Gives the number dropped. */
  async cmd_gc(a: { space: string; now: number }): Promise<Outcome> {
    const rows = await this.db
      .prepare(
        "SELECT b.id AS id FROM blobs b WHERE b.space = ? AND (" +
          "(NOT EXISTS (SELECT 1 FROM version_blobs vb WHERE vb.space = b.space AND vb.blob = b.id) AND b.created_at < ?) OR " +
          "(EXISTS (SELECT 1 FROM version_blobs vb WHERE vb.space = b.space AND vb.blob = b.id) AND NOT EXISTS (" +
          "SELECT 1 FROM version_blobs vb JOIN versions v ON v.space = vb.space AND v.seq = vb.seq " +
          "WHERE vb.space = b.space AND vb.blob = b.id AND (v.created_at >= ? OR v.seq = (SELECT seq FROM spaces s WHERE s.id = b.space))))) LIMIT ?",
      )
      .bind(a.space, a.now - ORPHAN_KEEP, a.now - BLOB_KEEP, GC_BATCH)
      .all<{ id: string }>();
    for (const r of rows.results) {
      await this.blobs.delete(`${a.space}/${r.id}`);
      await this.put("DELETE FROM blobs WHERE space = ? AND id = ?", a.space, r.id).run();
    }
    return none({ dropped: rows.results.length });
  }

  // --- locks -----------------------------------------------------------------------------------

  /** Remove expired locks of the space; the events say so. */
  private async expired(sp: SpaceRow, now: number): Promise<Ev[]> {
    const gone = (await this.db.prepare("SELECT * FROM locks WHERE space = ? AND expires <= ?").bind(sp.id, now).all<LockRow>()).results;
    if (!gone.length) return [];
    await this.put("DELETE FROM locks WHERE space = ? AND expires <= ?", sp.id, now).run();
    const to = await this.q.memberAddresses(sp.id);
    return gone.flatMap((l) => to.map((t) => ({ to: t, event: "lock", data: { space: sp.id, lock: lockView(l), state: "expired" } })));
  }

  async cmd_locksExpire(a: { space: string; now: number }): Promise<Outcome> {
    const sp = await this.q.space(a.space);
    return { result: {}, events: sp ? await this.expired(sp, a.now) : [] };
  }

  async cmd_locksList(a: { space: string; by: string; now: number }): Promise<Outcome> {
    const { sp } = await this.asMember(a.space, a.by);
    const rows = (await this.db.prepare("SELECT * FROM locks WHERE space = ? AND expires > ? ORDER BY taken, tag").bind(sp.id, a.now).all<LockRow>()).results;
    return none({ locks: rows.map(lockView) });
  }

  async cmd_lockTake(a: { space: string; by: string; tag: string; sealed: Obj; ttlHours: number | null; now: number }): Promise<Outcome> {
    const { sp } = await this.asMember(a.space, a.by);
    const ttl = a.ttlHours ?? LOCK_DEFAULT_HOURS;
    if (!(ttl > 0 && ttl <= LOCK_MAX_HOURS)) throw err("bad_args", `ttl_hours is a number up to ${LOCK_MAX_HOURS}`);
    const events: Ev[] = [];
    let cur = await this.db.prepare("SELECT * FROM locks WHERE space = ? AND tag = ?").bind(sp.id, a.tag).first<LockRow>();
    if (cur && cur.expires <= a.now) {
      // it ran out: it is gone now, and the others hear so
      await this.put("DELETE FROM locks WHERE space = ? AND tag = ?", sp.id, a.tag).run();
      for (const t of await this.q.memberAddresses(sp.id)) events.push({ to: t, event: "lock", data: { space: sp.id, lock: lockView(cur), state: "expired" } });
      cur = null;
    }
    if (cur && cur.holder !== a.by) throw err("locked", "someone holds that lock", { lock: lockView(cur) });
    if (!cur) {
      const n = await this.db.prepare("SELECT count(*) AS n FROM locks WHERE space = ?").bind(sp.id).first<{ n: number }>();
      if ((n?.n ?? 0) >= MAX_LOCKS) throw err("limit_reached", `at most ${MAX_LOCKS} locks per space`);
    }
    const row: LockRow = { space: sp.id, tag: a.tag, holder: a.by, sealed: JSON.stringify(a.sealed), taken: cur ? cur.taken : a.now, expires: a.now + Math.floor(ttl * 3600) };
    await this.put(
      "INSERT INTO locks (space, tag, holder, sealed, taken, expires) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(space, tag) DO UPDATE SET sealed = excluded.sealed, expires = excluded.expires",
      row.space,
      row.tag,
      row.holder,
      row.sealed,
      row.taken,
      row.expires,
    ).run();
    const to = await this.q.memberAddresses(sp.id, [a.by]);
    for (const t of to) events.push({ to: t, event: "lock", data: { space: sp.id, lock: lockView(row), state: "taken" } });
    return { result: { lock: lockView(row) }, events };
  }

  private async drop(a: { space: string; by: string; tag: string; now: number }, state: "released" | "broken"): Promise<Outcome> {
    const { sp } = await this.asMember(a.space, a.by);
    const events: Ev[] = [];
    const cur = await this.db.prepare("SELECT * FROM locks WHERE space = ? AND tag = ? AND expires > ?").bind(sp.id, a.tag, a.now).first<LockRow>();
    if (!cur) throw err("not_found", "no such lock");
    if (state === "released" && cur.holder !== a.by) throw err("not_allowed", "only the holder releases a lock; the creator may break it");
    if (state === "broken") this.creatorOnly(sp, a.by);
    await this.put("DELETE FROM locks WHERE space = ? AND tag = ?", sp.id, a.tag).run();
    for (const t of await this.q.memberAddresses(sp.id, [a.by])) events.push({ to: t, event: "lock", data: { space: sp.id, lock: lockView(cur), state } });
    return { result: {}, events };
  }

  cmd_lockRelease(a: { space: string; by: string; tag: string; now: number }): Promise<Outcome> {
    return this.drop(a, "released");
  }

  cmd_lockBreak(a: { space: string; by: string; tag: string; now: number }): Promise<Outcome> {
    return this.drop(a, "broken");
  }
}
