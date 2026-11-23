// Discussions: discuss.list / send / watch / unwatch, and mentions.
import { ServiceError, type MethodDef, type Obj } from "@l0wservices/core";
import { limitsOf, type BoardEnv } from "./config";
import { VISIBLE_SQL, locksAt, messageObj, visiblePost, type Ctx, type MessageRow, type PostRow } from "./model";
import { enforceDaily, guardWrite, isMod, watchesOf } from "./shared";
import { HOUR, MAX_MESSAGE, WATCH_FOR, bad, bytes, decodeCursor, encodeCursor, keyset, limitArg, newId, parseMentions, reqId, reqString, timeArg } from "./util";

type M = MethodDef<BoardEnv>;

const isLocked = (p: PostRow, now: number): boolean => now >= locksAt(p.created);

/** Tell watchers of a discussion: one event per watch per hour; the rest waits for the hourly job. */
async function tellWatchers(ctx: Ctx, p: PostRow, author: string): Promise<void> {
  const ws = await ctx.db
    .prepare("SELECT member, last_event, read_seq FROM watches WHERE post_id = ? AND member != ? AND expires > ?")
    .bind(p.id, author, ctx.now)
    .all<{ member: string; last_event: number; read_seq: number }>();
  for (const w of ws.results) {
    if (ctx.now - w.last_event < HOUR) {
      await ctx.db.prepare("UPDATE watches SET pending = 1 WHERE member = ? AND post_id = ?").bind(w.member, p.id).run();
      continue;
    }
    const n = await ctx.db.prepare("SELECT count(*) AS n FROM messages WHERE post_id = ? AND seq > ? AND author != ?").bind(p.id, w.read_seq, w.member).first<{ n: number }>();
    await ctx.db.prepare("UPDATE watches SET last_event = ?, pending = 0 WHERE member = ? AND post_id = ?").bind(ctx.now, w.member, p.id).run();
    await ctx.emit(w.member, "discussion", { post: p.id, title: p.title, unread: n?.n ?? 0 });
  }
}

export const discussions: Record<string, M> = {
  "discuss.list": {
    handler: async (ctx, args) => {
      const p = await visiblePost(ctx, reqId(args, "post"));
      if (p.state === "removed") throw new ServiceError("not_found", "no such post");
      const limit = limitArg(args);
      const where = ["post_id = ?"];
      const binds: unknown[] = [p.id];
      const since = timeArg(args, "since");
      if (since !== undefined) {
        where.push("created > ?");
        binds.push(since);
      }
      const cur = decodeCursor(args, 1);
      if (cur) {
        const k = keyset(["seq"], cur, ">");
        where.push(k.sql);
        binds.push(...k.args);
      }
      const rows = await ctx.db.prepare(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ?`).bind(...binds, limit + 1).all<MessageRow>();
      const page = rows.results.slice(0, limit);
      const last = page[page.length - 1];
      if (last) await ctx.db.prepare("UPDATE watches SET read_seq = max(read_seq, ?) WHERE member = ? AND post_id = ?").bind(last.seq, ctx.from, p.id).run();
      return { messages: page.map(messageObj), next: rows.results.length > limit && last ? encodeCursor([last.seq]) : null, locked: isLocked(p, ctx.now) };
    },
  },

  "discuss.send": {
    handler: async (ctx, args) => {
      const postId = reqId(args, "post");
      const body = reqString(args, "body", 1, MAX_MESSAGE);
      if (bytes(body) > MAX_MESSAGE) throw bad("body is at most 4 KiB");
      await guardWrite(ctx, { muted: true });
      const p = await visiblePost(ctx, postId);
      if (p.state === "removed") throw new ServiceError("not_found", "no such post");
      const t = await ctx.db.prepare("SELECT state, slug FROM topics WHERE id = ?").bind(p.topic_id).first<{ state: string; slug: string }>();
      if (t && t.state !== "open") throw new ServiceError("readonly", `/${t.slug}/ is ${t.state}`);
      if (isLocked(p, ctx.now)) throw new ServiceError("locked", "the discussion locked 3 days after its post was made");
      await enforceDaily(ctx, "messages");

      const mentions = parseMentions(body, ctx.env.HUB_DOMAIN.trim().toLowerCase()).filter((m) => m !== ctx.from);
      const id = newId();
      const stmts = [
        ctx.db.prepare("INSERT INTO messages (id, post_id, author, body, mentions, created) VALUES (?, ?, ?, ?, ?, ?)").bind(id, p.id, ctx.from, body, JSON.stringify(mentions), ctx.now),
        ctx.db.prepare("UPDATE posts SET msg_count = msg_count + 1, msg_last = ? WHERE id = ?").bind(ctx.now, p.id),
        ctx.db.prepare("UPDATE watches SET expires = min(?, ?) WHERE post_id = ? AND expires > ?").bind(ctx.now + WATCH_FOR, locksAt(p.created), p.id, ctx.now),
        ...mentions.map((m) => ctx.db.prepare("INSERT INTO mentions (member, message_id, post_id, created) VALUES (?, ?, ?, ?)").bind(m, id, p.id, ctx.now)),
      ];
      await ctx.db.batch(stmts);
      const msg = (await ctx.db.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>())!;
      const m = messageObj(msg);
      const topic = t?.slug ?? p.topic_slug;
      for (const who of mentions) await ctx.emit(who, "mention", { message: m, post: { id: p.id, title: p.title, topic } });
      await tellWatchers(ctx, p, ctx.from);
      return { message: m };
    },
  },

  "discuss.watch": {
    handler: async (ctx, args) => {
      await guardWrite(ctx, { muted: false });
      const p = await visiblePost(ctx, reqId(args, "post"));
      if (p.state === "removed") throw new ServiceError("not_found", "no such post");
      if (isLocked(p, ctx.now)) throw new ServiceError("locked", "a locked discussion can't be watched");
      await ctx.db.prepare("DELETE FROM watches WHERE member = ? AND expires <= ?").bind(ctx.from, ctx.now).run();
      const have = await ctx.db.prepare("SELECT 1 AS x FROM watches WHERE member = ? AND post_id = ?").bind(ctx.from, p.id).first();
      const expires = Math.min(ctx.now + WATCH_FOR, locksAt(p.created));
      if (have) {
        await ctx.db.prepare("UPDATE watches SET expires = ? WHERE member = ? AND post_id = ?").bind(expires, ctx.from, p.id).run();
      } else {
        const cap = limitsOf(ctx.env).maxWatches;
        const mine = await ctx.db.prepare("SELECT count(*) AS n, min(expires) AS soonest FROM watches WHERE member = ?").bind(ctx.from).first<{ n: number; soonest: number | null }>();
        if ((mine?.n ?? 0) >= cap) throw new ServiceError("limit", `watches: at most ${cap}`, { retry_after: Math.max(1, (mine?.soonest ?? ctx.now + 1) - ctx.now) });
        const top = await ctx.db.prepare("SELECT coalesce(max(seq), 0) AS s FROM messages WHERE post_id = ?").bind(p.id).first<{ s: number }>();
        await ctx.db.prepare("INSERT INTO watches (member, post_id, since, expires, read_seq) VALUES (?, ?, ?, ?, ?)").bind(ctx.from, p.id, ctx.now, expires, top?.s ?? 0).run();
      }
      return { watches: await watchesOf(ctx, ctx.from) };
    },
  },

  "discuss.unwatch": {
    handler: async (ctx, args) => {
      await guardWrite(ctx, { muted: false });
      await ctx.db.prepare("DELETE FROM watches WHERE member = ? AND post_id = ?").bind(ctx.from, reqId(args, "post")).run();
      return { watches: await watchesOf(ctx, ctx.from) };
    },
  },

  mentions: {
    handler: async (ctx, args) => {
      const limit = limitArg(args);
      const where = ["mn.member = ?", "p.state != 'removed'", VISIBLE_SQL];
      const binds: unknown[] = [ctx.from, ctx.from, isMod(ctx) ? 1 : 0];
      const since = timeArg(args, "since");
      if (since !== undefined) {
        where.push("mn.created > ?");
        binds.push(since);
      }
      const cur = decodeCursor(args, 1);
      if (cur) {
        const k = keyset(["mn.seq"], cur, "<");
        where.push(k.sql);
        binds.push(...k.args);
      }
      const rows = await ctx.db
        .prepare(
          `SELECT mn.seq AS mseq, m.seq, m.id, m.post_id, m.author, m.body, m.mentions, m.created, p.title AS p_title, t.slug AS p_topic
           FROM mentions mn JOIN messages m ON m.id = mn.message_id JOIN posts p ON p.id = mn.post_id JOIN topics t ON t.id = p.topic_id
           WHERE ${where.join(" AND ")} ORDER BY mn.seq DESC LIMIT ?`,
        )
        .bind(...binds, limit + 1)
        .all<MessageRow & { mseq: number; p_title: string; p_topic: string }>();
      const page = rows.results.slice(0, limit);
      const last = page[page.length - 1];
      const out: Obj[] = page.map((r) => ({ message: messageObj(r), post: { id: r.post_id, title: r.p_title, topic: r.p_topic } }));
      return { mentions: out, next: rows.results.length > limit && last ? encodeCursor([last.mseq]) : null };
    },
  },
};
export { tellWatchers };
