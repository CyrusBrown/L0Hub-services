// What several methods share: the write guard, the daily limits, events, creating a topic, watches.
import { ServiceError, type Obj } from "@l0wservices/core";
import { isModerator, limitsOf, moderators } from "./config";
import { filesFor, postObj, slugTaken, type Ctx, type FileMeta, type PostRow, type TopicRow, TOPIC_SELECT } from "./model";
import { DAY, iso, newId } from "./util";

export async function stateValue(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM board_state WHERE key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setState(db: D1Database, key: string, value: string | null): Promise<void> {
  if (value === null) await db.prepare("DELETE FROM board_state WHERE key = ?").bind(key).run();
  else await db.prepare("INSERT INTO board_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

export const isPaused = async (db: D1Database): Promise<boolean> => (await stateValue(db, "paused")) === "1";

export async function memberState(db: D1Database, address: string): Promise<{ muted: boolean; reason: string; posts_total: number }> {
  const r = await db.prepare("SELECT muted, muted_reason, posts_total FROM member_state WHERE address = ?").bind(address).first<{ muted: number; muted_reason: string; posts_total: number }>();
  return { muted: r?.muted === 1, reason: r?.muted_reason ?? "", posts_total: r?.posts_total ?? 0 };
}

/** Before a write: a paused board answers `unavailable`; a muted member can read but not post, vote or send (`muted: true`). */
export async function guardWrite(ctx: Ctx, opts: { muted: boolean }): Promise<void> {
  if (await isPaused(ctx.db)) throw new ServiceError("unavailable", "the board is paused");
  if (opts.muted && (await memberState(ctx.db, ctx.from)).muted) throw new ServiceError("not_allowed", "this member is muted");
}

export type Daily = "posts" | "messages" | "files";

const DAILY: Record<Daily, { table: string; col: string; max: (c: Ctx) => number; what: string }> = {
  posts: { table: "posts", col: "author", max: (c) => limitsOf(c.env).postsPerDay, what: "posts per day" },
  messages: { table: "messages", col: "author", max: (c) => limitsOf(c.env).messagesPerDay, what: "discussion messages per day" },
  files: { table: "files", col: "owner", max: (c) => limitsOf(c.env).filesPerDay, what: "file uploads per day" },
};

/** What's left of the rolling 24 hours, and when the oldest use falls out of it. */
export async function dailyLeft(ctx: Ctx, kind: Daily): Promise<{ left: number; retry: number }> {
  const d = DAILY[kind];
  const r = await ctx.db
    .prepare(`SELECT count(*) AS n, min(created) AS oldest FROM ${d.table} WHERE ${d.col} = ? AND created > ?`)
    .bind(ctx.from, ctx.now - DAY)
    .first<{ n: number; oldest: number | null }>();
  const max = d.max(ctx);
  return { left: Math.max(0, max - (r?.n ?? 0)), retry: r?.oldest ? Math.max(1, r.oldest + DAY - ctx.now) : 1 };
}

export async function enforceDaily(ctx: Ctx, kind: Daily): Promise<void> {
  const { left, retry } = await dailyLeft(ctx, kind);
  if (left <= 0) throw new ServiceError("limit", `${DAILY[kind].what}: ${DAILY[kind].max(ctx)}`, { retry_after: retry });
}

// --- events ----------------------------------------------------------------------------------------------------------

const forEvent = (p: PostRow): PostRow => ({ ...p, my_vote: 0 });

/** `post` to the subscribers of the post's topic (not its author). */
export async function announcePost(ctx: Ctx, p: PostRow): Promise<void> {
  const subs = await ctx.db.prepare("SELECT member FROM subscriptions WHERE topic_id = ? AND member != ?").bind(p.topic_id, p.author).all<{ member: string }>();
  if (!subs.results.length) return;
  const files = (await filesFor(ctx.db, [p.id])).get(p.id) ?? [];
  const data: Obj = { post: postObj(forEvent(p), files, false) };
  for (const s of subs.results) await ctx.emit(s.member, "post", data);
}

/** `held` to the moderators (members holding the role per ROLES), not to the author. */
export async function announceHeld(ctx: Ctx, p: PostRow): Promise<void> {
  const files = (await filesFor(ctx.db, [p.id])).get(p.id) ?? [];
  const data: Obj = { post: postObj(forEvent(p), files, false) };
  for (const m of moderators(ctx.env)) if (m !== p.author) await ctx.emit(m, "held", data);
}

// --- topics ----------------------------------------------------------------------------------------------------------

export async function createTopic(ctx: Ctx, slug: string, title: string, description: string): Promise<TopicRow> {
  if (await slugTaken(ctx.db, slug)) throw new ServiceError("bad_args", `the slug ${JSON.stringify(slug)} is already in use`);
  const cap = limitsOf(ctx.env).maxTopics;
  if (cap > 0) {
    const n = await ctx.db.prepare("SELECT count(*) AS n FROM topics WHERE id != 'board-requests' AND state != 'archived'").first<{ n: number }>();
    if ((n?.n ?? 0) >= cap) throw new ServiceError("limit", `the board is capped at ${cap} topics`);
  }
  const id = newId();
  await ctx.db.prepare("INSERT INTO topics (id, slug, title, description, state, pinned, created) VALUES (?, ?, ?, ?, 'open', 0, ?)").bind(id, slug, title, description, ctx.now).run();
  return (await ctx.db.prepare(`${TOPIC_SELECT} WHERE t.id = ?`).bind(id).first<TopicRow>())!;
}

/** Up to 5 existing topics that share words with the proposal's slug and title. */
export async function similarTopics(ctx: Ctx, slug: string, title: string): Promise<TopicRow[]> {
  const words = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3)
        .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)),
    );
  const mine = new Set([...words(slug), ...words(title)]);
  if (!mine.size) return [];
  const all = await ctx.db.prepare(`${TOPIC_SELECT} WHERE t.state != 'archived' AND t.id != 'board-requests'`).all<TopicRow>();
  return all.results
    .map((t) => ({ t, n: [...new Set([...words(t.slug), ...words(t.title)])].filter((w) => mine.has(w)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.t.slug.localeCompare(b.t.slug))
    .slice(0, 5)
    .map((x) => x.t);
}

// --- watches ---------------------------------------------------------------------------------------------------------

export interface WatchRow {
  post_id: string;
  title: string;
  since: number;
  expires: number;
  unread: number;
}

export async function watchesOf(ctx: Ctx, member: string): Promise<Obj[]> {
  const r = await ctx.db
    .prepare(
      `SELECT w.post_id, p.title, w.since, w.expires,
         (SELECT count(*) FROM messages m WHERE m.post_id = w.post_id AND m.seq > w.read_seq AND m.author != w.member) AS unread
       FROM watches w JOIN posts p ON p.id = w.post_id
       WHERE w.member = ? AND w.expires > ? AND p.state != 'removed' ORDER BY w.since, w.post_id`,
    )
    .bind(member, ctx.now)
    .all<WatchRow>();
  return r.results.map((w) => ({ post: w.post_id, title: w.title, since: iso(w.since), expires: iso(w.expires), unread: w.unread }));
}

export const isMod = (ctx: Ctx, who = ctx.from): boolean => isModerator(ctx.env, who);
export type { FileMeta };
