// Cron work: held-back discussion events (every run) and the hourly upkeep.
import type { Ctx } from "./model";
import { ARCHIVE_AFTER, DAY, HOUR } from "./util";

const LOG_KEEP = 365 * DAY;

/** Watches whose event was held back by the once-an-hour rule and now may go. */
export async function flushPending(ctx: Ctx): Promise<number> {
  const rows = await ctx.db
    .prepare(
      `SELECT w.member, w.post_id, p.title, w.read_seq FROM watches w JOIN posts p ON p.id = w.post_id
       WHERE w.pending = 1 AND w.last_event <= ? AND w.expires > ?`,
    )
    .bind(ctx.now - HOUR, ctx.now)
    .all<{ member: string; post_id: string; title: string; read_seq: number }>();
  let sent = 0;
  for (const w of rows.results) {
    const n = await ctx.db.prepare("SELECT count(*) AS n FROM messages WHERE post_id = ? AND seq > ? AND author != ?").bind(w.post_id, w.read_seq, w.member).first<{ n: number }>();
    await ctx.db.prepare("UPDATE watches SET pending = 0, last_event = ? WHERE member = ? AND post_id = ?").bind(ctx.now, w.member, w.post_id).run();
    if ((n?.n ?? 0) > 0) {
      await ctx.emit(w.member, "discussion", { post: w.post_id, title: w.title, unread: n!.n });
      sent++;
    }
  }
  return sent;
}

export interface Hourly {
  filesDropped: number;
  topicsArchived: number;
  watchesDropped: number;
}

/** Unattached files after a day, topics with no post for 90 days, expired watches, the old log. */
export async function hourly(ctx: Ctx): Promise<Hourly> {
  const files = await ctx.db.prepare("DELETE FROM files WHERE post_id IS NULL AND created < ?").bind(ctx.now - DAY).run();
  const topics = await ctx.db
    .prepare(
      `UPDATE topics SET state = 'archived'
       WHERE state IN ('open', 'readonly') AND id != 'board-requests' AND merged_into IS NULL
         AND coalesce((SELECT max(p.created) FROM posts p WHERE p.topic_id = topics.id AND p.state != 'removed'), topics.created) < ?`,
    )
    .bind(ctx.now - ARCHIVE_AFTER)
    .run();
  const watches = await ctx.db.prepare("DELETE FROM watches WHERE expires <= ?").bind(ctx.now).run();
  await ctx.db.prepare("DELETE FROM moderation_log WHERE at < ?").bind(ctx.now - LOG_KEEP).run();
  return { filesDropped: files.meta.changes ?? 0, topicsArchived: topics.meta.changes ?? 0, watchesDropped: watches.meta.changes ?? 0 };
}

/** Every cron run: the held-back events; once an hour (claimed in D1, so isolates don't double up) the upkeep. */
export async function cron(ctx: Ctx): Promise<void> {
  await flushPending(ctx);
  const claim = await ctx.db
    .prepare("INSERT INTO board_state (key, value) VALUES ('hourly_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(board_state.value AS INTEGER) <= ?")
    .bind(String(ctx.now), ctx.now - HOUR)
    .run();
  if ((claim.meta.changes ?? 0) > 0) await hourly(ctx);
}
