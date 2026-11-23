// Moderator methods (role `moderator`). Every call is logged with the moderator's address, before it runs.
import { ServiceError, type MethodDef, type Obj } from "@l0wservices/core";
import type { BoardEnv } from "./config";
import { POST_SELECT, TOPIC_SELECT, filesFor, loadPost, postObj, renderPost, topicByIdOrSlug, topicBySlug, topicObj, type Ctx, type PostRow, type TopicRow } from "./model";
import { announcePost, createTopic, guardWrite } from "./shared";
import { bad, checkSlug, decodeCursor, encodeCursor, iso, keyset, limitArg, optBool, optString, reqId, reqString, timeArg } from "./util";

type M = MethodDef<BoardEnv>;

const LOG_ARGS_MAX = 4000;

export async function logModeration(db: D1Database, now: number, by: string, method: string, args: Obj): Promise<void> {
  let text = JSON.stringify(args);
  if (text.length > LOG_ARGS_MAX) text = JSON.stringify({ truncated: true, keys: Object.keys(args) });
  await db.prepare("INSERT INTO moderation_log (at, by, method, args) VALUES (?, ?, ?, ?)").bind(now, by, method, text).run();
}

/** A moderator method: logged first (a call that fails is in the log too), and writes stop while the board is paused. */
function mod(method: string, handler: (ctx: Ctx, args: Obj) => Promise<Obj> | Obj, opts: { write?: boolean } = { write: true }): M {
  return {
    role: "moderator",
    handler: async (ctx, args) => {
      await logModeration(ctx.db, ctx.now, ctx.from, method, args);
      if (opts.write) await guardWrite(ctx, { muted: false });
      return handler(ctx, args);
    },
  };
}

const TOPIC_STATES = ["open", "readonly", "archived"];
const QUEUE_BYTES = 700 * 1024; // a reply is at most 1 MiB

async function topicRow(ctx: Ctx, id: string): Promise<TopicRow> {
  return (await ctx.db.prepare(`${TOPIC_SELECT} WHERE t.id = ?`).bind(id).first<TopicRow>())!;
}

export const moderation: Record<string, M> = {
  "mod.topic.create": mod("mod.topic.create", async (ctx, args) => {
    const slug = checkSlug(reqString(args, "slug", 2, 32));
    const t = await createTopic(ctx, slug, reqString(args, "title", 1, 100), reqString(args, "description", 0, 1000));
    return { topic: topicObj(t) };
  }),

  "mod.topic.update": mod("mod.topic.update", async (ctx, args) => {
    const t = await topicByIdOrSlug(ctx.db, reqString(args, "id", 1, 64));
    const sets: string[] = [];
    const binds: unknown[] = [];
    const title = optString(args, "title", 100);
    if (title !== undefined) {
      if (!title) throw bad("title is 1 to 100 characters");
      sets.push("title = ?");
      binds.push(title);
    }
    const description = optString(args, "description", 1000);
    if (description !== undefined) {
      sets.push("description = ?");
      binds.push(description);
    }
    const stmts: D1PreparedStatement[] = [];
    const slug = optString(args, "slug", 32);
    if (slug !== undefined && slug !== t.slug) {
      if (t.id === "board-requests") throw bad("board-requests keeps its name");
      checkSlug(slug);
      const alias = await ctx.db.prepare("SELECT topic_id FROM topic_aliases WHERE slug = ?").bind(slug).first<{ topic_id: string }>();
      const taken = await ctx.db.prepare("SELECT 1 AS x FROM topics WHERE slug = ?").bind(slug).first();
      if (taken || (alias && alias.topic_id !== t.id)) throw bad(`the slug ${JSON.stringify(slug)} is already in use`);
      sets.push("slug = ?");
      binds.push(slug);
      stmts.push(ctx.db.prepare("DELETE FROM topic_aliases WHERE slug = ?").bind(slug));
      stmts.push(ctx.db.prepare("INSERT OR REPLACE INTO topic_aliases (slug, topic_id) VALUES (?, ?)").bind(t.slug, t.id));
    }
    const state = optString(args, "state", 20);
    if (state !== undefined) {
      if (!TOPIC_STATES.includes(state)) throw bad("state is open, readonly or archived");
      if (t.id === "board-requests" && state === "archived") throw bad("board-requests stays");
      sets.push("state = ?");
      binds.push(state);
      if (state !== "archived" && t.merged_into) sets.push("merged_into = NULL");
    }
    const pinned = optBool(args, "pinned");
    if (pinned !== undefined) {
      sets.push("pinned = ?");
      binds.push(pinned ? 1 : 0);
    }
    if (sets.length) await ctx.db.batch([ctx.db.prepare(`UPDATE topics SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, t.id), ...stmts]);
    return { topic: topicObj(await topicRow(ctx, t.id)) };
  }),

  "mod.topic.merge": mod("mod.topic.merge", async (ctx, args) => {
    const from = await topicByIdOrSlug(ctx.db, reqString(args, "from", 1, 64));
    const into = await topicByIdOrSlug(ctx.db, reqString(args, "into", 1, 64));
    if (from.id === into.id) throw bad("from and into are the same topic");
    if (from.id === "board-requests" || into.id === "board-requests") throw bad("board-requests can't be merged");
    if (from.merged_into) throw bad("that topic is already merged");
    if (into.state === "archived") throw bad("merge into a topic that isn't archived");
    await ctx.db.batch([
      ctx.db.prepare("UPDATE posts SET topic_id = ? WHERE topic_id = ?").bind(into.id, from.id),
      ctx.db.prepare("INSERT OR IGNORE INTO subscriptions (member, topic_id, created) SELECT member, ?, created FROM subscriptions WHERE topic_id = ?").bind(into.id, from.id),
      ctx.db.prepare("DELETE FROM subscriptions WHERE topic_id = ?").bind(from.id),
      ctx.db.prepare("UPDATE topic_aliases SET topic_id = ? WHERE topic_id = ?").bind(into.id, from.id),
      ctx.db.prepare("UPDATE topics SET state = 'archived', merged_into = ? WHERE id = ?").bind(into.id, from.id),
    ]);
    return { topic: topicObj(await topicRow(ctx, into.id)) };
  }),

  "mod.post.update": mod("mod.post.update", async (ctx, args) => {
    const id = reqId(args, "id");
    const p = await loadPost(ctx, id);
    if (!p || p.state === "removed") throw new ServiceError("not_found", "no such post");
    const sets: string[] = [];
    const binds: unknown[] = [];
    let released = false;
    const state = optString(args, "state", 20);
    if (state !== undefined) {
      if (state !== "visible" && state !== "hidden") throw bad("state is visible or hidden (removing is the operator's)");
      if (p.state === "held" && state === "visible") released = true;
      sets.push("state = ?");
      binds.push(state);
    }
    const pinned = optBool(args, "pinned");
    if (pinned !== undefined) {
      sets.push("pinned = ?");
      binds.push(pinned ? 1 : 0);
    }
    const topic = optString(args, "topic", 32);
    if (topic !== undefined) {
      const t = await topicBySlug(ctx.db, topic);
      if (t.id === "board-requests" || p.topic_id === "board-requests") throw bad("proposals stay in board-requests and posts can't be moved into it");
      sets.push("topic_id = ?");
      binds.push(t.id);
    }
    if (sets.length) await ctx.db.prepare(`UPDATE posts SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
    if (released) await announcePost(ctx, (await loadPost(ctx, id))!);
    return { post: await renderPost(ctx, id) };
  }),

  "mod.queue": mod(
    "mod.queue",
    async (ctx) => {
      const rows = await ctx.db
        .prepare(
          `${POST_SELECT} WHERE p.state = 'held' OR (p.state = 'visible' AND p.proposal IS NOT NULL AND json_extract(p.proposal, '$.decision') IS NULL)
           ORDER BY p.seq LIMIT 50`,
        )
        .bind(ctx.from)
        .all<PostRow>();
      const files = await filesFor(ctx.db, rows.results.map((p) => p.id));
      const posts: Obj[] = [];
      let size = 0;
      for (const p of rows.results) {
        const o = postObj(p, files.get(p.id) ?? [], true);
        size += JSON.stringify(o).length;
        if (posts.length && size > QUEUE_BYTES) break; // the rest is there once these are dealt with
        posts.push(o);
      }
      return { posts };
    },
    { write: false },
  ),

  "mod.release": mod("mod.release", async (ctx, args) => {
    const id = reqId(args, "id");
    const p = await loadPost(ctx, id);
    if (!p || p.state === "removed") throw new ServiceError("not_found", "no such post");
    if (p.state !== "held") throw bad("that post isn't held");
    await ctx.db.prepare("UPDATE posts SET state = 'visible' WHERE id = ?").bind(id).run();
    await announcePost(ctx, (await loadPost(ctx, id))!);
    return { post: await renderPost(ctx, id) };
  }),

  "mod.decide": mod("mod.decide", async (ctx, args) => {
    const id = reqId(args, "id");
    const decision = args.decision;
    if (decision !== "accepted" && decision !== "declined") throw bad('decision is "accepted" or "declined"');
    const note = optString(args, "note", 1000);
    const p = await loadPost(ctx, id);
    if (!p || p.state === "removed" || !p.proposal) throw new ServiceError("not_found", "no such proposal");
    const prop = JSON.parse(p.proposal) as Obj;
    if (prop.decision) throw bad(`that proposal was already ${prop.decision}`);
    if (p.state === "hidden") throw bad("unhide the proposal first");
    let topic: TopicRow | undefined;
    if (decision === "accepted") topic = await createTopic(ctx, String(prop.slug), String(prop.title), String(prop.description));
    const next = { ...prop, decision, ...(note ? { note } : {}) };
    await ctx.db.prepare("UPDATE posts SET proposal = ?, state = 'visible' WHERE id = ?").bind(JSON.stringify(next), id).run();
    const data: Obj = { post: id, decision };
    if (topic) data.topic = topic.slug;
    await ctx.emit(p.author, "decided", data);
    return { post: await renderPost(ctx, id), ...(topic ? { topic: topicObj(topic) } : {}) };
  }),

  "mod.log": mod(
    "mod.log",
    async (ctx, args) => {
      const limit = limitArg(args);
      const where = ["1 = 1"];
      const binds: unknown[] = [];
      const since = timeArg(args, "since");
      if (since !== undefined) {
        where.push("at > ?");
        binds.push(since);
      }
      const cur = decodeCursor(args, 1);
      if (cur) {
        const k = keyset(["seq"], cur, "<");
        where.push(k.sql);
        binds.push(...k.args);
      }
      const rows = await ctx.db.prepare(`SELECT seq, at, by, method, args FROM moderation_log WHERE ${where.join(" AND ")} ORDER BY seq DESC LIMIT ?`).bind(...binds, limit + 1).all<{ seq: number; at: number; by: string; method: string; args: string }>();
      const page = rows.results.slice(0, limit);
      const last = page[page.length - 1];
      return {
        entries: page.map((e) => ({ at: iso(e.at), by: e.by, method: e.method, args: JSON.parse(e.args) })),
        next: rows.results.length > limit && last ? encodeCursor([last.seq]) : null,
      };
    },
    { write: false },
  ),
};
