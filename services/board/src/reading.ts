// The read methods: topics.list, posts.list, post.get, file.get, subscriptions, me.
import { ServiceError, type MethodDef, type Obj } from "@l0wservices/core";
import { limitsOf, rolesOf } from "./config";
import { TOPIC_SELECT, POST_SELECT, VISIBLE_SQL, canSee, filesFor, loadPost, postObj, renderPost, topicBySlug, topicObj, type Ctx, type PostRow, type TopicRow } from "./model";
import { dailyLeft, guardWrite, isMod, memberState, watchesOf } from "./shared";
import { bad, decodeCursor, encodeCursor, keyset, limitArg, optBool, optString, reqId, timeArg } from "./util";

type M = MethodDef<import("./config").BoardEnv>;

export const subscriptionSlugs = async (ctx: Ctx, member: string): Promise<string[]> =>
  (
    await ctx.db
      .prepare("SELECT t.slug FROM subscriptions s JOIN topics t ON t.id = s.topic_id WHERE s.member = ? ORDER BY t.slug")
      .bind(member)
      .all<{ slug: string }>()
  ).results.map((r) => r.slug);

export const reading: Record<string, M> = {
  "topics.list": {
    handler: async (ctx, args) => {
      const archived = optBool(args, "archived") ?? false;
      const r = await ctx.db.prepare(`${TOPIC_SELECT} WHERE (? = 1 OR t.state != 'archived') ORDER BY t.pinned DESC, t.slug`).bind(archived ? 1 : 0).all<TopicRow>();
      return { topics: r.results.map(topicObj) };
    },
  },

  "posts.list": {
    handler: async (ctx, args) => {
      const limit = limitArg(args);
      const sort = args.sort === undefined || args.sort === null ? "new" : args.sort;
      if (sort !== "new" && sort !== "top") throw bad('sort is "new" or "top"');
      const where: string[] = [VISIBLE_SQL];
      const binds: unknown[] = [ctx.from, isMod(ctx) ? 1 : 0];
      let byTopic = false;
      if (args.topic !== undefined && args.topic !== null) {
        if (typeof args.topic !== "string") throw bad("topic is a topic slug");
        const t = await topicBySlug(ctx.db, args.topic);
        where.push("p.topic_id = ?");
        binds.push(t.id);
        byTopic = true;
      }
      const since = timeArg(args, "since");
      if (since !== undefined) {
        where.push("p.created > ?");
        binds.push(since);
      }
      const tag = optString(args, "tag", 32);
      if (tag) {
        where.push("EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value = ?)");
        binds.push(tag.toLowerCase());
      }
      const author = optString(args, "author", 320);
      if (author) {
        where.push("p.author = ?");
        binds.push(author.toLowerCase());
      }
      // pinned posts lead inside a topic; across topics only the order asked for counts
      const cols = [...(byTopic ? ["p.pinned"] : []), ...(sort === "top" ? ["p.score"] : []), "p.seq"];
      const cur = decodeCursor(args, cols.length);
      if (cur) {
        const k = keyset(cols, cur, "<");
        where.push(k.sql);
        binds.push(...k.args);
      }
      const rows = await ctx.db
        .prepare(`${POST_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${cols.map((c) => `${c} DESC`).join(", ")} LIMIT ?`)
        .bind(ctx.from, ...binds, limit + 1)
        .all<PostRow>();
      const page = rows.results.slice(0, limit);
      const files = await filesFor(ctx.db, page.map((p) => p.id));
      const last = page[page.length - 1];
      const key = (p: PostRow): number[] => cols.map((c) => (p as unknown as Record<string, number>)[c.slice(2)]);
      return { posts: page.map((p) => postObj(p, files.get(p.id) ?? [], false)), next: rows.results.length > limit && last ? encodeCursor(key(last)) : null };
    },
  },

  "post.get": {
    handler: async (ctx, args) => {
      const id = reqId(args, "id");
      const p = await loadPost(ctx, id);
      if (!p || !canSee(ctx.env, p, ctx.from)) throw new ServiceError("not_found", "no such post");
      return { post: await renderPost(ctx, id) };
    },
  },

  "file.get": {
    handler: async (ctx, args) => {
      const id = reqId(args, "id");
      const f = await ctx.db.prepare("SELECT id, name, type, size, data, owner, post_id FROM files WHERE id = ?").bind(id).first<{ id: string; name: string; type: string; size: number; data: string; owner: string; post_id: string | null }>();
      let ok = false;
      if (f) {
        if (f.owner === ctx.from) ok = true;
        else if (f.post_id) {
          const p = await loadPost(ctx, f.post_id);
          ok = !!p && p.state !== "removed" && canSee(ctx.env, p, ctx.from);
        }
      }
      if (!f || !ok) throw new ServiceError("not_found", "no such file");
      return { file: { id: f.id, name: f.name, type: f.type, size: f.size, data: f.data } };
    },
  },

  subscribe: {
    handler: async (ctx, args) => {
      await guardWrite(ctx, { muted: false });
      if (typeof args.topic !== "string") throw bad("topic is a topic slug");
      const t = await topicBySlug(ctx.db, args.topic);
      await ctx.db.prepare("INSERT OR IGNORE INTO subscriptions (member, topic_id, created) VALUES (?, ?, ?)").bind(ctx.from, t.id, ctx.now).run();
      return { subscriptions: await subscriptionSlugs(ctx, ctx.from) };
    },
  },

  unsubscribe: {
    handler: async (ctx, args) => {
      await guardWrite(ctx, { muted: false });
      if (typeof args.topic !== "string") throw bad("topic is a topic slug");
      const t = await topicBySlug(ctx.db, args.topic);
      await ctx.db.prepare("DELETE FROM subscriptions WHERE member = ? AND topic_id = ?").bind(ctx.from, t.id).run();
      return { subscriptions: await subscriptionSlugs(ctx, ctx.from) };
    },
  },

  subscriptions: {
    handler: async (ctx) => ({ subscriptions: await subscriptionSlugs(ctx, ctx.from), watches: await watchesOf(ctx, ctx.from) }),
  },

  me: {
    handler: async (ctx): Promise<Obj> => {
      const posts = await dailyLeft(ctx, "posts");
      const messages = await dailyLeft(ctx, "messages");
      const files = await dailyLeft(ctx, "files");
      const watches = (await watchesOf(ctx, ctx.from)).length;
      const held = await ctx.db.prepare("SELECT count(*) AS n FROM posts WHERE author = ? AND state = 'held'").bind(ctx.from).first<{ n: number }>();
      const st = await memberState(ctx.db, ctx.from);
      return {
        address: ctx.from,
        roles: rolesOf(ctx.env, ctx.from),
        limits: {
          posts_left_today: posts.left,
          messages_left_today: messages.left,
          watches_left: Math.max(0, limitsOf(ctx.env).maxWatches - watches),
          files_left_today: files.left,
        },
        held_posts: held?.n ?? 0,
        muted: st.muted,
      };
    },
  },
};
