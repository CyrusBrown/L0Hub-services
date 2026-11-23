// The operator's admin API on the board's own hostname: `/v0/admin/*`, `Authorization: Bearer <ADMIN_TOKEN>`.
// 404 for everything when ADMIN_TOKEN isn't set. Not part of the protocol (board.md leaves it to the deployment).
import { ensureMigrated } from "@l0wservices/core";
import type { BoardEnv } from "./config";
import { BOARD_MIGRATIONS } from "./migrations";
import { logModeration } from "./mod";
import { isPaused, setState } from "./shared";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, error: string, detail = ""): Response => json({ ok: false, error, detail }, status);

async function sameSecret(a: string, b: string): Promise<boolean> {
  const h = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x, y] = [await h(a), await h(b)];
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export const isAdminPath = (url: URL): boolean => url.pathname === "/v0/admin" || url.pathname.startsWith("/v0/admin/");

async function body(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export async function handleAdmin(req: Request, env: BoardEnv): Promise<Response> {
  if (!env.ADMIN_TOKEN) return fail(404, "not_found");
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !(await sameSecret(auth.slice(7), env.ADMIN_TOKEN))) return fail(401, "unauthorized");
  await ensureMigrated(env.DB, BOARD_MIGRATIONS);
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const parts = new URL(req.url).pathname.split("/").slice(3).map((s) => decodeURIComponent(s)); // after /v0/admin
  const [a, b, c] = parts;
  const log = (method: string, args: Record<string, unknown>) => logModeration(db, now, "operator", method, args);

  if (a === "status" && parts.length === 1) {
    if (req.method !== "GET") return fail(405, "method_not_allowed");
    const n = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
    const muted = await db.prepare("SELECT address FROM member_state WHERE muted = 1 ORDER BY address").all<{ address: string }>();
    return json({
      ok: true,
      paused: await isPaused(db),
      topics: await n("SELECT count(*) AS n FROM topics"),
      posts: await n("SELECT count(*) AS n FROM posts WHERE state != 'removed'"),
      held: await n("SELECT count(*) AS n FROM posts WHERE state = 'held'"),
      muted: muted.results.map((m) => m.address),
    });
  }
  if (req.method !== "POST") return fail(parts.length ? 405 : 404, parts.length ? "method_not_allowed" : "not_found");

  if ((a === "pause" || a === "resume") && parts.length === 1) {
    await setState(db, "paused", a === "pause" ? "1" : null);
    await log(`admin.${a}`, {});
    return json({ ok: true, paused: a === "pause" });
  }

  if (a === "posts" && b && c === "remove" && parts.length === 3) {
    const p = await db.prepare("SELECT state FROM posts WHERE id = ?").bind(b).first<{ state: string }>();
    if (!p) return fail(404, "not_found", "no such post");
    await db.batch([
      db.prepare("UPDATE posts SET state = 'removed', title = '[removed]', body = '', summary = '', tags = '[]', up = 0, down = 0, score = 0, edited = ? WHERE id = ?").bind(now, b),
      db.prepare("DELETE FROM files WHERE post_id = ?").bind(b),
      db.prepare("DELETE FROM votes WHERE post_id = ?").bind(b),
      db.prepare("DELETE FROM watches WHERE post_id = ?").bind(b),
      db.prepare("DELETE FROM mentions WHERE post_id = ?").bind(b),
      db.prepare("DELETE FROM messages WHERE post_id = ?").bind(b),
    ]);
    await log("admin.post.remove", { id: b });
    return json({ ok: true, id: b, state: "removed" });
  }

  if (a === "posts" && b && c === "reset-votes" && parts.length === 3) {
    const r = await db.prepare("SELECT 1 AS x FROM posts WHERE id = ?").bind(b).first();
    if (!r) return fail(404, "not_found", "no such post");
    await db.batch([db.prepare("DELETE FROM votes WHERE post_id = ?").bind(b), db.prepare("UPDATE posts SET up = 0, down = 0, score = 0 WHERE id = ?").bind(b)]);
    await log("admin.post.reset-votes", { id: b });
    return json({ ok: true, id: b });
  }

  if (a === "members" && b && (c === "mute" || c === "unmute") && parts.length === 3) {
    const address = b.toLowerCase();
    if (!address.includes("@")) return fail(400, "bad_args", "the member is an address like name@hub.example");
    const given = (await body(req)).reason;
    const reason = typeof given === "string" ? given.slice(0, 500) : "";
    await db
      .prepare("INSERT INTO member_state (address, muted, muted_reason) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET muted = excluded.muted, muted_reason = excluded.muted_reason")
      .bind(address, c === "mute" ? 1 : 0, c === "mute" ? reason : "")
      .run();
    await log(`admin.member.${c}`, { member: address, ...(reason && c === "mute" ? { reason } : {}) });
    return json({ ok: true, member: address, muted: c === "mute" });
  }

  if (a === "topics" && b && c === "readonly" && parts.length === 3) {
    const readonly = (await body(req)).readonly !== false;
    const t = await db.prepare("SELECT id, state FROM topics WHERE slug = ?").bind(b).first<{ id: string; state: string }>();
    if (!t) return fail(404, "not_found", "no such topic");
    if (readonly) await db.prepare("UPDATE topics SET state = 'readonly' WHERE id = ? AND state = 'open'").bind(t.id).run();
    else await db.prepare("UPDATE topics SET state = 'open' WHERE id = ? AND state = 'readonly'").bind(t.id).run();
    await log("admin.topic.readonly", { slug: b, readonly });
    const now2 = await db.prepare("SELECT state FROM topics WHERE id = ?").bind(t.id).first<{ state: string }>();
    return json({ ok: true, slug: b, state: now2?.state });
  }

  return fail(404, "not_found");
}
