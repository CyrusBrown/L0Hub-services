import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Obj } from "@l0wservices/core";
import { BoardRig } from "./rig";

const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let r: BoardRig;

async function setup(vars: Obj = {}, roles?: Record<string, string[]>) {
  r = await BoardRig.make({ vars, roles });
  await r.connect("mara", "ola", "kai", "pia", "zed");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const post = async (who: string, topic: string, title = "A title", body = "Some body text", extra: Obj = {}) =>
  ((await r.ok(who, "post.create", { topic, title, body, ...extra })).post as Obj);

describe("topics and the moderator role", () => {
  beforeEach(() => setup());

  it("board-requests always exists", async () => {
    const { topics } = (await r.ok("ola", "topics.list")) as { topics: Obj[] };
    expect(topics.map((t) => t.slug)).toEqual(["board-requests"]);
    expect(topics[0]).toMatchObject({ state: "open", posts: 0, last_post: null, pinned: true });
  });

  it("mod methods need the moderator role: not_allowed without a grant, and for a member that has none", async () => {
    expect((await r.err("mara", "mod.topic.create", { slug: "ml", title: "ML", description: "d" })).code).toBe("not_allowed"); // no grant attached
    expect((await r.err("ola", "mod.topic.create", { slug: "ml", title: "ML", description: "d" }, true)).code).toBe("not_allowed"); // ola has no grant at all
    const t = await r.topic("ml", "Machine learning");
    expect(t).toMatchObject({ slug: "ml", title: "Machine learning", state: "open", posts: 0, pinned: false });
    expect(typeof t.id).toBe("string");
    expect(t.created).toMatch(/^2026-11-22T12:00:00Z$/);
  });

  it("slugs are checked and unique; topics.list hides archived topics unless asked", async () => {
    await r.topic("ml");
    for (const slug of ["A", "x", "a--b", "-a", "a".repeat(33), "has space"]) {
      expect((await r.err("mara", "mod.topic.create", { slug, title: "t", description: "" }, true)).code).toBe("bad_args");
    }
    expect((await r.err("mara", "mod.topic.create", { slug: "ml", title: "t", description: "" }, true)).code).toBe("bad_args");
    await r.ok("mara", "mod.topic.update", { id: "ml", state: "archived" }, true);
    expect(((await r.ok("ola", "topics.list")).topics as Obj[]).map((t) => t.slug)).toEqual(["board-requests"]);
    expect(((await r.ok("ola", "topics.list", { archived: true })).topics as Obj[]).map((t) => t.slug)).toEqual(["board-requests", "ml"]);
  });

  it("rename keeps the old slug answering; merge moves posts and subscriptions and the old slug answers for the new topic", async () => {
    await r.topic("ml");
    await r.topic("ai");
    await r.ok("ola", "subscribe", { topic: "ml" });
    const p = await post("kai", "ml");
    await r.ok("mara", "mod.topic.update", { id: "ml", slug: "learning", title: "Learning" }, true);
    expect(((await r.ok("kai", "posts.list", { topic: "ml" })).posts as Obj[]).map((x) => x.id)).toEqual([p.id]);
    expect(((await r.ok("kai", "posts.list", { topic: "ml" })).posts as Obj[])[0].topic).toBe("learning");

    const merged = (await r.ok("mara", "mod.topic.merge", { from: "learning", into: "ai" }, true)).topic as Obj;
    expect(merged).toMatchObject({ slug: "ai", posts: 1 });
    expect(((await r.ok("kai", "posts.list", { topic: "learning" })).posts as Obj[]).map((x) => x.topic)).toEqual(["ai"]);
    expect(((await r.ok("kai", "posts.list", { topic: "ml" })).posts as Obj[])).toHaveLength(1); // two hops
    expect((await r.ok("ola", "subscriptions")).subscriptions).toEqual(["ai"]);
    const all = (await r.ok("ola", "topics.list", { archived: true })).topics as Obj[];
    expect(all.find((t) => t.slug === "learning")!.state).toBe("archived");
    expect((await r.err("kai", "posts.list", { topic: "nope" })).code).toBe("not_found");
    expect((await r.err("mara", "mod.topic.merge", { from: "board-requests", into: "ai" }, true)).code).toBe("bad_args");
  });

  it("the topic cap", async () => {
    await setup({ MAX_TOPICS: 1 });
    await r.topic("ml");
    expect((await r.err("mara", "mod.topic.create", { slug: "ai", title: "t", description: "" }, true)).code).toBe("limit");
  });

  it("every moderator call is logged with the moderator's address, newest first, with a cursor", async () => {
    await r.topic("ml");
    await r.ok("mara", "mod.queue", {}, true);
    await r.ok("mara", "mod.topic.update", { id: "ml", pinned: true }, true);
    const log = await r.ok("mara", "mod.log", { limit: 2 }, true);
    const es = log.entries as Obj[];
    expect(es.map((e) => e.method)).toEqual(["mod.log", "mod.topic.update"]);
    expect(es[0].by).toBe("mara@hub.example");
    expect(es[1].args).toEqual({ id: "ml", pinned: true });
    expect(typeof log.next).toBe("string");
    const more = await r.ok("mara", "mod.log", { cursor: log.next }, true);
    expect((more.entries as Obj[]).map((e) => e.method)).toEqual(["mod.queue", "mod.topic.create"]);
    expect(more.next).toBeNull();
  });
});

describe("posts", () => {
  beforeEach(async () => {
    await setup();
    await r.topic("ml");
  });

  it("create, list (no body), get (whole body), summary, tags, files", async () => {
    const f = (await r.ok("ola", "file.put", { name: "a.txt", type: "text/plain", data: b64u("hello") })).file as Obj;
    expect(f).toMatchObject({ name: "a.txt", type: "text/plain", size: 5 });
    const body = "x".repeat(600);
    const p = await post("ola", "ml", "Title", body, { tags: ["CAD", "3d"], files: [f.id] });
    expect(p).toMatchObject({ topic: "ml", author: "ola@hub.example", title: "Title", state: "visible", score: 0, my_vote: 0, pinned: false, edited: null, proposal: null, tags: ["cad", "3d"] });
    expect(p.summary).toBe("x".repeat(500));
    expect(p.files).toEqual([{ id: f.id, name: "a.txt", type: "text/plain", size: 5 }]);
    expect((p.discussion as Obj).locks).toBe("2026-11-25T12:00:00Z");
    expect((p.discussion as Obj).messages).toBe(0);

    const list = (await r.ok("kai", "posts.list", { topic: "ml" })).posts as Obj[];
    expect(list).toHaveLength(1);
    expect(list[0].body).toBeUndefined();
    expect(list[0].files).toHaveLength(1);
    expect(((await r.ok("kai", "post.get", { id: p.id })).post as Obj).body).toBe(body);
    // another member reads the file
    const got = (await r.ok("kai", "file.get", { id: f.id })).file as Obj;
    expect(got).toMatchObject({ id: f.id, size: 5, data: b64u("hello") });
    // your own summary
    const s = await post("ola", "ml", "T2", "body", { summary: "mine" });
    expect(s.summary).toBe("mine");
  });

  it("validation: bad_args, unknown topic, readonly topic, board-requests is for proposals", async () => {
    expect((await r.err("ola", "post.create", { topic: "ml", title: "", body: "b" })).code).toBe("bad_args");
    expect((await r.err("ola", "post.create", { topic: "ml", title: "t", body: "" })).code).toBe("bad_args");
    expect((await r.err("ola", "post.create", { topic: "ml", title: "t", body: "x".repeat(64 * 1024 + 1) })).code).toBe("bad_args");
    expect((await r.err("ola", "post.create", { topic: "ml", title: "t", body: "b", tags: Array(9).fill("a1") })).code).toBe("bad_args");
    expect((await r.err("ola", "post.create", { topic: "ml", title: "t", body: "b", tags: ["Bad Tag"] })).code).toBe("bad_args");
    expect((await r.err("ola", "post.create", { topic: "ml", title: "t", body: "b", files: ["nope"] })).code).toBe("bad_args");
    expect((await r.err("ola", "post.create", { topic: "nope", title: "t", body: "b" })).code).toBe("not_found");
    expect((await r.err("ola", "post.create", { topic: "board-requests", title: "t", body: "b" })).code).toBe("bad_args");
    await r.ok("mara", "mod.topic.update", { id: "ml", state: "readonly" }, true);
    expect((await r.err("ola", "post.create", { topic: "ml", title: "t", body: "b" })).code).toBe("readonly");
  });

  it("files: size, type, ownership, at most 4, and someone else's file can't be attached", async () => {
    expect((await r.err("ola", "file.put", { name: "a/b", type: "text/plain", data: "AAAA" })).code).toBe("bad_args");
    expect((await r.err("ola", "file.put", { name: "a", type: "nonsense", data: "AAAA" })).code).toBe("bad_args");
    expect((await r.err("ola", "file.put", { name: "a", type: "text/plain", data: "AA==" })).code).toBe("bad_args"); // padding
    expect((await r.err("ola", "file.put", { name: "a", type: "text/plain", data: "A" })).code).toBe("bad_args");
    const big = "A".repeat(955735); // 700 KiB + 1 byte
    expect((await r.err("ola", "file.put", { name: "big", type: "application/octet-stream", data: big })).code).toBe("bad_args");
    const max = "A".repeat(955734); // 700 KiB exactly
    const ok = (await r.ok("ola", "file.put", { name: "max", type: "application/octet-stream", data: max })).file as Obj;
    expect(ok.size).toBe(700 * 1024);

    const mine = (await r.ok("ola", "file.put", { name: "m", type: "text/plain", data: b64u("x") })).file as Obj;
    expect((await r.err("kai", "post.create", { topic: "ml", title: "t", body: "b", files: [mine.id] })).code).toBe("bad_args");
    expect((await r.err("kai", "file.get", { id: mine.id })).code).toBe("not_found"); // not attached yet: only its owner
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(((await r.ok("ola", "file.put", { name: `f${i}`, type: "text/plain", data: b64u("x") })).file as Obj).id as string);
    expect((await r.err("ola", "post.create", { topic: "ml", title: "t", body: "b", files: ids })).code).toBe("bad_args");
    await post("ola", "ml", "t", "b", { files: ids.slice(0, 4) });
    expect((await r.err("ola", "post.create", { topic: "ml", title: "t", body: "b", files: [ids[0]] })).code).toBe("bad_args"); // attached already
  });

  it("posts.list: new and top, tag, author, since, pinned first in a topic, cursors", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push((await post(["ola", "kai", "pia", "zed"][i], "ml", `P${i}`, "b", { tags: i % 2 ? ["odd"] : ["even"] })).id as string);
      r.advance(10);
    }
    const titles = async (args: Obj, who = "mara") => ((await r.ok(who, "posts.list", args)).posts as Obj[]).map((p) => p.title);
    expect(await titles({ topic: "ml" })).toEqual(["P3", "P2", "P1", "P0"]);
    expect(await titles({ topic: "ml", tag: "odd" })).toEqual(["P3", "P1"]);
    expect(await titles({ author: "KAI@hub.example" })).toEqual(["P1"]);
    expect(await titles({ since: "2026-11-22T12:00:15Z" })).toEqual(["P3", "P2"]);
    expect(await titles({})).toEqual(["P3", "P2", "P1", "P0"]);

    await r.ok("pia", "vote", { post: ids[0], value: 1 });
    await r.ok("zed", "vote", { post: ids[0], value: 1 });
    await r.ok("pia", "vote", { post: ids[1], value: -1 });
    expect(await titles({ topic: "ml", sort: "top" })).toEqual(["P0", "P3", "P2", "P1"]);

    // paging
    const p1 = await r.ok("mara", "posts.list", { topic: "ml", limit: 3 });
    expect((p1.posts as Obj[]).map((p) => p.title)).toEqual(["P3", "P2", "P1"]);
    const p2 = await r.ok("mara", "posts.list", { topic: "ml", limit: 3, cursor: p1.next });
    expect((p2.posts as Obj[]).map((p) => p.title)).toEqual(["P0"]);
    expect(p2.next).toBeNull();
    const t1 = await r.ok("mara", "posts.list", { topic: "ml", limit: 2, sort: "top" });
    const t2 = await r.ok("mara", "posts.list", { topic: "ml", limit: 2, sort: "top", cursor: t1.next });
    expect([...(t1.posts as Obj[]), ...(t2.posts as Obj[])].map((p) => p.title)).toEqual(["P0", "P3", "P2", "P1"]);
    expect((await r.err("mara", "posts.list", { cursor: "garbage!" })).code).toBe("bad_args");
    expect((await r.err("mara", "posts.list", { sort: "hot" })).code).toBe("bad_args");

    // a pinned post leads inside its topic
    await r.ok("mara", "mod.post.update", { id: ids[1], pinned: true }, true);
    expect(await titles({ topic: "ml" })).toEqual(["P1", "P3", "P2", "P0"]);
  });
});

describe("held first posts", () => {
  beforeEach(async () => {
    await setup({ HELD_FIRST_POSTS: 2 });
    await r.topic("ml");
  });

  it("a new member's first 2 posts are held (only the author and moderators see them), a moderator is told, release makes them visible and tells subscribers", async () => {
    await r.ok("kai", "subscribe", { topic: "ml" });
    const h1 = await post("ola", "ml", "first");
    expect(h1.state).toBe("held");
    expect((await r.ok("ola", "me")).held_posts).toBe(1);
    // moderators hear about it, others see nothing
    const held = await r.events("mara", "held");
    expect(held).toHaveLength(1);
    expect(((held[0].data.post as Obj).id)).toBe(h1.id);
    expect((held[0].data.post as Obj).body).toBeUndefined();
    expect(await r.events("kai", "post")).toHaveLength(0);

    expect(((await r.ok("kai", "posts.list", { topic: "ml" })).posts as Obj[])).toHaveLength(0);
    expect((await r.err("kai", "post.get", { id: h1.id })).code).toBe("not_found");
    expect(((await r.ok("ola", "posts.list", { topic: "ml" })).posts as Obj[])).toHaveLength(1);
    expect(((await r.ok("mara", "posts.list", { topic: "ml" })).posts as Obj[])).toHaveLength(1);
    expect(((await r.ok("kai", "topics.list")).topics as Obj[]).find((t) => t.slug === "ml")!.posts).toBe(0);
    expect((await r.err("kai", "vote", { post: h1.id, value: 1 })).code).toBe("not_found");

    const queue = (await r.ok("mara", "mod.queue", {}, true)).posts as Obj[];
    expect(queue.map((p) => p.id)).toEqual([h1.id]);
    expect(queue[0].body).toBe("Some body text");

    expect((await r.err("mara", "mod.release", { id: "nope" }, true)).code).toBe("not_found");
    const rel = (await r.ok("mara", "mod.release", { id: h1.id }, true)).post as Obj;
    expect(rel.state).toBe("visible");
    const evs = await r.events("kai", "post");
    expect(evs).toHaveLength(1);
    expect((evs[0].data.post as Obj).id).toBe(h1.id);
    expect(((await r.ok("kai", "posts.list", { topic: "ml" })).posts as Obj[])).toHaveLength(1);
    expect((await r.err("mara", "mod.release", { id: h1.id }, true)).code).toBe("bad_args");
    expect(((await r.ok("mara", "mod.queue", {}, true)).posts as Obj[])).toHaveLength(0);

    // the second is held, the third is not; a moderator's own posts are never held
    expect((await post("ola", "ml", "second")).state).toBe("held");
    expect((await post("ola", "ml", "third")).state).toBe("visible");
    expect((await post("mara", "ml", "mod post")).state).toBe("visible");
  });

  it("hide and unhide by a moderator; a hidden post is for its author and moderators", async () => {
    await r.ok("mara", "mod.release", { id: (await post("ola", "ml")).id }, true).catch(() => undefined);
    const p = await post("ola", "ml", "third");
    const h = (await r.ok("mara", "mod.post.update", { id: p.id, state: "hidden" }, true)).post as Obj;
    expect(h.state).toBe("hidden");
    expect((await r.err("kai", "post.get", { id: p.id })).code).toBe("not_found");
    expect(((await r.ok("ola", "post.get", { id: p.id })).post as Obj).state).toBe("hidden");
    await r.ok("mara", "mod.post.update", { id: p.id, state: "visible" }, true);
    expect(((await r.ok("kai", "post.get", { id: p.id })).post as Obj).state).toBe("visible");
    expect((await r.err("mara", "mod.post.update", { id: p.id, state: "removed" }, true)).code).toBe("bad_args");
  });

  it("move a post to another topic", async () => {
    await r.topic("ai");
    const p = await post("mara", "ml");
    const moved = (await r.ok("mara", "mod.post.update", { id: p.id, topic: "ai" }, true)).post as Obj;
    expect(moved.topic).toBe("ai");
    expect((await r.err("mara", "mod.post.update", { id: p.id, topic: "board-requests" }, true)).code).toBe("bad_args");
  });
});

describe("votes", () => {
  beforeEach(async () => {
    await setup();
    await r.topic("ml");
  });

  it("one per member, changeable, 0 takes it back, not on your own post, my_vote and scores", async () => {
    const p = await post("ola", "ml");
    expect((await r.err("ola", "vote", { post: p.id, value: 1 })).code).toBe("bad_args");
    expect(await r.ok("kai", "vote", { post: p.id, value: 1 })).toEqual({ score: 1, up: 1, down: 0, my_vote: 1 });
    expect(await r.ok("kai", "vote", { post: p.id, value: 1 })).toEqual({ score: 1, up: 1, down: 0, my_vote: 1 }); // still one
    expect(await r.ok("pia", "vote", { post: p.id, value: -1 })).toEqual({ score: 0, up: 1, down: 1, my_vote: -1 });
    expect(await r.ok("pia", "vote", { post: p.id, value: 1 })).toEqual({ score: 2, up: 2, down: 0, my_vote: 1 });
    expect(await r.ok("kai", "vote", { post: p.id, value: 0 })).toEqual({ score: 1, up: 1, down: 0, my_vote: 0 });
    const g = (await r.ok("pia", "post.get", { id: p.id })).post as Obj;
    expect(g).toMatchObject({ score: 1, up: 1, down: 0, my_vote: 1 });
    expect(((await r.ok("kai", "post.get", { id: p.id })).post as Obj).my_vote).toBe(0);
    expect((await r.err("kai", "vote", { post: p.id, value: 2 })).code).toBe("bad_args");
    expect((await r.err("kai", "vote", { post: "nope", value: 1 })).code).toBe("not_found");
  });
});

describe("subscriptions and events", () => {
  beforeEach(async () => {
    await setup();
    await r.topic("ml");
  });

  it("subscribe / unsubscribe / subscriptions; the `post` event reaches subscribers (not the author) through the outbox", async () => {
    expect((await r.ok("kai", "subscribe", { topic: "ml" })).subscriptions).toEqual(["ml"]);
    expect((await r.ok("kai", "subscribe", { topic: "ml" })).subscriptions).toEqual(["ml"]);
    await r.ok("ola", "subscribe", { topic: "ml" });
    await r.ok("pia", "subscribe", { topic: "ml" });
    expect((await r.ok("pia", "unsubscribe", { topic: "ml" })).subscriptions).toEqual([]);
    expect((await r.err("kai", "subscribe", { topic: "zzz" })).code).toBe("not_found");
    expect(await r.ok("kai", "subscriptions")).toEqual({ subscriptions: ["ml"], watches: [] });

    const p = await post("ola", "ml", "News", "full body");
    const kai = await r.events("kai", "post");
    expect(kai).toHaveLength(1);
    const ep = kai[0].data.post as Obj;
    expect(ep).toMatchObject({ id: p.id, topic: "ml", title: "News", summary: "full body", author: "ola@hub.example", my_vote: 0 });
    expect(ep.body).toBeUndefined();
    expect(await r.events("ola", "post")).toHaveLength(0); // not their own
    expect(await r.events("pia", "post")).toHaveLength(0); // unsubscribed
  });

  it("an event for an offline member is retried by the cron handler", async () => {
    await r.ok("kai", "subscribe", { topic: "ml" });
    r.m.kai.script = [0]; // the first delivery attempt fails (offline)
    await post("ola", "ml");
    expect(await r.events("kai", "post")).toHaveLength(0);
    r.advance(60);
    await r.cron();
    expect(await r.events("kai", "post")).toHaveLength(1);
  });
});

describe("limits", () => {
  beforeEach(async () => {
    await setup({ POSTS_PER_DAY: 2, MESSAGES_PER_DAY: 2, FILES_PER_DAY: 1, MAX_WATCHES: 2 });
    await r.topic("ml");
  });

  it("posts per day: `limit` with retry_after, then free again 24 hours later; `me` shows what's left", async () => {
    expect((await r.ok("ola", "me")).limits).toMatchObject({ posts_left_today: 2, messages_left_today: 2, watches_left: 2 });
    await post("ola", "ml");
    r.advance(3600);
    await post("ola", "ml");
    expect((await r.ok("ola", "me")).limits).toMatchObject({ posts_left_today: 0 });
    const e = await r.err("ola", "post.create", { topic: "ml", title: "t", body: "b" });
    expect(e).toMatchObject({ code: "limit", retry_after: 23 * 3600 });
    expect(String(e.detail)).toContain("posts");
    r.advance(23 * 3600 + 1); // the first post is out of the window, the second isn't
    expect((await r.ok("ola", "me")).limits).toMatchObject({ posts_left_today: 1 });
    await post("ola", "ml");
    expect((await r.ok("ola", "me")).limits).toMatchObject({ posts_left_today: 0 });
  });

  it("file uploads per day and discussion messages per day", async () => {
    await r.ok("ola", "file.put", { name: "a", type: "text/plain", data: "AAAA" });
    expect(await r.err("ola", "file.put", { name: "a", type: "text/plain", data: "AAAA" })).toMatchObject({ code: "limit", retry_after: 86400 });
    const p = await post("kai", "ml");
    await r.ok("ola", "discuss.send", { post: p.id, body: "one" });
    await r.ok("ola", "discuss.send", { post: p.id, body: "two" });
    expect(await r.err("ola", "discuss.send", { post: p.id, body: "three" })).toMatchObject({ code: "limit" });
  });

  it("watches: at most N, refused with `limit`", async () => {
    const ps = [await post("kai", "ml"), await post("pia", "ml"), await post("zed", "ml")];
    await r.ok("ola", "discuss.watch", { post: ps[0].id });
    await r.ok("ola", "discuss.watch", { post: ps[0].id }); // again: no second watch
    const w = await r.ok("ola", "discuss.watch", { post: ps[1].id });
    expect(w.watches).toHaveLength(2);
    const e = await r.err("ola", "discuss.watch", { post: ps[2].id });
    expect(e.code).toBe("limit");
    expect(e.retry_after).toBeGreaterThan(0);
    expect((await r.ok("ola", "me")).limits).toMatchObject({ watches_left: 0 });
    await r.ok("ola", "discuss.unwatch", { post: ps[0].id });
    expect((await r.ok("ola", "discuss.watch", { post: ps[2].id })).watches).toHaveLength(2);
  });
});

describe("discussions", () => {
  beforeEach(async () => {
    await setup();
    await r.topic("ml");
  });

  it("send and list with a cursor; messages count in the post; mentions are parsed (@name and @name@domain) and stored", async () => {
    const p = await post("ola", "ml", "Talk");
    const m1 = (await r.ok("kai", "discuss.send", { post: p.id, body: "hello @ola and @pia, also @zed@other.example, not mail me@pia.example nor @ola again" })).message as Obj;
    expect(m1).toMatchObject({ post: p.id, author: "kai@hub.example", mentions: ["ola@hub.example", "pia@hub.example", "zed@other.example"] });
    await r.ok("ola", "discuss.send", { post: p.id, body: "hi" });
    await r.ok("pia", "discuss.send", { post: p.id, body: "hey" });
    const l = await r.ok("zed", "discuss.list", { post: p.id, limit: 2 });
    expect((l.messages as Obj[]).map((m) => m.author)).toEqual(["kai@hub.example", "ola@hub.example"]);
    expect(l.locked).toBe(false);
    const l2 = await r.ok("zed", "discuss.list", { post: p.id, limit: 2, cursor: l.next });
    expect((l2.messages as Obj[]).map((m) => m.author)).toEqual(["pia@hub.example"]);
    expect(l2.next).toBeNull();
    expect(((await r.ok("zed", "discuss.list", { post: p.id, since: "2026-11-22T13:00:00Z" })).messages as Obj[])).toHaveLength(0);
    expect((((await r.ok("zed", "post.get", { id: p.id })).post as Obj).discussion as Obj)).toMatchObject({ messages: 3, last: "2026-11-22T12:00:00Z" });

    const mine = await r.ok("ola", "mentions");
    expect(mine.mentions).toEqual([{ message: m1, post: { id: p.id, title: "Talk", topic: "ml" } }]);
    expect(mine.next).toBeNull();
    expect(((await r.ok("kai", "mentions")).mentions as Obj[])).toHaveLength(0);
    expect((await r.err("kai", "discuss.send", { post: p.id, body: "" })).code).toBe("bad_args");
    expect((await r.err("kai", "discuss.send", { post: p.id, body: "x".repeat(4097) })).code).toBe("bad_args");
    expect((await r.err("kai", "discuss.send", { post: "nope", body: "x" })).code).toBe("not_found");
  });

  it("the `mention` event reaches the mentioned member (not the author), with the message and the post", async () => {
    const p = await post("ola", "ml", "Talk");
    const m = (await r.ok("kai", "discuss.send", { post: p.id, body: "@pia look, @kai too" })).message as Obj;
    const ev = await r.events("pia", "mention");
    expect(ev).toHaveLength(1);
    expect(ev[0].data).toEqual({ message: m, post: { id: p.id, title: "Talk", topic: "ml" } });
    expect(await r.events("kai", "mention")).toHaveLength(0);
    expect(await r.events("zed", "mention")).toHaveLength(0);
  });

  it("a discussion locks 3 days after its post was created: send answers `locked`, list says locked, watch is refused", async () => {
    const p = await post("ola", "ml");
    await r.ok("kai", "discuss.send", { post: p.id, body: "early" });
    r.advance(3 * 86400 - 1);
    await r.ok("kai", "discuss.send", { post: p.id, body: "just in time" });
    expect((await r.ok("kai", "discuss.list", { post: p.id })).locked).toBe(false);
    r.advance(1);
    expect((await r.err("kai", "discuss.send", { post: p.id, body: "late" })).code).toBe("locked");
    const l = await r.ok("kai", "discuss.list", { post: p.id });
    expect(l.locked).toBe(true);
    expect(l.messages).toHaveLength(2); // still readable
    expect((await r.err("kai", "discuss.watch", { post: p.id })).code).toBe("locked");
  });

  it("readonly topics take no discussion", async () => {
    const p = await post("ola", "ml");
    await r.ok("mara", "mod.topic.update", { id: "ml", state: "readonly" }, true);
    expect((await r.err("kai", "discuss.send", { post: p.id, body: "x" })).code).toBe("readonly");
  });

  it("watches: unread counts, expiry 7 days after the last message (never past the lock), at most one `discussion` event per watch per hour", async () => {
    const p = await post("ola", "ml", "Watched");
    const w = (await r.ok("kai", "discuss.watch", { post: p.id })).watches as Obj[];
    expect(w).toEqual([{ post: p.id, title: "Watched", since: "2026-11-22T12:00:00Z", expires: "2026-11-25T12:00:00Z", unread: 0 }]); // capped by the lock

    await r.ok("ola", "discuss.send", { post: p.id, body: "one" });
    await r.ok("ola", "discuss.send", { post: p.id, body: "two" }); // inside the hour: held back
    let ev = await r.events("kai", "discussion");
    expect(ev).toEqual([{ event: "discussion", data: { post: p.id, title: "Watched", unread: 1 } }]);
    expect(((await r.ok("kai", "subscriptions")).watches as Obj[])[0].unread).toBe(2);
    // the author of a message isn't told of their own message
    expect(await r.events("ola", "discussion")).toHaveLength(0);

    // the cron run an hour later sends what was held back
    r.advance(3600);
    await r.cron();
    ev = await r.events("kai", "discussion");
    expect(ev).toHaveLength(2);
    expect(ev[1].data).toEqual({ post: p.id, title: "Watched", unread: 2 });
    // nothing more is pending
    r.advance(3600);
    await r.cron();
    expect(await r.events("kai", "discussion")).toHaveLength(2);

    // reading marks it read
    await r.ok("kai", "discuss.list", { post: p.id });
    expect(((await r.ok("kai", "subscriptions")).watches as Obj[])[0].unread).toBe(0);
    // the next message after an hour is a new event
    r.advance(3600);
    await r.ok("ola", "discuss.send", { post: p.id, body: "three" });
    expect(await r.events("kai", "discussion")).toHaveLength(3);
  });

  it("a watch expires 7 days after the last message when the lock is further away: here, quiet watches are dropped", async () => {
    const p = await post("ola", "ml");
    await r.ok("kai", "discuss.watch", { post: p.id });
    r.advance(3 * 86400); // locked: the watch is gone from the list
    expect(((await r.ok("kai", "subscriptions")).watches as Obj[])).toHaveLength(0);
  });
});

describe("proposals", () => {
  beforeEach(async () => {
    await setup();
    await r.topic("machine-learning", "Machine learning");
    await r.topic("cad", "CAD");
  });

  it("propose -> a post in board-requests with `similar` topics; a moderator is told; decide accepted creates the topic and tells the proposer", async () => {
    const res = await r.ok("ola", "topic.propose", { slug: "ml-models", title: "Machine learning models", description: "Models and weights", reason: "we talk about it a lot" });
    const p = res.post as Obj;
    expect(p).toMatchObject({ topic: "board-requests", state: "visible", proposal: { slug: "ml-models", title: "Machine learning models", description: "Models and weights", decision: null } });
    expect(((res.similar as Obj[]).map((t) => t.slug))).toEqual(["machine-learning"]);
    expect((p.body as string)).toContain("we talk about it a lot");
    // the proposal can be voted on and is in the queue; moderators hear of it
    await r.ok("kai", "vote", { post: p.id, value: 1 });
    expect(((await r.ok("mara", "mod.queue", {}, true)).posts as Obj[]).map((x) => x.id)).toEqual([p.id]);
    expect((await r.events("mara", "held")).map((e) => (e.data.post as Obj).id)).toEqual([p.id]);
    // duplicates and existing slugs
    expect((await r.err("kai", "topic.propose", { slug: "ml-models", title: "t", description: "d", reason: "r" })).code).toBe("bad_args");
    expect((await r.err("kai", "topic.propose", { slug: "cad", title: "t", description: "d", reason: "r" })).code).toBe("bad_args");

    const dec = await r.ok("mara", "mod.decide", { id: p.id, decision: "accepted", note: "good" }, true);
    expect((dec.topic as Obj).slug).toBe("ml-models");
    expect((dec.post as Obj).proposal).toMatchObject({ decision: "accepted" });
    const topics = ((await r.ok("kai", "topics.list")).topics as Obj[]).map((t) => t.slug);
    expect(topics).toContain("ml-models");
    expect(await r.events("ola", "decided")).toEqual([{ event: "decided", data: { post: p.id, decision: "accepted", topic: "ml-models" } }]);
    expect(((await r.ok("mara", "mod.queue", {}, true)).posts as Obj[])).toHaveLength(0);
    expect((await r.err("mara", "mod.decide", { id: p.id, decision: "declined" }, true)).code).toBe("bad_args"); // once
    // and the new topic takes posts
    await post("kai", "ml-models");
  });

  it("declined: no topic, a `decided` event without one; decide needs a proposal and a valid decision", async () => {
    const p = (await r.ok("ola", "topic.propose", { slug: "pets", title: "Pets", description: "d", reason: "r" })).post as Obj;
    const plain = await post("kai", "cad");
    expect((await r.err("mara", "mod.decide", { id: plain.id, decision: "accepted" }, true)).code).toBe("not_found");
    expect((await r.err("mara", "mod.decide", { id: p.id, decision: "maybe" }, true)).code).toBe("bad_args");
    const dec = await r.ok("mara", "mod.decide", { id: p.id, decision: "declined" }, true);
    expect(dec.topic).toBeUndefined();
    expect(await r.events("ola", "decided")).toEqual([{ event: "decided", data: { post: p.id, decision: "declined" } }]);
    expect(((await r.ok("kai", "topics.list")).topics as Obj[]).map((t) => t.slug)).not.toContain("pets");
  });

  it("accepting a slug that was taken meanwhile fails and decides nothing", async () => {
    const p = (await r.ok("ola", "topic.propose", { slug: "pets", title: "Pets", description: "d", reason: "r" })).post as Obj;
    await r.topic("pets");
    expect((await r.err("mara", "mod.decide", { id: p.id, decision: "accepted" }, true)).code).toBe("bad_args");
    expect((((await r.ok("kai", "post.get", { id: p.id })).post as Obj).proposal as Obj).decision).toBeNull();
  });
});

describe("hourly upkeep", () => {
  beforeEach(async () => {
    await setup();
    await r.topic("ml");
    await r.topic("quiet");
  });

  it("unattached files are dropped after 1 day, attached ones stay", async () => {
    const lone = (await r.ok("ola", "file.put", { name: "a", type: "text/plain", data: "AAAA" })).file as Obj;
    const kept = (await r.ok("ola", "file.put", { name: "b", type: "text/plain", data: "AAAA" })).file as Obj;
    await post("ola", "ml", "t", "b", { files: [kept.id] });
    r.advance(86400 + 3600);
    await r.cron();
    expect((await r.err("ola", "file.get", { id: lone.id })).code).toBe("not_found");
    expect(((await r.ok("kai", "file.get", { id: kept.id })).file as Obj).id).toBe(kept.id);
  });

  it("topics with no post for 90 days are archived (a topic with a recent post stays), once an hour", async () => {
    await post("ola", "ml");
    r.advance(60 * 86400);
    await post("ola", "ml");
    r.advance(45 * 86400); // quiet: 105 days old and empty; ml: last post 45 days ago
    await r.cron();
    const states = Object.fromEntries((((await r.ok("kai", "topics.list", { archived: true })).topics as Obj[])).map((t) => [t.slug, t.state]));
    expect(states).toMatchObject({ ml: "open", quiet: "archived", "board-requests": "open" });
    expect((await r.err("ola", "post.create", { topic: "quiet", title: "t", body: "b" })).code).toBe("readonly");
    r.advance(50 * 86400);
    await r.cron();
    expect((await r.ok("kai", "topics.list", { archived: true })).topics).toContainEqual(expect.objectContaining({ slug: "ml", state: "archived" }));
  });
});

describe("the call surface", () => {
  beforeEach(setup as () => Promise<void>);

  it("an unknown method, and `me`", async () => {
    expect((await r.err("ola", "nope")).code).toBe("unknown_method");
    const me = await r.ok("mara", "me");
    expect(me).toMatchObject({ address: "mara@hub.example", roles: ["moderator"], held_posts: 0 });
    expect((await r.ok("ola", "me")).roles).toEqual([]);
  });
});
