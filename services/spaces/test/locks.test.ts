import { b64 } from "@l0w/proto";
import { beforeEach, describe, expect, it } from "vitest";
import { World, type FakeMember } from "./rig";

let w: World;
let mara: FakeMember, ola: FakeMember, pat: FakeMember, zed: FakeMember;
const tag = (n: number) => b64.encode(new Uint8Array(16).fill(n));
const sealed = { nonce: b64.encode(new Uint8Array(12).fill(1)), ct: b64.encode(new Uint8Array(40).fill(2)) };
const secs = (s: unknown) => Math.round(new Date(s as string).getTime() / 1000);

beforeEach(async () => {
  w = await World.make();
  ({ mara, ola, pat, zed } = w.m);
  await w.create(mara, "sp1");
  await w.join(mara, "sp1", ola);
  await w.join(mara, "sp1", pat);
  for (const m of [mara, ola, pat]) await w.events(m);
});

describe("locks", () => {
  it("take: the lock comes back, the others hear, and it is listed", async () => {
    const { lock } = (await w.ok(ola, "lock.take", { space: "sp1", tag: tag(1), sealed })) as { lock: Record<string, unknown> };
    expect(lock).toMatchObject({ tag: tag(1), holder: ola.address, sealed });
    expect(secs(lock.expires) - secs(lock.taken)).toBe(24 * 3600);
    for (const m of [mara, pat]) expect(await w.events(m, "lock")).toEqual([{ event: "lock", data: { space: "sp1", lock, state: "taken" } }]);
    expect(await w.events(ola, "lock")).toEqual([]);
    expect((await w.ok(mara, "locks.list", { space: "sp1" })).locks).toEqual([lock]);
  });

  it("a held lock answers `locked` with the lock; the holder retaking it extends it", async () => {
    const { lock } = (await w.ok(ola, "lock.take", { space: "sp1", tag: tag(1), sealed, ttl_hours: 1 })) as { lock: Record<string, unknown> };
    expect(secs(lock.expires) - secs(lock.taken)).toBe(3600);
    const e = await w.fail(pat, "lock.take", { space: "sp1", tag: tag(1), sealed });
    expect(e).toMatchObject({ code: "locked", lock });
    const again = (await w.ok(ola, "lock.take", { space: "sp1", tag: tag(1), sealed, ttl_hours: 48 })) as { lock: Record<string, unknown> };
    expect(secs(again.lock.expires) - secs(again.lock.taken)).toBe(48 * 3600);
    expect(again.lock.taken).toBe(lock.taken);
    await w.ok(pat, "lock.take", { space: "sp1", tag: tag(2), sealed }); // another file
  });

  it("ttl is at most 72 hours, positive, and a number; tags and sealed are checked", async () => {
    await w.ok(ola, "lock.take", { space: "sp1", tag: tag(1), sealed, ttl_hours: 72 });
    for (const ttl of [73, 0, -1, "24"]) expect((await w.fail(ola, "lock.take", { space: "sp1", tag: tag(2), sealed, ttl_hours: ttl })).code).toBe("bad_args");
    for (const t of ["", "AAAA", 5, tag(1) + "A"]) expect((await w.fail(ola, "lock.take", { space: "sp1", tag: t, sealed })).code).toBe("bad_args");
    for (const s of [undefined, {}, { nonce: "AAAA", ct: "AAAA" }, { nonce: sealed.nonce, ct: 5 }]) expect((await w.fail(ola, "lock.take", { space: "sp1", tag: tag(3), sealed: s })).code).toBe("bad_args");
  });

  it("release: by the holder only; then it can be taken", async () => {
    await w.ok(ola, "lock.take", { space: "sp1", tag: tag(1), sealed });
    await w.events(pat);
    expect((await w.fail(pat, "lock.release", { space: "sp1", tag: tag(1) })).code).toBe("not_allowed");
    expect((await w.fail(mara, "lock.release", { space: "sp1", tag: tag(1) })).code).toBe("not_allowed"); // the creator breaks, it doesn't release
    expect((await w.fail(ola, "lock.release", { space: "sp1", tag: tag(9) })).code).toBe("not_found");
    await w.ok(ola, "lock.release", { space: "sp1", tag: tag(1) });
    expect((await w.events(pat, "lock"))[0].data).toMatchObject({ state: "released", lock: { tag: tag(1), holder: ola.address } });
    await w.ok(pat, "lock.take", { space: "sp1", tag: tag(1), sealed });
  });

  it("break: by the creator only", async () => {
    await w.ok(ola, "lock.take", { space: "sp1", tag: tag(1), sealed });
    await w.events(pat);
    expect((await w.fail(pat, "lock.break", { space: "sp1", tag: tag(1) })).code).toBe("not_allowed");
    expect((await w.fail(ola, "lock.break", { space: "sp1", tag: tag(1) })).code).toBe("not_allowed"); // not even the holder
    await w.ok(mara, "lock.break", { space: "sp1", tag: tag(1) });
    expect((await w.events(pat, "lock"))[0].data).toMatchObject({ state: "broken" });
    expect((await w.events(ola, "lock")).pop()!.data).toMatchObject({ state: "broken" });
    expect((await w.ok(mara, "locks.list", { space: "sp1" })).locks).toEqual([]);
  });

  it("an expired lock is no lock: it isn't listed, and the next taker gets it; the others hear `expired`", async () => {
    await w.ok(ola, "lock.take", { space: "sp1", tag: tag(1), sealed, ttl_hours: 1 });
    await w.events(pat);
    w.db.raw.prepare("UPDATE locks SET taken = taken - 7200, expires = expires - 7200").run();
    expect((await w.ok(pat, "locks.list", { space: "sp1" })).locks).toEqual([]);
    expect((await w.fail(pat, "lock.release", { space: "sp1", tag: tag(1) })).code).toBe("not_found");
    const { lock } = (await w.ok(pat, "lock.take", { space: "sp1", tag: tag(1), sealed })) as { lock: { holder: string } };
    expect(lock.holder).toBe(pat.address);
    expect((await w.events(mara, "lock")).map((e) => e.data.state)).toEqual(["taken", "expired", "taken"]); // ola took it, it ran out, pat took it
  });

  it("the cron clears expired locks and says so", async () => {
    await w.ok(ola, "lock.take", { space: "sp1", tag: tag(1), sealed, ttl_hours: 1 });
    await w.ok(ola, "lock.take", { space: "sp1", tag: tag(2), sealed, ttl_hours: 5 });
    await w.events(mara);
    await w.cron();
    expect(await w.events(mara, "lock")).toEqual([]);
    w.db.raw.prepare("UPDATE locks SET expires = expires - 7200 WHERE tag = ?").run(tag(1));
    await w.cron();
    const ev = await w.events(mara, "lock");
    expect(ev.map((e) => [e.data.state, (e.data.lock as { tag: string }).tag])).toEqual([["expired", tag(1)]]);
    expect(((await w.ok(mara, "locks.list", { space: "sp1" })).locks as unknown[]).length).toBe(1);
  });

  it("leaving drops the member's locks; only members use locks", async () => {
    await w.ok(ola, "lock.take", { space: "sp1", tag: tag(1), sealed });
    await w.ok(ola, "space.leave", { space: "sp1" });
    expect((await w.ok(mara, "locks.list", { space: "sp1" })).locks).toEqual([]);
    expect((await w.fail(zed, "lock.take", { space: "sp1", tag: tag(1), sealed })).code).toBe("not_found");
    expect((await w.fail(zed, "locks.list", { space: "sp1" })).code).toBe("not_found");
    await w.ok(mara, "members.invite", { space: "sp1", member: zed.address, keys: [await w.keyDoc(mara, "sp1", 1, zed)] });
    expect((await w.fail(zed, "lock.take", { space: "sp1", tag: tag(1), sealed })).code).toBe("not_member");
  });
});
