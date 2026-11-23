// Rows, the objects of board.md built from them, and the lookups every method shares.
import { ServiceError, type CallContext, type Obj } from "@l0wservices/core";
import { isModerator, type BoardEnv } from "./config";
import { LOCK_AFTER, iso, isoOrNull } from "./util";

export type Ctx = CallContext<BoardEnv>;

export interface TopicRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  state: string;
  pinned: number;
  merged_into: string | null;
  created: number;
  posts?: number;
  last_post?: number | null;
}

export interface PostRow {
  seq: number;
  id: string;
  topic_id: string;
  topic_slug: string;
  author: string;
  title: string;
  body: string;
  summary: string;
  tags: string;
  state: string;
  pinned: number;
  created: number;
  edited: number | null;
  up: number;
  down: number;
  score: number;
  proposal: string | null;
  msg_count: number;
  msg_last: number | null;
  my_vote: number;
}

export interface FileMeta {
  id: string;
  name: string;
  type: string;
  size: number;
}

export interface MessageRow {
  seq: number;
  id: string;
  post_id: string;
  author: string;
  body: string;
  mentions: string;
  created: number;
}

export const TOPIC_SELECT = `SELECT t.*,
  (SELECT count(*) FROM posts p WHERE p.topic_id = t.id AND p.state = 'visible') AS posts,
  (SELECT max(p.created) FROM posts p WHERE p.topic_id = t.id AND p.state = 'visible') AS last_post
  FROM topics t`;

export const POST_SELECT = `SELECT p.*, t.slug AS topic_slug, COALESCE(v.value, 0) AS my_vote
  FROM posts p JOIN topics t ON t.id = p.topic_id LEFT JOIN votes v ON v.post_id = p.id AND v.member = ?`;

export const topicObj = (t: TopicRow): Obj => ({
  id: t.id,
  slug: t.slug,
  title: t.title,
  description: t.description,
  state: t.state,
  created: iso(t.created),
  posts: t.posts ?? 0,
  last_post: isoOrNull(t.last_post ?? null),
  pinned: t.pinned === 1,
});

export function proposalObj(json: string | null): Obj | null {
  if (!json) return null;
  const p = JSON.parse(json) as Obj;
  return { slug: p.slug, title: p.title, description: p.description, decision: p.decision ?? null };
}

export const locksAt = (created: number): number => created + LOCK_AFTER;

/** A Post (board.md). `body` is left out for lists. */
export function postObj(p: PostRow, files: FileMeta[], withBody: boolean): Obj {
  const out: Obj = { id: p.id, topic: p.topic_slug, author: p.author, title: p.title };
  if (withBody) out.body = p.state === "removed" ? "" : p.body;
  out.summary = p.summary;
  out.tags = JSON.parse(p.tags);
  out.files = files;
  out.created = iso(p.created);
  out.edited = isoOrNull(p.edited);
  out.score = p.score;
  out.up = p.up;
  out.down = p.down;
  out.my_vote = p.my_vote;
  out.state = p.state;
  out.pinned = p.pinned === 1;
  out.proposal = proposalObj(p.proposal);
  out.discussion = { messages: p.msg_count, last: isoOrNull(p.msg_last), locks: iso(locksAt(p.created)) };
  return out;
}

export const messageObj = (m: MessageRow): Obj => ({
  id: m.id,
  post: m.post_id,
  author: m.author,
  body: m.body,
  created: iso(m.created),
  mentions: JSON.parse(m.mentions),
});

/** Files attached to the given posts, by post id (queries are chunked: D1 takes at most 100 bound values). */
export async function filesFor(db: D1Database, postIds: string[]): Promise<Map<string, FileMeta[]>> {
  const out = new Map<string, FileMeta[]>();
  for (let i = 0; i < postIds.length; i += 50) {
    const chunk = postIds.slice(i, i + 50);
    const r = await db
      .prepare(`SELECT id, name, type, size, post_id FROM files WHERE post_id IN (${chunk.map(() => "?").join(",")}) ORDER BY created, id`)
      .bind(...chunk)
      .all<FileMeta & { post_id: string }>();
    for (const f of r.results) {
      const list = out.get(f.post_id) ?? [];
      list.push({ id: f.id, name: f.name, type: f.type, size: f.size });
      out.set(f.post_id, list);
    }
  }
  return out;
}

/** May `who` see this post? Held and hidden posts are for their author and the moderators. Removed posts are a tombstone for everyone. */
export const canSee = (env: BoardEnv, p: Pick<PostRow, "state" | "author">, who: string): boolean =>
  p.state === "visible" || p.state === "removed" || p.author === who || isModerator(env, who);

/** SQL for the same rule in a list (removed posts are not listed). Binds: who, 0/1 for moderator. */
export const VISIBLE_SQL = `(p.state = 'visible' OR (p.state IN ('held', 'hidden') AND (p.author = ? OR ? = 1)))`;

export async function loadPost(ctx: Ctx, id: string, who = ctx.from): Promise<PostRow | null> {
  return ctx.db.prepare(`${POST_SELECT} WHERE p.id = ?`).bind(who, id).first<PostRow>();
}

/** The post, as `who` may see it, or `not_found`. */
export async function visiblePost(ctx: Ctx, id: string): Promise<PostRow> {
  const p = await loadPost(ctx, id);
  if (!p || !canSee(ctx.env, p, ctx.from)) throw new ServiceError("not_found", "no such post");
  return p;
}

export async function renderPost(ctx: Ctx, id: string, withBody = true): Promise<Obj> {
  const p = await loadPost(ctx, id);
  if (!p) throw new ServiceError("not_found", "no such post");
  const files = await filesFor(ctx.db, [id]);
  return postObj(p, files.get(id) ?? [], withBody);
}

// --- topics: a slug (or an old slug, or a merged topic's) answers ------------------------------------------------------

export async function findTopic(db: D1Database, slugOrAlias: string): Promise<TopicRow | null> {
  let t = await db.prepare(`${TOPIC_SELECT} WHERE t.slug = ?`).bind(slugOrAlias).first<TopicRow>();
  if (!t) {
    t = await db
      .prepare(`${TOPIC_SELECT} WHERE t.id = (SELECT topic_id FROM topic_aliases WHERE slug = ?)`)
      .bind(slugOrAlias)
      .first<TopicRow>();
  }
  for (let hops = 0; t && t.merged_into && hops < 10; hops++) {
    t = await db.prepare(`${TOPIC_SELECT} WHERE t.id = ?`).bind(t.merged_into).first<TopicRow>();
  }
  return t;
}

export async function topicBySlug(db: D1Database, slug: string): Promise<TopicRow> {
  const t = await findTopic(db, slug);
  if (!t) throw new ServiceError("not_found", `no topic ${JSON.stringify(slug)}`);
  return t;
}

/** A topic named by id or by slug (the moderator methods take either). */
export async function topicByIdOrSlug(db: D1Database, key: string): Promise<TopicRow> {
  const t = await db.prepare(`${TOPIC_SELECT} WHERE t.id = ?`).bind(key).first<TopicRow>();
  if (t) return t;
  return topicBySlug(db, key);
}

/** Is the slug taken, by a topic or by an old slug? */
export async function slugTaken(db: D1Database, slug: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM topics WHERE slug = ? UNION SELECT 1 FROM topic_aliases WHERE slug = ?")
    .bind(slug, slug)
    .first();
  return r !== null;
}
