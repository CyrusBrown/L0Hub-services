// What runs every minute besides the framework's own work: locks that ran out, spaces deleted a week ago, blobs nothing
// needs (hourly), transfer tickets that expired, and members whose seal key changed since their key was made.
import { DELETE_GRACE, ORPHAN_KEEP, UPLOAD_HOLD } from "./env";
import { inSpace } from "./durable";
import { checkRekey, sendEvents } from "./methods";
import type { Ctx } from "./verify";

const GC_EVERY = 3600;
const GC_STATE = "spaces_gc_at";

export async function cron(ctx: Ctx): Promise<void> {
  const { db, now } = ctx;
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      console.error(`cron ${name} failed:`, e);
    }
  };

  await step("locks", async () => {
    const rows = (await db.prepare("SELECT DISTINCT space FROM locks WHERE expires <= ? LIMIT 100").bind(now).all<{ space: string }>()).results;
    for (const r of rows) await sendEvents(ctx, await inSpace(ctx.env, r.space, "locksExpire", { space: r.space, now }));
  });

  await step("drop", async () => {
    const rows = (await db.prepare("SELECT id FROM spaces WHERE deleted_at IS NOT NULL AND deleted_at <= ? LIMIT 20").bind(now - DELETE_GRACE).all<{ id: string }>()).results;
    for (const r of rows) await inSpace(ctx.env, r.id, "drop", { space: r.id, now });
  });

  await step("gc", async () => {
    const last = await db.prepare("SELECT value FROM l0w_state WHERE key = ?").bind(GC_STATE).first<{ value: string }>();
    if (last && now - Number(last.value) < GC_EVERY) return;
    await db.prepare("INSERT INTO l0w_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(GC_STATE, String(now)).run();
    const rows = (await db.prepare("SELECT DISTINCT space FROM blobs WHERE created_at < ? LIMIT 200").bind(now - ORPHAN_KEEP).all<{ space: string }>()).results;
    for (const r of rows) await inSpace(ctx.env, r.space, "gc", { space: r.space, now });
  });

  await step("tickets", async () => {
    await db.prepare("DELETE FROM tickets WHERE expires < ?").bind(now).run();
    await db.prepare("DELETE FROM uploads WHERE started <= ?").bind(now - UPLOAD_HOLD).run(); // reservations of uploads that never finished
  });

  await step("rekey", async () => {
    const rows = (
      await db
        .prepare("SELECT m.space AS space, m.address AS address FROM space_members m JOIN spaces s ON s.id = m.space WHERE s.deleted_at IS NULL ORDER BY m.space, m.address LIMIT 2000")
        .all<{ space: string; address: string }>()
    ).results;
    for (const r of rows) {
      try {
        await checkRekey(ctx, r.space, r.address);
      } catch (e) {
        console.error(`rekey check of ${r.address} failed:`, e); // the hub could not be asked: the next tick tries again
      }
    }
  });
}
