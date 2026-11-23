// The methods of spaces.md. Reads go straight to D1; everything that changes a space goes through its Durable Object,
// which returns the events to send (to members, after the change is stored).
import { b64 } from "@l0w/proto";
import { ServiceError, type MethodDef, type Obj } from "@l0wservices/core";
import type { Outcome } from "./core";
import { inSpace } from "./durable";
import { BLOB_OVERHEAD, LOCK_MAX_HOURS, MAX_BLOBS_MISSING, TICKET_TTL, limits, type SpacesEnv } from "./env";
import { iso, SpacesDb, type SpaceRow } from "./store";
import { makeTicket } from "./tickets";
import { BLOB_ID, SPACE_NAME, addressArg, bad, checkKeyDoc, checkVersionDoc, intArg, spaceArg, type Ctx } from "./verify";

const db = (ctx: Ctx): SpacesDb => new SpacesDb(ctx.db, limits(ctx.env));

/** Send what the Durable Object said to send. A member that isn't connected just doesn't hear: it catches up with the next call. */
export async function sendEvents(ctx: Ctx, out: Outcome): Promise<void> {
  for (const ev of out.events) {
    try {
      await ctx.emit(ev.to, ev.event, ev.data);
    } catch (e) {
      console.error(`event ${ev.event} to ${ev.to} failed:`, e);
    }
  }
}

async function change(ctx: Ctx, space: string, cmd: string, args: Obj): Promise<Obj> {
  const out = await inSpace(ctx.env, space, cmd, { ...args, space, by: ctx.from, now: ctx.now });
  await sendEvents(ctx, out);
  return out.result;
}

/** The space, when the caller is a full member of it (an invitee is `not_member`, a stranger `not_found`). */
async function member(ctx: Ctx, space: string): Promise<{ q: SpacesDb; sp: SpaceRow }> {
  const q = db(ctx);
  const sp = await q.space(space);
  const me = sp ? await q.member(space, ctx.from) : null;
  if (!sp || !me) throw new ServiceError("not_found", "no such space");
  if (me.state !== "member") throw new ServiceError("not_member", "accept the invitation first");
  return { q, sp };
}

/** The creator-only methods: say no before looking at anything the caller sent. A stranger doesn't learn the space exists. */
async function creatorOnly(ctx: Ctx, space: string): Promise<string> {
  const q = db(ctx);
  const sp = await q.space(space);
  if (!sp || !(await q.member(space, ctx.from))) throw new ServiceError("not_found", "no such space");
  if (sp.creator !== ctx.from) throw new ServiceError("not_allowed", "only the space's creator may do this");
  return sp.creator;
}

function list(args: Obj, name: string, max: number): unknown[] {
  const v = args[name];
  if (!Array.isArray(v) || v.length > max) throw bad(`${name} is a list of at most ${max}`);
  return v;
}

/** The member's current seal key against the latest key document the creator made for them: when they differ, the creator
 * is told (`rekey`) once per key. */
export async function checkRekey(ctx: Ctx, space: string, who: string): Promise<void> {
  const q = db(ctx);
  const sp = await q.space(space);
  const me = sp ? await q.member(space, who) : null;
  if (!sp || !me) return;
  const entry = await ctx.directory(who);
  const latest = await ctx.db.prepare("SELECT member_kid FROM space_keys WHERE space = ? AND member = ? ORDER BY epoch DESC LIMIT 1").bind(space, who).first<{ member_kid: string }>();
  if (!entry || !latest || entry.sealKey.kid === latest.member_kid || me.rekey_kid === entry.sealKey.kid) return;
  await ctx.db.prepare("UPDATE space_members SET rekey_kid = ? WHERE space = ? AND address = ?").bind(entry.sealKey.kid, space, who).run();
  await ctx.emit(sp.creator, "rekey", { space, member: who });
}

async function ticketUrl(ctx: Ctx, t: { space: string; id: string; size: number; dir: "put" | "get" }): Promise<Obj> {
  const exp = ctx.now + TICKET_TTL;
  const token = await makeTicket(ctx.env.TICKET_KEY ?? "", { ...t, exp, by: ctx.from });
  const host = ctx.env.SERVICE_HOST || `spaces.${ctx.env.HUB_DOMAIN}`;
  const scheme = ctx.env.HUB_BASE.startsWith("http://") ? "http" : "https";
  return { url: `${scheme}://${host}/v0/blob/${token}`, expires: iso(exp) };
}

export const methods: Record<string, MethodDef<SpacesEnv>> = {
  "spaces.list": {
    handler: async (ctx) => {
      const q = db(ctx);
      return { spaces: await Promise.all((await q.spacesOf(ctx.from)).map((s) => q.view(s))) };
    },
  },

  "space.create": {
    handler: async (ctx, args) => {
      const name = args.name;
      if (typeof name !== "string" || name.length < 2 || name.length > 32 || !SPACE_NAME.test(name)) throw bad("name is a slug of 2 to 32 characters (a-z, 0-9, dashes)");
      const keys = list(args, "keys", 1);
      if (keys.length !== 1) throw bad("keys holds the creator's own epoch-1 key");
      const k = await checkKeyDoc(ctx, keys[0], ctx.from);
      if (k.member !== ctx.from || k.epoch !== 1) throw bad("the key is the creator's own, for epoch 1");
      // the space's id is the one its first key names
      const out = await inSpace(ctx.env, k.space, "create", { id: k.space, name, creator: ctx.from, key: { doc: k.doc, member: k.member, epoch: 1, memberKid: k.memberKid }, now: ctx.now });
      await sendEvents(ctx, out);
      return out.result;
    },
  },

  "space.get": {
    handler: async (ctx, args) => {
      const q = db(ctx);
      const id = spaceArg(args);
      const sp = await q.space(id);
      if (!sp || !(await q.member(id, ctx.from))) throw new ServiceError("not_found", "no such space");
      return { space: await q.view(sp) };
    },
  },

  "members.invite": {
    handler: async (ctx, args) => {
      const space = spaceArg(args);
      const who = addressArg(args, "member");
      const creator = await creatorOnly(ctx, space);
      if (!(await ctx.directory(who))) throw new ServiceError("unknown_member", `${who} is not a member of this hub`);
      const keys = [];
      for (const raw of list(args, "keys", 100)) {
        const k = await checkKeyDoc(ctx, raw, creator);
        if (k.space !== space || k.member !== who) throw bad("a key is for another space or member");
        keys.push({ doc: k.doc, member: k.member, epoch: k.epoch, memberKid: k.memberKid });
      }
      return change(ctx, space, "invite", { member: who, keys });
    },
  },

  "space.accept": {
    handler: async (ctx, args) => {
      const space = spaceArg(args);
      const r = await change(ctx, space, "accept", {});
      await checkRekey(ctx, space, ctx.from).catch((e) => console.error("rekey check failed:", e));
      return r;
    },
  },
  "space.decline": { handler: (ctx, args) => change(ctx, spaceArg(args), "decline", {}) },
  "space.leave": { handler: (ctx, args) => change(ctx, spaceArg(args), "leave", {}) },
  "space.delete": { handler: (ctx, args) => change(ctx, spaceArg(args), "delete", {}) },

  "members.remove": {
    handler: async (ctx, args) => {
      const space = spaceArg(args);
      const who = addressArg(args, "member");
      const creator = await creatorOnly(ctx, space);
      const keys = [];
      for (const raw of list(args, "keys", 100)) {
        const k = await checkKeyDoc(ctx, raw, creator);
        if (k.space !== space) throw bad("a key is for another space");
        keys.push({ doc: k.doc, member: k.member, epoch: k.epoch, memberKid: k.memberKid });
      }
      return change(ctx, space, "remove", { member: who, keys });
    },
  },

  "keys.put": {
    handler: async (ctx, args) => {
      const space = spaceArg(args);
      const creator = await creatorOnly(ctx, space);
      const keys = [];
      for (const raw of list(args, "keys", 100)) {
        const k = await checkKeyDoc(ctx, raw, creator);
        if (k.space !== space) throw bad("a key is for another space");
        keys.push({ doc: k.doc, member: k.member, epoch: k.epoch, memberKid: k.memberKid });
      }
      return change(ctx, space, "keysPut", { keys });
    },
  },

  "keys.get": {
    handler: async (ctx, args) => {
      const space = spaceArg(args);
      await member(ctx, space);
      await checkRekey(ctx, space, ctx.from).catch((e) => console.error("rekey check failed:", e));
      const rows = (await ctx.db.prepare("SELECT doc FROM space_keys WHERE space = ? AND member = ? ORDER BY epoch").bind(space, ctx.from).all<{ doc: string }>()).results;
      return { keys: rows.map((r) => JSON.parse(r.doc)) };
    },
  },

  head: {
    handler: async (ctx, args) => {
      const { sp } = await member(ctx, spaceArg(args));
      return { seq: sp.seq, version: sp.head };
    },
  },

  "versions.list": {
    handler: async (ctx, args) => {
      const space = spaceArg(args);
      await member(ctx, space);
      const after = intArg(args, "after", 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = intArg(args, "limit", 1, 200, 50);
      const rows = (
        await ctx.db.prepare("SELECT seq, doc FROM versions WHERE space = ? AND seq > ? ORDER BY seq LIMIT ?").bind(space, after, limit + 1).all<{ seq: number; doc: string }>()
      ).results;
      // a reply is at most 1 MiB: stop short of it (a version is never split)
      const versions: unknown[] = [];
      let bytes = 0;
      let last = after;
      let more = false;
      for (const r of rows.slice(0, limit)) {
        if (versions.length && bytes + r.doc.length > 900_000) {
          more = true;
          break;
        }
        bytes += r.doc.length;
        versions.push(JSON.parse(r.doc));
        last = r.seq;
      }
      return { versions, next: more || rows.length > limit ? last : null };
    },
  },

  "blobs.missing": {
    handler: async (ctx, args) => {
      const space = spaceArg(args);
      await member(ctx, space);
      const ids = list(args, "ids", MAX_BLOBS_MISSING);
      if (!ids.every((i) => typeof i === "string" && BLOB_ID.test(i))) throw bad("ids are blob ids");
      const rows = await ctx.db
        .prepare("SELECT j.value AS id FROM json_each(?) j WHERE NOT EXISTS (SELECT 1 FROM blobs WHERE space = ? AND id = j.value)")
        .bind(JSON.stringify(ids), space)
        .all<{ id: string }>();
      return { missing: rows.results.map((r) => r.id) };
    },
  },

  "blob.upload": {
    handler: async (ctx, args) => {
      const space = spaceArg(args);
      const { q } = await member(ctx, space);
      const id = args.id;
      if (typeof id !== "string" || !BLOB_ID.test(id)) throw bad("id is a blob id");
      const size = intArg(args, "size", 1, Number.MAX_SAFE_INTEGER);
      const lim = q.lim;
      if (size < BLOB_OVERHEAD) throw bad(`the stored form is at least ${BLOB_OVERHEAD} bytes`);
      if (size > lim.maxFile + BLOB_OVERHEAD) throw new ServiceError("too_large", `a file is at most ${lim.maxFile} bytes`, { max_file: lim.maxFile });
      return ticketUrl(ctx, { space, id, size, dir: "put" });
    },
  },

  "blob.download": {
    handler: async (ctx, args) => {
      const space = spaceArg(args);
      await member(ctx, space);
      const id = args.id;
      if (typeof id !== "string" || !BLOB_ID.test(id)) throw bad("id is a blob id");
      const have = await ctx.db.prepare("SELECT size FROM blobs WHERE space = ? AND id = ?").bind(space, id).first<{ size: number }>();
      if (!have) throw new ServiceError("not_found", "no such blob");
      return ticketUrl(ctx, { space, id, size: have.size, dir: "get" });
    },
  },

  "version.push": {
    handler: async (ctx, args) => {
      const space = spaceArg(args);
      const v = await checkVersionDoc(ctx, args.version, ctx.from);
      if (v.space !== space) throw bad("the version is for another space");
      return change(ctx, space, "push", { doc: v.doc, id: v.id, seq: v.seq, parent: v.parent, epoch: v.epoch, blobs: v.blobs });
    },
  },

  "locks.list": { handler: (ctx, args) => change(ctx, spaceArg(args), "locksList", {}) },

  "lock.take": {
    handler: async (ctx, args) => {
      const space = spaceArg(args);
      const tag = args.tag;
      let ok = typeof tag === "string";
      try {
        ok = ok && b64.decode(tag).length === 16;
      } catch {
        ok = false;
      }
      if (!ok) throw bad("tag is the base64url of 16 bytes");
      const s = args.sealed as Obj | undefined;
      try {
        if (!s || typeof s !== "object" || typeof s.nonce !== "string" || typeof s.ct !== "string" || b64.decode(s.nonce).length !== 12 || s.ct.length > 8192) throw 0;
        b64.decode(s.ct);
      } catch {
        throw bad("sealed is {nonce, ct} (base64url, a 12 byte nonce)");
      }
      let ttl: number | null = null;
      if (args.ttl_hours !== undefined && args.ttl_hours !== null) {
        if (typeof args.ttl_hours !== "number" || !(args.ttl_hours > 0 && args.ttl_hours <= LOCK_MAX_HOURS)) throw bad(`ttl_hours is a number up to ${LOCK_MAX_HOURS}`);
        ttl = args.ttl_hours;
      }
      return change(ctx, space, "lockTake", { tag, sealed: { nonce: s.nonce, ct: s.ct }, ttlHours: ttl });
    },
  },
  "lock.release": { handler: (ctx, args) => change(ctx, spaceArg(args), "lockRelease", { tag: tagArg(args) }) },
  "lock.break": { handler: (ctx, args) => change(ctx, spaceArg(args), "lockBreak", { tag: tagArg(args) }) },
};

function tagArg(args: Obj): string {
  const t = args.tag;
  try {
    if (typeof t === "string" && b64.decode(t).length === 16) return t;
  } catch {
    /* falls through */
  }
  throw bad("tag is the base64url of 16 bytes");
}
