import { b64, docs, seal } from "@l0w/proto";
import { beforeEach, describe, expect, it } from "vitest";
import { UPLOAD_HOLD } from "../src/env";
import { K, World, randomBlobId, stored, versionId, type FakeMember } from "./rig";

let w: World;
let mara: FakeMember, ola: FakeMember, pat: FakeMember, zed: FakeMember;
beforeEach(async () => {
  w = await World.make();
  ({ mara, ola, pat, zed } = w.m);
});

describe("create", () => {
  it("makes a space from the creator's own epoch-1 key", async () => {
    const key = await w.keyDoc(mara, "sp1", 1, mara);
    const { space } = await w.ok(mara, "space.create", { name: "drone-frame", keys: [key] });
    expect(space).toMatchObject({ id: "sp1", name: "drone-frame", creator: "mara@hub.example", epoch: 1, seq: 0, version: null, size: 0, quota: 1073741824, max_file: 99614720 });
    expect(space.members).toEqual([{ address: "mara@hub.example", state: "member", since: expect.stringMatching(/Z$/) }]);
    const keys = await w.ok(mara, "keys.get", { space: "sp1" });
    expect(keys.keys).toEqual([key]);
    // the key really is HPKE to mara's seal key: only mara's gateway could open it
    const p = JSON.parse(b64.fromUtf8(b64.decode((key as { payload: string }).payload)));
    const info = b64.utf8(`l0wagent-space-key/1\nsp1\n1\n${mara.address}\n${mara.seal.kid}\n${mara.address}\n${mara.sign.kid}`);
    expect(seal.openSealed(mara.seal.private, p.sealed, info)).toEqual(K(1));
  });

  it("refuses a key that is not the creator's own, not epoch 1, not signed by the creator's current key, or tampered", async () => {
    const bad = async (key: unknown, code: string, name = "x1") => {
      const e = await w.fail(mara, "space.create", { name, keys: [key] });
      expect(e.code).toBe(code);
    };
    await bad(await w.keyDoc(mara, "a1", 1, ola), "bad_args");
    await bad(await w.keyDoc(mara, "a1", 2, mara), "bad_args");
    await bad(await w.keyDoc(ola, "a1", 1, mara), "bad_signature"); // signed by ola, not by the caller's key
    await bad(await w.keyDoc(mara, "a1", 1, mara, K(), { mutate: (p) => (p.granter = ola.address) }), "bad_document"); // granter is not the creator
    await bad(await w.keyDoc(mara, "a1", 1, mara, K(), { granterKey: ola.sign }), "bad_signature");
    const t = await w.keyDoc(mara, "a1", 1, mara);
    await bad({ ...t, payload: t.payload.slice(0, -2) + "AA" }, "bad_signature");
    await bad(await w.keyDoc(mara, "a1", 1, mara, K(), { mutate: (p) => (p.sealed = { alg: "nope", enc: "a", ct: "b" }) }), "bad_document");
    await bad(await w.keyDoc(mara, "a/b", 1, mara), "bad_document"); // not a space id
    expect((await w.ok(mara, "spaces.list")).spaces).toEqual([]);
  });

  it("checks the signature against the creator's CURRENT signing key", async () => {
    const old = await w.keyDoc(mara, "r1", 1, mara);
    await mara.rotateSign("mara/sign2");
    expect((await w.fail(mara, "space.create", { name: "ab", keys: [old] })).code).toBe("bad_signature");
    await w.ok(mara, "space.create", { name: "ab", keys: [await w.keyDoc(mara, "r1", 1, mara)] });
  });

  it("names are slugs, unique per creator; ids are unique; spaces per creator are limited", async () => {
    expect((await w.fail(mara, "space.create", { name: "Bad Name", keys: [await w.keyDoc(mara, "n1", 1, mara)] })).code).toBe("bad_args");
    expect((await w.fail(mara, "space.create", { name: "a", keys: [await w.keyDoc(mara, "n1", 1, mara)] })).code).toBe("bad_args");
    await w.create(mara, "n1", "same");
    expect((await w.fail(mara, "space.create", { name: "same", keys: [await w.keyDoc(mara, "n2", 1, mara)] })).code).toBe("exists");
    expect((await w.fail(ola, "space.create", { name: "other", keys: [await w.keyDoc(ola, "n1", 1, ola)] })).code).toBe("exists"); // the id is taken
    await w.create(ola, "o1", "same"); // another creator may use the name
    w = await World.make({ MAX_SPACES_PER_CREATOR: "2" });
    ({ mara } = w.m);
    await w.create(mara, "l1", "one");
    await w.create(mara, "l2", "two");
    const e = await w.fail(mara, "space.create", { name: "three", keys: [await w.keyDoc(mara, "l3", 1, mara)] });
    expect(e.code).toBe("limit_reached");
    await w.ok(mara, "space.delete", { space: "l1" }); // a deleted space frees its slot and its name
    await w.create(mara, "l4", "one");
  });
});

describe("members", () => {
  beforeEach(async () => {
    await w.create(mara, "sp1");
  });

  it("invite -> invited event; accept -> members event; the invitee sees the space only after accepting its keys", async () => {
    const key = await w.keyDoc(mara, "sp1", 1, ola);
    const r = await w.ok(mara, "members.invite", { space: "sp1", member: ola.address, keys: [key] });
    expect((r.space as { members: unknown[] }).members).toContainEqual({ address: ola.address, state: "invited", since: expect.any(String) });
    expect(await w.events(ola, "invited")).toEqual([{ event: "invited", data: { space: "sp1", name: "frame", creator: mara.address } }]);
    expect((await w.ok(ola, "spaces.list")).spaces).toHaveLength(1);
    expect((await w.fail(ola, "keys.get", { space: "sp1" })).code).toBe("not_member"); // not before the owner accepts
    expect((await w.fail(ola, "head", { space: "sp1" })).code).toBe("not_member");
    await w.ok(ola, "space.accept", { space: "sp1" });
    expect((await w.ok(ola, "keys.get", { space: "sp1" })).keys).toEqual([key]);
    const ev = await w.events(mara, "members");
    expect(ev).toHaveLength(1);
    expect(ev[0].data.members).toContainEqual({ address: ola.address, state: "member", since: expect.any(String) });
    expect((await w.ok(ola, "head", { space: "sp1" }))).toEqual({ seq: 0, version: null });
  });

  it("only the creator invites; the key must be for this space, this member and the current epoch; the invitee must be a hub member", async () => {
    await w.join(mara, "sp1", ola);
    const k = await w.keyDoc(mara, "sp1", 1, pat);
    expect((await w.fail(zed, "members.invite", { space: "sp1", member: pat.address, keys: [k] })).code).toBe("not_found");
    expect((await w.fail(ola, "members.invite", { space: "sp1", member: pat.address, keys: [await w.keyDoc(ola, "sp1", 1, pat)] })).code).toBe("not_allowed");
    expect((await w.fail(mara, "members.invite", { space: "sp1", member: ola.address, keys: [k] })).code).toBe("bad_args");
    expect((await w.fail(mara, "members.invite", { space: "sp1", member: pat.address, keys: [await w.keyDoc(mara, "sp1", 2, pat)] })).code).toBe("bad_epoch"); // epoch 2 doesn't exist yet
    const ghost = await (await import("./rig")).FakeMember.make("ghost");
    expect((await w.fail(mara, "members.invite", { space: "sp1", member: ghost.address, keys: [await w.keyDoc(mara, "sp1", 1, ghost)] })).code).toBe("unknown_member");
    expect((await w.fail(mara, "members.invite", { space: "nope", member: pat.address, keys: [k] })).code).toBe("not_found");
  });

  it("an invitation carries a key for every epoch 1..current, one each, all for the invitee", async () => {
    await w.join(mara, "sp1", ola);
    await w.join(mara, "sp1", pat);
    const keys2 = [await w.keyDoc(mara, "sp1", 2, mara, K(2)), await w.keyDoc(mara, "sp1", 2, pat, K(2))];
    await w.ok(mara, "members.remove", { space: "sp1", member: ola.address, keys: keys2 });
    const inv = (keys: unknown[]) => w.fail(mara, "members.invite", { space: "sp1", member: zed.address, keys });
    expect(await inv([await w.keyDoc(mara, "sp1", 2, zed)])).toMatchObject({ code: "missing_keys", epochs: [1] });
    expect(await inv([await w.keyDoc(mara, "sp1", 1, zed)])).toMatchObject({ code: "missing_keys", epochs: [2] });
    expect(await inv([])).toMatchObject({ code: "missing_keys", epochs: [1, 2] });
    expect((await inv([...(await w.keysFor(mara, "sp1", zed, 2)), await w.keyDoc(mara, "sp1", 2, zed)])).code).toBe("bad_args"); // two for epoch 2
    expect((await inv([await w.keyDoc(mara, "sp1", 1, zed), await w.keyDoc(mara, "sp1", 2, pat)])).code).toBe("bad_args"); // one is for pat
    expect((await inv([await w.keyDoc(mara, "sp1", 1, zed), await w.keyDoc(mara, "sp1", 3, zed)])).code).toBe("bad_epoch");
    await w.join(mara, "sp1", zed, 2);
    const got = (await w.ok(zed, "keys.get", { space: "sp1" })).keys as Array<{ payload: string }>;
    expect(got.map((d) => JSON.parse(b64.fromUtf8(b64.decode(d.payload))).epoch)).toEqual([1, 2]);
  });

  it("decline drops the invitation and its key; a member can't be invited twice; the creator can't leave", async () => {
    await w.ok(mara, "members.invite", { space: "sp1", member: ola.address, keys: [await w.keyDoc(mara, "sp1", 1, ola)] });
    await w.ok(ola, "space.decline", { space: "sp1" });
    expect((await w.ok(ola, "spaces.list")).spaces).toEqual([]);
    expect((await w.fail(ola, "space.accept", { space: "sp1" })).code).toBe("not_found");
    await w.join(mara, "sp1", ola);
    expect((await w.fail(mara, "members.invite", { space: "sp1", member: ola.address, keys: [await w.keyDoc(mara, "sp1", 1, ola)] })).code).toBe("exists");
    expect((await w.fail(mara, "space.leave", { space: "sp1" })).code).toBe("not_allowed");
  });

  it("leave: the member goes, its keys and locks with it, the others hear", async () => {
    await w.join(mara, "sp1", ola);
    await w.ok(mara, "space.get", { space: "sp1" });
    await w.events(mara);
    await w.ok(ola, "space.leave", { space: "sp1" });
    expect((await w.fail(ola, "space.get", { space: "sp1" })).code).toBe("not_found");
    const ev = await w.events(mara, "members");
    expect(ev[0].data.members).toEqual([expect.objectContaining({ address: mara.address })]);
    expect(w.db.raw.prepare("SELECT count(*) AS n FROM space_keys WHERE member = ?").get(ola.address)).toEqual({ n: 0 });
  });

  it("members per space are limited", async () => {
    w = await World.make({ MAX_MEMBERS_PER_SPACE: "2" });
    ({ mara, ola, pat } = w.m);
    await w.create(mara, "m1");
    await w.join(mara, "m1", ola);
    const e = await w.fail(mara, "members.invite", { space: "m1", member: pat.address, keys: [await w.keyDoc(mara, "m1", 1, pat)] });
    expect(e.code).toBe("limit_reached");
  });

  it("keys.get returns only the caller's documents", async () => {
    await w.join(mara, "sp1", ola);
    await w.join(mara, "sp1", pat);
    const mine = (await w.ok(ola, "keys.get", { space: "sp1" })).keys as Array<{ payload: string }>;
    expect(mine).toHaveLength(1);
    expect(JSON.parse(b64.fromUtf8(b64.decode(mine[0].payload))).member).toBe(ola.address);
    expect(((await w.ok(mara, "keys.get", { space: "sp1" })).keys as unknown[]).length).toBe(1);
    expect((await w.fail(zed, "keys.get", { space: "sp1" })).code).toBe("not_found");
  });
});

describe("remove and epochs", () => {
  beforeEach(async () => {
    await w.create(mara, "sp1");
    await w.join(mara, "sp1", ola);
    await w.join(mara, "sp1", pat);
    await w.events(mara);
    await w.events(ola);
    await w.events(pat);
  });

  const keysAt2 = async (...to: FakeMember[]) => Promise.all(to.map((t) => w.keyDoc(mara, "sp1", 2, t, K(2))));

  it("removing a member needs a new-epoch key for every remaining member, starts epoch 2, clears locks, and says so", async () => {
    const tag = b64.encode(new Uint8Array(16).fill(5));
    await w.ok(ola, "lock.take", { space: "sp1", tag, sealed: { nonce: b64.encode(new Uint8Array(12)), ct: "AAAA" } });
    const r = await w.ok(mara, "members.remove", { space: "sp1", member: ola.address, keys: await keysAt2(mara, pat) });
    expect(r.space).toMatchObject({ epoch: 2 });
    expect((r.space as { members: Array<{ address: string }> }).members.map((m) => m.address).sort()).toEqual([mara.address, pat.address]);
    expect(await w.events(ola, "removed")).toEqual([{ event: "removed", data: { space: "sp1" } }]);
    expect((await w.events(pat)).map((e) => e.event).filter((e) => e !== "lock").sort()).toEqual(["epoch", "members"]);
    expect((await w.fail(ola, "head", { space: "sp1" })).code).toBe("not_found");
    expect((await w.ok(mara, "locks.list", { space: "sp1" })).locks).toEqual([]);
    expect(((await w.ok(pat, "keys.get", { space: "sp1" })).keys as unknown[]).length).toBe(2); // epochs 1 and 2
    expect(w.db.raw.prepare("SELECT count(*) AS n FROM space_keys WHERE member = ?").get(ola.address)).toEqual({ n: 0 });
  });

  it("refuses when a remaining member's key is missing, doubled, for a stranger or for the wrong epoch", async () => {
    let e = await w.fail(mara, "members.remove", { space: "sp1", member: ola.address, keys: await keysAt2(mara) });
    expect(e).toMatchObject({ code: "missing_keys", members: [pat.address] });
    e = await w.fail(mara, "members.remove", { space: "sp1", member: ola.address, keys: [...(await keysAt2(mara, pat)), ...(await keysAt2(pat))] });
    expect(e.code).toBe("bad_args");
    e = await w.fail(mara, "members.remove", { space: "sp1", member: ola.address, keys: [...(await keysAt2(mara, pat)), ...(await keysAt2(zed))] });
    expect(e.code).toBe("bad_args");
    e = await w.fail(mara, "members.remove", { space: "sp1", member: ola.address, keys: [await w.keyDoc(mara, "sp1", 1, mara), await w.keyDoc(mara, "sp1", 1, pat)] });
    expect(e.code).toBe("bad_epoch");
    expect((await w.ok(mara, "space.get", { space: "sp1" })).space).toMatchObject({ epoch: 1 });
    expect((await w.ok(ola, "head", { space: "sp1" })).seq).toBe(0); // nothing changed
  });

  it("only the creator removes; not the creator; not a stranger; an invitation is withdrawn without a new epoch", async () => {
    expect((await w.fail(ola, "members.remove", { space: "sp1", member: pat.address, keys: [] })).code).toBe("not_allowed");
    expect((await w.fail(mara, "members.remove", { space: "sp1", member: mara.address, keys: [] })).code).toBe("bad_args");
    expect((await w.fail(mara, "members.remove", { space: "sp1", member: zed.address, keys: [] })).code).toBe("not_found");
    await w.ok(mara, "members.invite", { space: "sp1", member: zed.address, keys: [await w.keyDoc(mara, "sp1", 1, zed)] });
    await w.ok(mara, "members.remove", { space: "sp1", member: zed.address, keys: [] });
    expect((await w.ok(mara, "space.get", { space: "sp1" })).space).toMatchObject({ epoch: 1 });
    expect((await w.ok(zed, "spaces.list")).spaces).toEqual([]);
  });

  it("an invitee still invited when the epoch changes needs a new-epoch key too", async () => {
    await w.ok(mara, "members.invite", { space: "sp1", member: zed.address, keys: [await w.keyDoc(mara, "sp1", 1, zed)] });
    expect((await w.fail(mara, "members.remove", { space: "sp1", member: ola.address, keys: await keysAt2(mara, pat) })).members).toEqual([zed.address]);
    await w.ok(mara, "members.remove", { space: "sp1", member: ola.address, keys: await keysAt2(mara, pat, zed) });
    await w.ok(zed, "space.accept", { space: "sp1" });
    expect(((await w.ok(zed, "keys.get", { space: "sp1" })).keys as unknown[]).length).toBe(2);
  });

  it("a push at the old epoch is a conflict, and a push at the new epoch works", async () => {
    const old = await w.versionDoc(pat, "sp1", 1, null, 1, []);
    await w.ok(mara, "members.remove", { space: "sp1", member: ola.address, keys: await keysAt2(mara, pat) });
    const e = await w.fail(pat, "version.push", { space: "sp1", version: old });
    expect(e).toMatchObject({ code: "conflict", head: { seq: 0, version: null } });
    expect(await w.push(pat, "sp1")).toMatchObject({ seq: 1 });
  });

  it("keys.put re-grants: creator only, for members, for epochs they were in; and a rotated seal key is flagged with rekey", async () => {
    const fresh = await w.keyDoc(mara, "sp1", 1, ola, K(1));
    expect((await w.fail(ola, "keys.put", { space: "sp1", keys: [fresh] })).code).toBe("not_allowed");
    expect((await w.fail(mara, "keys.put", { space: "sp1", keys: [await w.keyDoc(mara, "sp1", 1, zed)] })).code).toBe("not_member");
    expect((await w.fail(mara, "keys.put", { space: "sp1", keys: [await w.keyDoc(mara, "sp1", 2, ola)] })).code).toBe("bad_epoch");
    await w.ok(mara, "keys.put", { space: "sp1", keys: [fresh] });
    expect(((await w.ok(ola, "keys.get", { space: "sp1" })).keys as unknown[]).length).toBe(1);
  });
});

describe("rekey", () => {
  it("tells the creator when a member's seal key changed, once per key; keys.put clears it", async () => {
    await w.create(mara, "sp1");
    await w.join(mara, "sp1", ola);
    await w.events(mara);
    await w.cron();
    expect(await w.events(mara, "rekey")).toEqual([]);
    // ola rotates its seal key (a new self document at a higher seq); the directory cache expires
    await w.rotateSeal(ola, "ola/seal2");
    await w.ok(ola, "keys.get", { space: "sp1" }); // the call itself notices
    expect(await w.events(mara, "rekey")).toEqual([{ event: "rekey", data: { space: "sp1", member: ola.address } }]);
    w.db.raw.prepare("UPDATE l0w_directory SET fetched_at = 0").run();
    await w.cron(); // not again for the same key
    await w.ok(ola, "keys.get", { space: "sp1" });
    expect(await w.events(mara, "rekey")).toEqual([]);
    await w.ok(mara, "keys.put", { space: "sp1", keys: [await w.keyDoc(mara, "sp1", 1, ola)] });
    w.db.raw.prepare("UPDATE l0w_directory SET fetched_at = 0").run();
    await w.cron();
    expect(await w.events(mara, "rekey")).toEqual([]);
  });

  it("the cron finds it too", async () => {
    await w.create(mara, "sp1");
    await w.join(mara, "sp1", pat);
    await w.events(mara);
    await w.rotateSeal(pat, "pat/seal2");
    await w.cron();
    expect(await w.events(mara, "rekey")).toEqual([{ event: "rekey", data: { space: "sp1", member: pat.address } }]);
  });
});

describe("delete", () => {
  it("the creator deletes: members hear `deleted`, the space is gone at once, and dropped after 7 days with its blobs", async () => {
    await w.create(mara, "sp1");
    await w.join(mara, "sp1", ola);
    const b = randomBlobId();
    expect((await w.upload(mara, "sp1", b, stored(100))).status).toBe(201);
    await w.push(mara, "sp1", [b]);
    await w.events(ola);
    expect((await w.fail(ola, "space.delete", { space: "sp1" })).code).toBe("not_allowed");
    await w.ok(mara, "space.delete", { space: "sp1" });
    expect(await w.events(ola, "deleted")).toEqual([{ event: "deleted", data: { space: "sp1" } }]);
    expect((await w.fail(ola, "head", { space: "sp1" })).code).toBe("not_found");
    expect((await w.ok(mara, "spaces.list")).spaces).toEqual([]);
    await w.cron();
    expect(w.r2.objects.has(`sp1/${b}`)).toBe(true); // a week's grace
    w.db.raw.prepare("UPDATE spaces SET deleted_at = deleted_at - 8 * 24 * 3600").run();
    await w.cron();
    expect(w.r2.objects.size).toBe(0);
    for (const t of ["spaces", "space_members", "space_keys", "versions", "version_blobs", "blobs"]) {
      expect(w.db.raw.prepare(`SELECT count(*) AS n FROM ${t}`).get()).toEqual({ n: 0 });
    }
  });
});

describe("versions", () => {
  beforeEach(async () => {
    await w.create(mara, "sp1");
    await w.join(mara, "sp1", ola);
    await w.events(mara);
    await w.events(ola);
  });

  it("a chain of pushes: ids are the hash of the payload string, head and list follow, the others hear `head`", async () => {
    const b1 = randomBlobId();
    expect((await w.upload(mara, "sp1", b1, stored(50))).status).toBe(201);
    const d1 = await w.versionDoc(mara, "sp1", 1, null, 1, [b1]);
    const r1 = await w.ok(mara, "version.push", { space: "sp1", version: d1 });
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(d1.payload)));
    expect(r1).toEqual({ seq: 1, version: "v." + b64.encode(hash.subarray(0, 16)) });
    expect(await versionId(d1)).toBe(r1.version);
    expect(await w.events(ola, "head")).toEqual([{ event: "head", data: { space: "sp1", seq: 1, version: r1.version, author: mara.address } }]);
    expect(await w.events(mara, "head")).toEqual([]);
    const r2 = await w.push(ola, "sp1", [b1]);
    expect(r2.seq).toBe(2);
    expect(await w.ok(mara, "head", { space: "sp1" })).toEqual({ seq: 2, version: r2.version });
    const list = await w.ok(mara, "versions.list", { space: "sp1" });
    expect((list.versions as unknown[]).length).toBe(2);
    expect(list.next).toBeNull();
    expect((list.versions as Array<{ payload: string }>)[0]).toEqual(d1); // as it was signed
    const part = await w.ok(mara, "versions.list", { space: "sp1", after: 1, limit: 1 });
    expect(part.versions).toHaveLength(1);
    expect(JSON.parse(b64.fromUtf8(b64.decode((part.versions as Array<{ payload: string }>)[0].payload))).seq).toBe(2);
    expect((await w.ok(mara, "versions.list", { space: "sp1", limit: 1 })).next).toBe(1);
    expect((await w.ok(mara, "space.get", { space: "sp1" })).space).toMatchObject({ seq: 2, version: r2.version, size: 50 });
  });

  it("a second push on the same head loses: conflict with the head; a replay of the winner is a success", async () => {
    const a = await w.versionDoc(mara, "sp1", 1, null, 1, []);
    const b = await w.versionDoc(ola, "sp1", 1, null, 1, []);
    const [ra, rb] = await Promise.all([w.call(mara, "version.push", { space: "sp1", version: a }), w.call(ola, "version.push", { space: "sp1", version: b })]);
    const won = [ra, rb].filter((r) => r.ok);
    const lost = [ra, rb].filter((r) => !r.ok);
    expect(won).toHaveLength(1);
    expect(lost[0].error).toMatchObject({ code: "conflict", head: { seq: 1, version: won[0].result!.version } });
    const winner = ra.ok ? { m: mara, d: a } : { m: ola, d: b };
    expect(await w.ok(winner.m, "version.push", { space: "sp1", version: winner.d })).toEqual(won[0].result);
    expect((await w.ok(mara, "head", { space: "sp1" })).seq).toBe(1);
  });

  it("a wrong seq or parent is a conflict with the head", async () => {
    await w.push(mara, "sp1");
    for (const d of [await w.versionDoc(mara, "sp1", 1, null, 1, []), await w.versionDoc(mara, "sp1", 3, "v.AAAAAAAAAAAAAAAAAAAAAA", 1, []), await w.versionDoc(mara, "sp1", 2, "v.AAAAAAAAAAAAAAAAAAAAAA", 1, [])]) {
      const e = await w.fail(mara, "version.push", { space: "sp1", version: d });
      expect(e).toMatchObject({ code: "conflict", head: { seq: 1 } });
    }
  });

  it("refuses a version whose blob is not stored, naming it", async () => {
    const have = randomBlobId();
    const lacks = randomBlobId();
    await w.upload(mara, "sp1", have, stored(30));
    const e = await w.fail(mara, "version.push", { space: "sp1", version: await w.versionDoc(mara, "sp1", 1, null, 1, [have, lacks]) });
    expect(e).toMatchObject({ code: "missing_blobs", missing: [lacks] });
    expect((await w.ok(mara, "head", { space: "sp1" })).seq).toBe(0);
  });

  it("refuses a bad signature, a document by someone else, a stranger and an invitee", async () => {
    const good = await w.versionDoc(mara, "sp1", 1, null, 1, []);
    expect((await w.fail(mara, "version.push", { space: "sp1", version: await w.versionDoc(mara, "sp1", 1, null, 1, [], { signer: ola.sign }) })).code).toBe("bad_signature");
    expect((await w.fail(mara, "version.push", { space: "sp1", version: { ...good, payload: good.payload.slice(0, -2) + "AA" } })).code).toBe("bad_signature");
    expect((await w.fail(ola, "version.push", { space: "sp1", version: good })).code).toBe("bad_signature"); // mara's document, sent by ola: not signed by ola's key
    expect((await w.fail(zed, "version.push", { space: "sp1", version: await w.versionDoc(zed, "sp1", 1, null, 1, []) })).code).toBe("not_found");
    await w.ok(mara, "members.invite", { space: "sp1", member: pat.address, keys: [await w.keyDoc(mara, "sp1", 1, pat)] });
    expect((await w.fail(pat, "version.push", { space: "sp1", version: await w.versionDoc(pat, "sp1", 1, null, 1, []) })).code).toBe("not_member");
    expect((await w.fail(mara, "version.push", { space: "other", version: good })).code).toBe("bad_args");
    expect((await w.fail(mara, "version.push", { space: "sp1", version: await w.versionDoc(mara, "sp1", 1, null, 1, [], { mutate: (p) => (p.parent = "v.AAAAAAAAAAAAAAAAAAAAAA") }) })).code).toBe("bad_document");
    expect((await w.fail(mara, "version.push", { space: "sp1", version: await w.versionDoc(mara, "sp1", 1, null, 1, [], { mutate: (p) => (p.blobs = [randomBlobId(), randomBlobId()].sort().reverse()) }) })).code).toBe("bad_document");
    expect((await w.fail(mara, "version.push", { space: "sp1", version: await w.versionDoc(mara, "sp1", 1, null, 1, [], { mutate: (p) => (p.blobs = [randomBlobId(3)]) }) })).code).toBe("bad_document");
    expect((await w.fail(mara, "version.push", { space: "sp1", version: { ...good, sigs: [...good.sigs!, ...good.sigs!] } })).code).toBe("bad_signature");
    expect((await w.ok(mara, "head", { space: "sp1" })).seq).toBe(0);
  });

  it("the quota counts distinct live blobs; one blob in many versions counts once", async () => {
    w = await World.make({ QUOTA_BYTES: "200" });
    ({ mara } = w.m);
    await w.create(mara, "q1");
    const [a, b, c] = [randomBlobId(), randomBlobId(), randomBlobId()];
    expect((await w.upload(mara, "q1", a, stored(100))).status).toBe(201);
    expect((await w.upload(mara, "q1", b, stored(100))).status).toBe(201);
    await w.push(mara, "q1", [a, b]);
    await w.push(mara, "q1", [a, b]); // the same two again: still 200
    expect((await w.ok(mara, "space.get", { space: "q1" })).space).toMatchObject({ size: 200, quota: 200 });
    // the upload itself is refused when the space is full
    const up = await w.ok(mara, "blob.upload", { space: "q1", id: c, size: 50 });
    const res = await w.put(up.url as string, stored(50));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("quota_exceeded");
  });

  it("TOTAL_BYTES caps everything stored across spaces; uploads in flight count, stale ones don't", async () => {
    w = await World.make({ TOTAL_BYTES: "250", QUOTA_BYTES: "1000" });
    ({ mara } = w.m);
    await w.create(mara, "t1");
    await w.create(mara, "t2", "other");
    expect((await w.upload(mara, "t1", randomBlobId(), stored(100))).status).toBe(201);
    expect((await w.upload(mara, "t2", randomBlobId(), stored(100))).status).toBe(201);
    const uploads = () => w.db.raw.prepare("SELECT space, id, size, started FROM uploads").all() as { size: number }[];
    expect(uploads()).toEqual([]); // a committed upload's reservation is gone
    // another space, same total: refused before anything is written
    const res = await w.upload(mara, "t2", randomBlobId(), stored(100));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: "quota_exceeded" });
    expect(uploads()).toEqual([]);
    expect((await w.env.BLOBS.list({ prefix: "t2/" })).objects).toHaveLength(1);
    // an upload in flight holds its bytes
    const now = Math.floor(Date.now() / 1000);
    w.db.raw.prepare("INSERT INTO uploads (space, id, size, started) VALUES ('t1', 'x', 40, ?)").run(now);
    expect((await w.upload(mara, "t1", randomBlobId(), stored(40))).status).toBe(413);
    // one that never finished stops counting after UPLOAD_HOLD, and the cron drops it
    w.db.raw.prepare("UPDATE uploads SET started = ?").run(now - UPLOAD_HOLD - 1);
    expect((await w.upload(mara, "t1", randomBlobId(), stored(40))).status).toBe(201);
    await w.cron();
    expect(uploads()).toEqual([]);
  });

  it("the push itself checks the quota (a lowered quota stops growth)", async () => {
    const a = randomBlobId();
    await w.upload(mara, "sp1", a, stored(100));
    w.env.QUOTA_BYTES = "50";
    w.ns.objects.clear(); // the Space objects read their limits when made
    const e = await w.fail(mara, "version.push", { space: "sp1", version: await w.versionDoc(mara, "sp1", 1, null, 1, [a]) });
    expect(e).toMatchObject({ code: "quota_exceeded", quota: 50 });
  });
});

describe("call hygiene", () => {
  it("arguments are checked", async () => {
    expect((await w.fail(mara, "head", {})).code).toBe("bad_args");
    expect((await w.fail(mara, "head", { space: "a/b" })).code).toBe("bad_args");
    expect((await w.fail(mara, "head", { space: "nope" })).code).toBe("not_found");
    expect((await w.fail(mara, "no.such", {})).code).toBe("unknown_method");
    expect(docs).toBeTruthy();
  });
});
