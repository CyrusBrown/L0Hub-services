// Reads over the spaces tables (writes that must be atomic live in core.ts, behind the Durable Object).
import { times } from "@l0w/proto";
import type { Obj } from "@l0wservices/core";
import type { Limits } from "./env";

export interface SpaceRow {
  id: string;
  name: string;
  creator: string;
  epoch: number;
  seq: number;
  head: string | null;
  created_at: number;
  deleted_at: number | null;
}

export interface MemberRow {
  space: string;
  address: string;
  state: "member" | "invited";
  since: number;
  since_epoch: number;
  rekey_kid: string | null;
}

export interface LockRow {
  space: string;
  tag: string;
  holder: string;
  sealed: string;
  taken: number;
  expires: number;
}

export const iso = (t: number): string => times.formatTime(t);

export const lockView = (l: LockRow): Obj => ({ tag: l.tag, holder: l.holder, sealed: JSON.parse(l.sealed), taken: iso(l.taken), expires: iso(l.expires) });

export class SpacesDb {
  constructor(
    readonly db: D1Database,
    readonly lim: Limits,
  ) {}

  /** A space that is not being deleted. */
  async space(id: string): Promise<SpaceRow | null> {
    return this.db.prepare("SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL").bind(id).first<SpaceRow>();
  }

  /** Any space row, including one waiting to be dropped (its id stays taken). */
  async anySpace(id: string): Promise<SpaceRow | null> {
    return this.db.prepare("SELECT * FROM spaces WHERE id = ?").bind(id).first<SpaceRow>();
  }

  async member(space: string, address: string): Promise<MemberRow | null> {
    return this.db.prepare("SELECT * FROM space_members WHERE space = ? AND address = ?").bind(space, address).first<MemberRow>();
  }

  async members(space: string): Promise<MemberRow[]> {
    return (await this.db.prepare("SELECT * FROM space_members WHERE space = ? ORDER BY since, address").bind(space).all<MemberRow>()).results;
  }

  /** Addresses in state `member` (not invitees), optionally without some. */
  async memberAddresses(space: string, except: string[] = []): Promise<string[]> {
    return (await this.members(space)).filter((m) => m.state === "member" && !except.includes(m.address)).map((m) => m.address);
  }

  /** Bytes of the blobs some version uses (the quota counts these). */
  async liveSize(space: string): Promise<number> {
    const r = await this.db
      .prepare("SELECT COALESCE(SUM(b.size), 0) AS n FROM blobs b WHERE b.space = ? AND EXISTS (SELECT 1 FROM version_blobs v WHERE v.space = b.space AND v.blob = b.id)")
      .bind(space)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  /** Bytes of everything stored for the space, used or not. */
  async storedSize(space: string): Promise<number> {
    return (await this.db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM blobs WHERE space = ?").bind(space).first<{ n: number }>())?.n ?? 0;
  }

  async view(row: SpaceRow): Promise<Obj> {
    const members = (await this.members(row.id)).map((m) => ({ address: m.address, state: m.state, since: iso(m.since) }));
    return {
      id: row.id,
      name: row.name,
      creator: row.creator,
      members,
      epoch: row.epoch,
      seq: row.seq,
      version: row.head,
      size: await this.liveSize(row.id),
      quota: this.lim.quota,
      max_file: this.lim.maxFile,
    };
  }

  async spacesOf(address: string): Promise<SpaceRow[]> {
    return (
      await this.db
        .prepare("SELECT s.* FROM spaces s JOIN space_members m ON m.space = s.id WHERE m.address = ? AND s.deleted_at IS NULL ORDER BY s.created_at, s.id")
        .bind(address)
        .all<SpaceRow>()
    ).results;
  }
}
