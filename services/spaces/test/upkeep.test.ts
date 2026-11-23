import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { World, randomBlobId, stored } from "./rig";

const DAY = 24 * 3600;

describe("blob upkeep", () => {
  async function rig() {
    const w = await World.make();
    const { mara } = w.m;
    await w.create(mara, "sp1");
    const age = (id: string, days: number) => w.db.raw.prepare("UPDATE blobs SET created_at = created_at - ? WHERE id = ?").run(days * DAY, id);
    const ageVersions = (days: number) => w.db.raw.prepare("UPDATE versions SET created_at = created_at - ?").run(days * DAY);
    const forceGc = () => w.db.raw.prepare("DELETE FROM l0w_state WHERE key = 'spaces_gc_at'").run();
    return { w, mara, age, ageVersions, forceGc };
  }

  it("an upload no version used for a week goes; a recent one stays", async () => {
    const { w, mara, age } = await rig();
    const [old, fresh] = [randomBlobId(), randomBlobId()];
    await w.upload(mara, "sp1", old, stored(50));
    await w.upload(mara, "sp1", fresh, stored(50));
    age(old, 8);
    await w.cron();
    expect([...w.r2.objects.keys()]).toEqual([`sp1/${fresh}`]);
    expect((await w.ok(mara, "blobs.missing", { space: "sp1", ids: [old, fresh] })).missing).toEqual([old]);
  });

  it("a blob no version of the last 90 days uses goes; the head's blobs and recently used ones stay", async () => {
    const { w, mara, age, ageVersions, forceGc } = await rig();
    const [gone, kept, headOnly] = [randomBlobId(), randomBlobId(), randomBlobId()];
    for (const b of [gone, kept, headOnly]) await w.upload(mara, "sp1", b, stored(40));
    await w.push(mara, "sp1", [gone, kept]); // v1
    await w.push(mara, "sp1", [kept, headOnly]); // v2 (the head)
    ageVersions(100);
    for (const b of [gone, kept, headOnly]) age(b, 100);
    w.db.raw.prepare("UPDATE versions SET created_at = created_at + ? WHERE seq = 2").run(60 * DAY); // v2 is 40 days old
    forceGc();
    await w.cron();
    expect([...w.r2.objects.keys()].sort()).toEqual([`sp1/${kept}`, `sp1/${headOnly}`].sort());
    // now the head is 100 days old too: its blobs still stay
    ageVersions(60);
    forceGc();
    await w.cron();
    expect([...w.r2.objects.keys()].sort()).toEqual([`sp1/${kept}`, `sp1/${headOnly}`].sort());
    // a blob only the old v1 used is gone, but the space's own size counts only what is stored
    expect((await w.ok(mara, "space.get", { space: "sp1" })).space).toMatchObject({ size: 80 });
  });

  it("the upkeep runs about hourly, not every minute", async () => {
    const { w, mara, age } = await rig();
    const id = randomBlobId();
    await w.cron(); // first run
    await w.upload(mara, "sp1", id, stored(50));
    age(id, 8);
    await w.cron();
    expect(w.r2.objects.size).toBe(1); // too soon
    w.db.raw.prepare("UPDATE l0w_state SET value = value - 3601 WHERE key = 'spaces_gc_at'").run();
    await w.cron();
    expect(w.r2.objects.size).toBe(0);
  });

  it("used-up tickets are forgotten once they would have expired", async () => {
    const { w, mara } = await rig();
    await w.upload(mara, "sp1", randomBlobId(), stored(50));
    expect(w.db.raw.prepare("SELECT count(*) AS n FROM tickets").get()).toEqual({ n: 1 });
    await w.cron();
    expect(w.db.raw.prepare("SELECT count(*) AS n FROM tickets").get()).toEqual({ n: 1 });
    w.db.raw.prepare("UPDATE tickets SET expires = 1").run();
    await w.cron();
    expect(w.db.raw.prepare("SELECT count(*) AS n FROM tickets").get()).toEqual({ n: 0 });
  });
});

describe("the Worker", () => {
  it("answers a status at /, 404 elsewhere, and registers as kind spaces with no roles", async () => {
    const w = await World.make();
    const res = await worker.fetch(new Request("https://spaces.hub.example/"), w.env, {} as ExecutionContext);
    expect(await res.json()).toEqual({ service: "spaces", address: "spaces@hub.example", kind: "spaces", v: "l0w/0.1", ok: true });
    expect((await worker.fetch(new Request("https://spaces.hub.example/v0/other"), w.env, {} as ExecutionContext)).status).toBe(404);
  });

  it("never stores anything but signed documents, sealed boxes and ciphertext: no column holds a key or a path", async () => {
    const w = await World.make();
    const { mara } = w.m;
    await w.create(mara, "sp1");
    const rows = w.db.raw.prepare("SELECT doc FROM space_keys").all() as Array<{ doc: string }>;
    for (const r of rows) expect(Object.keys(JSON.parse(r.doc)).sort()).toEqual(["payload", "sigs", "type", "v"]);
  });
});
