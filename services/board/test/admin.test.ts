import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Obj } from "@l0wservices/core";
import { BoardRig } from "./rig";

let r: BoardRig;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
  r = await BoardRig.make();
  await r.connect("mara", "ola", "kai", "pia");
  await r.topic("ml");
});
afterEach(() => vi.useRealTimers());

const post = async (who: string, title = "T", body = "B", extra: Obj = {}) => ((await r.ok(who, "post.create", { topic: "ml", title, body, ...extra })).post as Obj);

describe("the operator's admin API", () => {
  it("404 when ADMIN_TOKEN is unset; 401 without or with a wrong token; the inbox is untouched", async () => {
    expect((await r.admin("GET", "/status")).status).toBe(200);
    expect((await r.admin("GET", "/status", undefined, null)).status).toBe(401);
    expect((await r.admin("GET", "/status", undefined, "wrong")).status).toBe(401);
    expect((await r.admin("POST", "/nothing")).status).toBe(404);
    delete r.env.ADMIN_TOKEN;
    expect((await r.admin("GET", "/status")).status).toBe(404);
    expect((await r.admin("POST", "/pause")).status).toBe(404);
    expect((await r.ok("ola", "me")).address).toBe("ola@hub.example");
  });

  it("remove a post for good: body and files gone, state `removed`, out of lists, discussion gone", async () => {
    const f = (await r.ok("ola", "file.put", { name: "a", type: "text/plain", data: "AAAA" })).file as Obj;
    const p = await post("ola", "Bad", "terrible body", { files: [f.id] });
    await r.ok("kai", "discuss.send", { post: p.id, body: "reply" });
    await r.ok("pia", "vote", { post: p.id, value: 1 });
    expect((await r.admin("POST", "/posts/nope/remove")).status).toBe(404);
    const res = await r.admin("POST", `/posts/${p.id}/remove`);
    expect(res).toMatchObject({ status: 200, json: { ok: true, state: "removed" } });
    const g = (await r.ok("kai", "post.get", { id: p.id })).post as Obj;
    expect(g).toMatchObject({ state: "removed", body: "", files: [], score: 0, summary: "", title: "[removed]" });
    expect(((await r.ok("kai", "posts.list", { topic: "ml" })).posts as Obj[])).toHaveLength(0);
    expect((await r.err("ola", "file.get", { id: f.id })).code).toBe("not_found");
    expect((await r.err("kai", "discuss.list", { post: p.id })).code).toBe("not_found");
    expect((await r.err("pia", "vote", { post: p.id, value: -1 })).code).toBe("not_found");
    expect(r.db.raw.prepare("SELECT count(*) AS n FROM files").get()).toMatchObject({ n: 0 });
    expect(r.db.raw.prepare("SELECT count(*) AS n FROM messages").get()).toMatchObject({ n: 0 });
    // the operator's action is in the moderators' log
    const log = (await r.ok("mara", "mod.log", {}, true)).entries as Obj[];
    expect(log.find((e) => e.by === "operator")).toMatchObject({ method: "admin.post.remove", args: { id: p.id } });
  });

  it("mute: a muted member can read but not post, vote, upload or send; unmute restores", async () => {
    const p = await post("kai");
    expect((await r.admin("POST", "/members/ola/mute")).status).toBe(400); // an address, please
    const res = await r.admin("POST", "/members/ola@hub.example/mute", { reason: "spam" });
    expect(res.json).toMatchObject({ ok: true, member: "ola@hub.example", muted: true });
    for (const [method, args] of [
      ["post.create", { topic: "ml", title: "t", body: "b" }],
      ["vote", { post: p.id, value: 1 }],
      ["discuss.send", { post: p.id, body: "x" }],
      ["file.put", { name: "a", type: "text/plain", data: "AAAA" }],
      ["topic.propose", { slug: "zz", title: "t", description: "d", reason: "r" }],
    ] as Array<[string, Obj]>) {
      expect(await r.err("ola", method, args), method).toMatchObject({ code: "not_allowed" });
    }
    expect(((await r.ok("ola", "posts.list", { topic: "ml" })).posts as Obj[])).toHaveLength(1);
    expect((await r.ok("ola", "post.get", { id: p.id })).post).toBeTruthy();
    expect((await r.ok("ola", "me")).muted).toBe(true);
    expect((await r.admin("GET", "/status")).json.muted).toEqual(["ola@hub.example"]);
    await r.admin("POST", "/members/OLA@hub.example/unmute");
    await r.ok("ola", "vote", { post: p.id, value: 1 });
    expect((await r.ok("ola", "me")).muted).toBe(false);
  });

  it("reset a post's votes", async () => {
    const p = await post("kai");
    await r.ok("ola", "vote", { post: p.id, value: 1 });
    await r.ok("pia", "vote", { post: p.id, value: 1 });
    expect((await r.admin("POST", `/posts/${p.id}/reset-votes`)).json.ok).toBe(true);
    expect(((await r.ok("mara", "post.get", { id: p.id })).post as Obj)).toMatchObject({ score: 0, up: 0, down: 0, my_vote: 0 });
    expect(await r.ok("ola", "vote", { post: p.id, value: -1 })).toEqual({ score: -1, up: 0, down: 1, my_vote: -1 }); // can vote again
  });

  it("set a topic read-only and back", async () => {
    expect((await r.admin("POST", "/topics/nope/readonly")).status).toBe(404);
    expect((await r.admin("POST", "/topics/ml/readonly")).json.state).toBe("readonly");
    expect((await r.err("ola", "post.create", { topic: "ml", title: "t", body: "b" })).code).toBe("readonly");
    expect((await r.admin("POST", "/topics/ml/readonly", { readonly: false })).json.state).toBe("open");
    await post("ola");
  });

  it("pause: every write answers `unavailable`, reads work, resume restores", async () => {
    const p = await post("kai");
    expect((await r.admin("POST", "/pause")).json).toEqual({ ok: true, paused: true });
    for (const [who, method, args, mod] of [
      ["ola", "post.create", { topic: "ml", title: "t", body: "b" }, false],
      ["ola", "vote", { post: p.id, value: 1 }, false],
      ["ola", "discuss.send", { post: p.id, body: "x" }, false],
      ["ola", "file.put", { name: "a", type: "text/plain", data: "AAAA" }, false],
      ["ola", "subscribe", { topic: "ml" }, false],
      ["ola", "discuss.watch", { post: p.id }, false],
      ["mara", "mod.topic.create", { slug: "zz", title: "t", description: "" }, true],
    ] as Array<[string, string, Obj, boolean]>) {
      expect(await r.err(who, method, args, mod), method).toMatchObject({ code: "unavailable" });
    }
    expect(((await r.ok("ola", "posts.list", { topic: "ml" })).posts as Obj[])).toHaveLength(1);
    expect((await r.ok("ola", "topics.list")).topics).toBeTruthy();
    expect((await r.admin("GET", "/status")).json.paused).toBe(true);
    await r.admin("POST", "/resume");
    await post("ola");
  });
});
