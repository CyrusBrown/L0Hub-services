import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { World, randomBlobId, stored, K, type FakeMember } from "./rig";

let w: World;
let mara: FakeMember, ola: FakeMember, zed: FakeMember;
beforeEach(async () => {
  w = await World.make({ MAX_FILE_BYTES: "1000", QUOTA_BYTES: "5000" });
  ({ mara, ola, zed } = w.m);
  await w.create(mara, "sp1");
  await w.join(mara, "sp1", ola);
});
afterEach(() => vi.useRealTimers());

const body = async (r: Response) => (await r.json()) as { error?: string; stored?: boolean };

describe("upload and download", () => {
  it("blob.upload gives a URL on the service's hostname; the stored form goes to R2 at <space>/<id>; blobs.missing follows", async () => {
    const id = randomBlobId();
    const data = stored(300);
    expect((await w.ok(mara, "blobs.missing", { space: "sp1", ids: [id] })).missing).toEqual([id]);
    const up = await w.ok(mara, "blob.upload", { space: "sp1", id, size: 300 });
    expect(up.url).toMatch(/^https:\/\/spaces\.hub\.example\/v0\/blob\/[A-Za-z0-9_.-]+$/);
    const left = new Date(up.expires as string).getTime() - Date.now();
    expect(left).toBeGreaterThan(14 * 60_000);
    expect(left).toBeLessThanOrEqual(15 * 60_000);
    const res = await w.put(up.url as string, data);
    expect(res.status).toBe(201);
    expect([...w.r2.objects.get(`sp1/${id}`)!]).toEqual([...data]);
    expect((await w.ok(mara, "blobs.missing", { space: "sp1", ids: [id] })).missing).toEqual([]);
    // another member downloads the same bytes
    const down = await w.ok(ola, "blob.download", { space: "sp1", id });
    const got = await w.get(down.url as string);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-length")).toBe("300");
    expect([...new Uint8Array(await got.arrayBuffer())]).toEqual([...data]);
  });

  it("a ticket works once, per direction", async () => {
    const id = randomBlobId();
    const up = await w.ok(mara, "blob.upload", { space: "sp1", id, size: 100 });
    expect((await w.put(up.url as string, stored(100))).status).toBe(201);
    const again = await w.put(up.url as string, stored(100));
    expect([again.status, (await body(again)).error]).toEqual([410, "ticket_used"]);
    const down = await w.ok(mara, "blob.download", { space: "sp1", id });
    expect((await w.get(down.url as string)).status).toBe(200);
    expect((await w.get(down.url as string)).status).toBe(410);
    // each request for a URL is its own ticket
    const down2 = await w.ok(mara, "blob.download", { space: "sp1", id });
    expect(down2.url).not.toBe(down.url);
    expect((await w.get(down2.url as string)).status).toBe(200);
  });

  it("a ticket expires after 15 minutes", async () => {
    const id = randomBlobId();
    const up = await w.ok(mara, "blob.upload", { space: "sp1", id, size: 100 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const res = await w.put(up.url as string, stored(100));
    expect([res.status, (await body(res)).error]).toEqual([410, "expired"]);
    expect(w.r2.objects.size).toBe(0);
  });

  it("tickets can't be forged, changed, or used the other way round; other paths are refused", async () => {
    const id = randomBlobId();
    const up = (await w.ok(mara, "blob.upload", { space: "sp1", id, size: 100 })).url as string;
    const [head, mac] = up.split("/").pop()!.split(".");
    const base = up.slice(0, up.lastIndexOf("/") + 1);
    expect((await w.put(`${base}${head}.${mac.slice(0, -2)}AA`, stored(100))).status).toBe(403);
    expect((await w.put(`${base}${head}x.${mac}`, stored(100))).status).toBe(403);
    expect((await w.put(`${base}garbage`, stored(100))).status).toBe(403);
    expect((await w.get(up)).status).toBe(403); // an upload ticket doesn't download
    const other = await World.make({ TICKET_KEY: "another key" });
    expect((await other.put(up, stored(100))).status).toBe(403);
    expect((await w.get(`${base}`)).status).toBe(403);
    const del = await (await import("../src/index")).default.fetch(new Request(up, { method: "DELETE" }), w.env, {} as ExecutionContext);
    expect(del.status).toBe(405);
  });

  it("the size is checked: the length must be the ticket's, there must be one, the body must match, the first byte is 0x01", async () => {
    const id = randomBlobId();
    const up = (await w.ok(mara, "blob.upload", { space: "sp1", id, size: 100 })).url as string;
    expect((await w.put(up, stored(101))).status).toBe(400); // Content-Length 101 for a 100 byte ticket
    expect((await w.put(up, stored(100), {})).status).toBe(411);
    const wrongFirst = stored(100);
    wrongFirst[0] = 2;
    const r1 = await w.put(up, wrongFirst);
    expect([r1.status, (await body(r1)).error]).toEqual([400, "bad_blob"]);
    // says 100, sends 60
    const r2 = await w.put(up, stored(60), { "content-length": "100" }).catch(() => null);
    if (r2) expect(r2.status).toBe(400);
    expect(w.r2.objects.size).toBe(0);
    // none of those used the ticket up
    expect((await w.put(up, stored(100))).status).toBe(201);
    expect(w.r2.objects.get(`sp1/${id}`)!.length).toBe(100);
  });

  it("max_file: a file over the limit gets no URL (the stored form is 17 bytes longer than the contents)", async () => {
    const id = randomBlobId();
    expect((await w.fail(mara, "blob.upload", { space: "sp1", id, size: 1018 })).code).toBe("too_large");
    expect(await w.ok(mara, "blob.upload", { space: "sp1", id, size: 1017 })).toHaveProperty("url");
    expect((await w.fail(mara, "blob.upload", { space: "sp1", id, size: 10 })).code).toBe("bad_args");
    expect((await w.fail(mara, "blob.upload", { space: "sp1", id: "nope", size: 100 })).code).toBe("bad_args");
    // a ticket made for a bigger limit is refused by this one
    const w2 = await World.make({ MAX_FILE_BYTES: "5000" });
    await w2.create(w2.m.mara, "sp1");
    const big = (await w2.ok(w2.m.mara, "blob.upload", { space: "sp1", id, size: 3000 })).url as string;
    w2.env.TICKET_KEY = w.env.TICKET_KEY;
    w.env.TICKET_KEY = "test ticket key";
    const res = await w.put(big, stored(3000));
    expect(res.status).toBe(413);
  });

  it("only members get URLs; a member removed after getting one can't use it; downloading a blob that isn't there is not_found", async () => {
    const id = randomBlobId();
    expect((await w.fail(zed, "blob.upload", { space: "sp1", id, size: 100 })).code).toBe("not_found");
    expect((await w.fail(zed, "blob.download", { space: "sp1", id })).code).toBe("not_found");
    expect((await w.fail(ola, "blob.download", { space: "sp1", id })).code).toBe("not_found");
    expect((await w.fail(zed, "blobs.missing", { space: "sp1", ids: [id] })).code).toBe("not_found");
    const up = (await w.ok(ola, "blob.upload", { space: "sp1", id, size: 100 })).url as string;
    await w.ok(ola, "space.leave", { space: "sp1" });
    const res = await w.put(up, stored(100));
    expect([res.status, (await body(res)).error]).toEqual([404, "not_found"]);
    expect(w.r2.objects.size).toBe(0);
  });

  it("a blob that is stored is never overwritten", async () => {
    const id = randomBlobId();
    const first = stored(100);
    await w.upload(mara, "sp1", id, first);
    const res = await w.upload(ola, "sp1", id, stored(100));
    expect([res.status, (await body(res)).stored]).toEqual([200, true]);
    expect([...w.r2.objects.get(`sp1/${id}`)!]).toEqual([...first]);
  });

  it("blobs.missing takes at most 500 ids; the quota stops uploads once the space is full", async () => {
    const ids = Array.from({ length: 501 }, () => randomBlobId());
    expect((await w.fail(mara, "blobs.missing", { space: "sp1", ids })).code).toBe("bad_args");
    expect(((await w.ok(mara, "blobs.missing", { space: "sp1", ids: ids.slice(0, 500) })).missing as string[]).length).toBe(500);
    for (let i = 0; i < 5; i++) expect((await w.upload(mara, "sp1", randomBlobId(), stored(1000))).status).toBe(201);
    const res = await w.upload(mara, "sp1", randomBlobId(), stored(100));
    expect([res.status, (await body(res)).error]).toEqual([413, "quota_exceeded"]);
  });

  it("a blob is addressed by its space: another space can't read it", async () => {
    await w.create(ola, "sp2", "other");
    const id = randomBlobId();
    await w.upload(mara, "sp1", id, stored(100));
    expect((await w.fail(ola, "blob.download", { space: "sp2", id })).code).toBe("not_found");
    expect(K(1)).toBeTruthy();
  });
});
