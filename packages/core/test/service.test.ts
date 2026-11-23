import { b64, docs, messages, payloads as P } from "@l0w/proto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createService } from "../src";
import { SEED, labelled, rig, type Rig, FakeMember, DOMAIN, asCtx } from "./helpers";

let r: Rig;
beforeEach(async () => {
  r = await rig();
});
afterEach(() => vi.useRealTimers());

const err = async (res: Response) => ((await res.json()) as { error: string }).error;

async function reply(m: FakeMember, r: Rig, i = -1) {
  const all = await m.inbox(r.ref, "service-reply");
  return all.at(i)!.body;
}

describe("status", () => {
  it("GET / answers a tiny JSON status and everything else is 404", async () => {
    const res = await r.svc.fetch(new Request("https://x.example/"), r.env, asCtx(r.ctx));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ service: "testsvc", address: "testsvc@hub.example", kind: "custom", v: "l0w/0.1", ok: true });
    for (const [method, path] of [["GET", "/api/peer/v0/inbox"], ["POST", "/"], ["GET", "/anything"], ["POST", "/api/peer/v0/other"]]) {
      expect((await r.svc.fetch(new Request(`https://x.example${path}`, { method }), r.env, asCtx(r.ctx))).status).toBe(404);
    }
  });

  it("a missing or bad seed is a 500 misconfigured, never a crash", async () => {
    const res = await r.svc.fetch(new Request("https://x.example/"), { ...r.env, SERVICE_SEED: "nope" }, asCtx(r.ctx));
    expect(res.status).toBe(500);
    expect(await err(res)).toBe("misconfigured");
  });
});

describe("hello and welcome", () => {
  it("hello -> welcome carries our token and the role grants for the member", async () => {
    const res = await r.post(await r.mara.hello(r.ref));
    expect(res.status).toBe(202);
    const [w] = await r.mara.inbox(r.ref, "service-welcome");
    expect(w.p.from).toBe("testsvc@hub.example");
    expect(w.p.seq).toBe(1);
    // the welcome carries the member's own token for the service, as every envelope does
    expect(w.p.token.payload).toBe(r.mara.issued.get(r.ref.address)!.payload);
    const token = await P.validateTokenDocument(w.body.token);
    expect(token.issuer).toBe(r.ref.address);
    expect(token.holder).toBe("mara@hub.example");
    expect(token.holder_kid).toBe(r.mara.sign.kid);
    await messages.verifyDeliveryToken(w.body.token, r.ref.sign, r.mara.sign.kid);
    expect(w.body.roles).toHaveLength(1);
    const g = await P.verifyRoleGrant(w.body.roles[0], r.ref.sign, { service: r.ref.address, holder: "mara@hub.example", holderKid: r.mara.sign.kid });
    expect(g.role).toBe("tester");
  });

  it("a member with no role gets an empty list", async () => {
    const w = await r.connect(await (async () => r.hub.add(await FakeMember.make("ola")))());
    expect(w.roles).toEqual([]);
  });

  it("hello needs a member of this hub: another domain, an unknown name and a left member are 403 not_member", async () => {
    const stranger = new FakeMember("stranger", "other.example");
    stranger.sign = await labelled("s/sign", "sign");
    stranger.seal = await labelled("s/seal", "seal");
    const res = await r.post(await stranger.hello(r.ref));
    expect([res.status, await err(res)]).toEqual([403, "not_member"]);

    const ghost = await FakeMember.make("ghost"); // not in the hub's directory
    expect((await r.post(await ghost.hello(r.ref))).status).toBe(403);

    r.hub.left.add("mara");
    expect([(await r.post(await r.mara.hello(r.ref))).status]).toEqual([403]);
  });

  it("the token in a hello must be the sender's, for this service", async () => {
    // issued by someone else
    const other = await FakeMember.make("ola");
    const t1 = await other.tokenFor(r.ref);
    let res = await r.post(await r.mara.hello(r.ref, { token: t1 }));
    expect([res.status, await err(res)]).toEqual([400, "bad_body"]);
    // issued for another holder key
    const wrong = await messages.issueDeliveryToken(r.mara.sign, r.mara.address, r.ref.address, r.mara.sign.kid);
    res = await r.post(await r.mara.hello(r.ref, { token: wrong }));
    expect([res.status, await err(res)]).toEqual([400, "bad_body"]);
    expect(await r.mara.inbox(r.ref)).toEqual([]);
  });

  it("a second hello revokes the token issued by the first", async () => {
    await r.connect(r.mara);
    const first = r.mara.serviceToken!;
    r.mara.received = [];
    await r.connect(r.mara);
    const call = await r.mara.envelope(r.ref, "service-call", { call: P.newId(), method: "echo", args: {}, role: null }, { token: first });
    expect((await r.post(call)).status).toBe(403);
    expect((await r.post(await r.mara.call(r.ref, "echo", { a: 1 }))).status).toBe(202);
  });
});

describe("calls", () => {
  beforeEach(async () => {
    await r.connect(r.mara);
  });

  it("call -> reply (echo), the reply is its own envelope matched by call id", async () => {
    const callId = P.newId();
    const res = await r.post(await r.mara.call(r.ref, "echo", { hello: "world", n: [1, 2] }, null, { callId }));
    expect(res.status).toBe(202);
    const rep = await reply(r.mara, r);
    expect(rep).toEqual({ call: callId, ok: true, result: { hello: "world", n: [1, 2] } });
    const all = await r.mara.inbox(r.ref, "service-reply");
    expect(all[0].p.seq).toBe(2); // the welcome was seq 1
  });

  it("whoami: the caller and the roles honored", async () => {
    await r.post(await r.mara.call(r.ref, "whoami"));
    expect((await reply(r.mara, r)).result).toEqual({ address: "mara@hub.example", roles: [] });
  });

  it("the service's own migrations ran and handlers get the database", async () => {
    await r.post(await r.mara.call(r.ref, "remember"));
    await r.post(await r.mara.call(r.ref, "remember"));
    expect((await reply(r.mara, r)).result).toEqual({ count: 2 });
  });

  it("unknown method, ServiceError with extra fields, a crash and a bad result", async () => {
    await r.post(await r.mara.call(r.ref, "nope"));
    expect((await reply(r.mara, r)).error.code).toBe("unknown_method");
    await r.post(await r.mara.call(r.ref, "constructor")); // not an own method
    expect((await reply(r.mara, r)).error.code).toBe("unknown_method");

    await r.post(await r.mara.call(r.ref, "refuse"));
    const e = (await reply(r.mara, r)).error;
    expect(e).toEqual({ code: "rate_limited", detail: "slow down", retry_after: 30 });

    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await r.post(await r.mara.call(r.ref, "crash"));
    let rep = await reply(r.mara, r);
    expect(rep.ok).toBe(false);
    expect(rep.error.code).toBe("internal");
    expect(JSON.stringify(rep)).not.toContain("secret internals");
    await r.post(await r.mara.call(r.ref, "notObject"));
    expect((await reply(r.mara, r)).error.code).toBe("internal");
    spy.mockRestore();
  });

  it("a result over 1 MiB becomes a too_large error reply", async () => {
    await r.post(await r.mara.call(r.ref, "big"));
    expect((await reply(r.mara, r)).error.code).toBe("too_large");
  });

  it("the call log has one row per call, without arguments", async () => {
    await r.post(await r.mara.call(r.ref, "echo", { password: "hunter2" }));
    await r.post(await r.mara.call(r.ref, "nope"));
    const rows = (await r.db.prepare("SELECT * FROM l0w_calls ORDER BY id").all<Record<string, unknown>>()).results;
    expect(rows.map((x) => [x.from_addr, x.method, x.ok, x.code])).toEqual([
      ["mara@hub.example", "echo", 1, null],
      ["mara@hub.example", "nope", 0, "unknown_method"],
    ]);
    expect(JSON.stringify(rows)).not.toContain("hunter2");
  });

  it("emit sends a service-event to a connected member and says false for anyone else", async () => {
    await r.post(await r.mara.call(r.ref, "shout", { to: "mara@hub.example", text: "hi" }));
    expect((await reply(r.mara, r)).result).toEqual({ sent: true });
    const [ev] = await r.mara.inbox(r.ref, "service-event");
    expect(ev.body).toEqual({ event: "shout", data: { text: "hi" } });
    await r.post(await r.mara.call(r.ref, "shout", { to: "ola@hub.example", text: "hi" }));
    expect((await reply(r.mara, r)).result).toEqual({ sent: false });
  });
});

describe("roles", () => {
  async function grantFor(m: FakeMember) {
    // the grant the welcome carried
    const w = await m.inbox(r.ref, "service-welcome");
    return w[0].body.roles[0] as docs.Doc;
  }

  beforeEach(async () => {
    await r.connect(r.mara);
  });

  it("secret needs the tester role: refused without it, answered with it", async () => {
    await r.post(await r.mara.call(r.ref, "secret"));
    expect((await reply(r.mara, r)).error.code).toBe("not_allowed");
    const g = await grantFor(r.mara);
    await r.post(await r.mara.call(r.ref, "secret", {}, g));
    expect((await reply(r.mara, r)).result).toEqual({ secret: "xyzzy" });
    await r.post(await r.mara.call(r.ref, "whoami", {}, g));
    expect((await reply(r.mara, r)).result).toEqual({ address: "mara@hub.example", roles: ["tester"] });
  });

  it("a grant signed by another key, or made for another holder, carries nothing", async () => {
    const forged = await docs.signDocument("role-grant", P.buildRoleGrant(r.ref.address, "mara@hub.example", r.mara.sign.kid, "tester"), [r.mara.sign]);
    await r.post(await r.mara.call(r.ref, "secret", {}, forged));
    expect((await reply(r.mara, r)).error.code).toBe("not_allowed");

    const svcKeys = await (await import("../src")).keysFromSeed(SEED);
    const forOla = await docs.signDocument("role-grant", P.buildRoleGrant(r.ref.address, "ola@hub.example", r.mara.sign.kid, "tester"), [svcKeys.sign]);
    await r.post(await r.mara.call(r.ref, "secret", {}, forOla));
    expect((await reply(r.mara, r)).error.code).toBe("not_allowed");

    const otherKid = await docs.signDocument("role-grant", P.buildRoleGrant(r.ref.address, "mara@hub.example", (await labelled("zzz", "sign")).kid, "tester"), [svcKeys.sign]);
    await r.post(await r.mara.call(r.ref, "secret", {}, otherKid));
    expect((await reply(r.mara, r)).error.code).toBe("not_allowed");
  });

  it("an expired grant carries nothing", async () => {
    const svcKeys = await (await import("../src")).keysFromSeed(SEED);
    const old = await docs.signDocument(
      "role-grant",
      P.buildRoleGrant(r.ref.address, "mara@hub.example", r.mara.sign.kid, "tester", Math.floor(Date.now() / 1000) - 7200, Math.floor(Date.now() / 1000) - 3600),
      [svcKeys.sign],
    );
    await r.post(await r.mara.call(r.ref, "secret", {}, old));
    expect((await reply(r.mara, r)).error.code).toBe("not_allowed");
  });

  it("a grant stops being honored when ROLES no longer lists the member", async () => {
    const g = await grantFor(r.mara);
    r.env.ROLES = JSON.stringify({ tester: [] });
    await r.post(await r.mara.call(r.ref, "secret", {}, g));
    expect((await reply(r.mara, r)).error.code).toBe("not_allowed");
  });

  it("changing ROLES sends the member the full new set on the next cron run, once", async () => {
    r.mara.received = [];
    r.env.ROLES = JSON.stringify({ tester: ["mara"] });
    await r.cron();
    expect(await r.mara.inbox(r.ref, "service-event")).toEqual([]); // unchanged: nothing

    r.env.ROLES = JSON.stringify({ tester: [] });
    await r.cron();
    let ev = await r.mara.inbox(r.ref, "service-event");
    expect(ev).toHaveLength(1);
    expect(ev[0].body).toEqual({ event: "roles", data: { grants: [] } });
    await r.cron();
    expect(await r.mara.inbox(r.ref, "service-event")).toHaveLength(1);

    r.env.ROLES = JSON.stringify({ tester: ["mara@hub.example"] });
    await r.cron();
    ev = await r.mara.inbox(r.ref, "service-event");
    expect(ev).toHaveLength(2);
    const grants = ev[1].body.data.grants as docs.Doc[];
    expect(grants).toHaveLength(1);
    expect((await P.verifyRoleGrant(grants[0], r.ref.sign, { holder: "mara@hub.example", holderKid: r.mara.sign.kid })).role).toBe("tester");
  });

  it("ROLES naming a role the service does not grant is ignored", async () => {
    r.env.ROLES = JSON.stringify({ tester: ["mara"], admin: ["mara"] });
    r.mara.received = [];
    await r.connect(r.mara);
    const w = await r.mara.inbox(r.ref, "service-welcome");
    expect(w[0].body.roles).toHaveLength(1);
  });
});

describe("the inbox checks", () => {
  beforeEach(async () => {
    await r.connect(r.mara);
  });

  it("413 for a body over 16 MiB, by Content-Length before it is read", async () => {
    const res = await r.post(null, { raw: "{}", headers: { "content-length": String(16 * 1024 * 1024 + 1) } });
    expect([res.status, await err(res)]).toEqual([413, "too_large"]);
  });

  it("400 for something that is not an envelope", async () => {
    expect((await r.post(null, { raw: "not json" })).status).toBe(400);
    expect((await r.post({ v: "l0w/0.1", type: "self", payload: "e30" })).status).toBe(400);
  });

  it("404 not_here when the envelope is for someone else", async () => {
    const to = { ...r.ref, address: "other@hub.example" };
    const res = await r.post(await r.mara.envelope(to, "service-call", { call: P.newId(), method: "echo", args: {}, role: null }));
    expect([res.status, await err(res)]).toEqual([404, "not_here"]);
  });

  it("403 no_token without a token, with a token for another service, with a forged one and for another sender", async () => {
    const body = { call: P.newId(), method: "echo", args: {}, role: null };
    // no token: the protocol itself refuses to build one, so strip it from a built envelope's payload
    const noTokenPayload = JSON.parse(b64.fromUtf8(b64.decode((await r.mara.call(r.ref, "echo")).payload)));
    delete noTokenPayload.token;
    const stripped = await docs.signDocument("envelope", noTokenPayload, [r.mara.sign]);
    const res0 = await r.post(stripped);
    expect([res0.status, await err(res0)]).toEqual([403, "no_token"]);

    const elsewhere = { ...r.ref, address: "elsewhere@hub.example" };
    const t = await r.mara.tokenFor(elsewhere);
    expect(await err(await r.post(await r.mara.envelope(r.ref, "service-call", body, { token: t })))).toBe("no_token");

    const forged = await messages.issueDeliveryToken(r.mara.sign, r.ref.address, r.mara.address, r.mara.sign.kid); // issuer is us in name only
    expect(await err(await r.post(await r.mara.envelope(r.ref, "service-call", body, { token: forged })))).toBe("no_token");

    // ola uses the token the service gave mara
    const ola = r.hub.members.get("ola")!;
    const res = await r.post(await ola.envelope(r.ref, "service-call", body, { token: r.mara.serviceToken }));
    expect([res.status, await err(res)]).toEqual([403, "no_token"]);
  });

  it("401 bad_signature when someone else signed, and the detail does not say which check failed", async () => {
    const mallory = await labelled("mallory", "sign");
    const forged = await r.mara.call(r.ref, "echo");
    forged.sigs = [{ kid: r.mara.sign.kid, sig: b64.encode(await mallory.sign(docs.signingInput("envelope", forged.payload))) }];
    const res = await r.post(forged);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ v: "l0w/0.1", error: "bad_signature", detail: "" });
    // signed by a key that is not mara's: the token was not issued to that key, so it is refused earlier
    const res3 = await r.post(await r.mara.envelope(r.ref, "service-call", { call: P.newId(), method: "echo", args: {}, role: null }, { signer: mallory }));
    expect([res3.status, await err(res3)]).toEqual([403, "no_token"]);
    // a flipped signature bit
    const doc = await r.mara.call(r.ref, "echo");
    const sig = b64.decode(doc.sigs![0].sig);
    sig[0] ^= 1;
    doc.sigs![0].sig = b64.encode(sig);
    const res2 = await r.post(doc);
    expect([res2.status, await err(res2)]).toEqual([401, "bad_signature"]);
  });

  it("400 for an old iat (over 8 days) and for one in the future", async () => {
    const old = Math.floor(Date.now() / 1000) - 9 * 86400;
    expect((await r.post(await r.mara.envelope(r.ref, "service-call", { call: P.newId(), method: "echo", args: {}, role: null }, { iat: old }))).status).toBe(400);
    const future = Math.floor(Date.now() / 1000) + 3600;
    expect((await r.post(await r.mara.envelope(r.ref, "service-call", { call: P.newId(), method: "echo", args: {}, role: null }, { iat: future }))).status).toBe(400);
  });

  it("400 bad_seal when sealed to another key", async () => {
    const wrongSeal = (await labelled("wrong", "seal")).key;
    const res = await r.post(await r.mara.envelope(r.ref, "service-call", { call: P.newId(), method: "echo", args: {}, role: null }, { toSeal: wrongSeal }));
    expect([res.status, await err(res)]).toEqual([400, "bad_seal"]);
  });

  it("422 unknown_kind for kinds a service does not take", async () => {
    const res = await r.post(await r.mara.envelope(r.ref, "message", { thread: "t", reply_to: null, text: "hi", files: [] }));
    expect([res.status, await err(res)]).toEqual([422, "unknown_kind"]);
  });

  it("a repeat of an envelope id is 200 {duplicate: true} and not handled twice", async () => {
    const doc = await r.mara.call(r.ref, "remember");
    expect((await r.post(doc)).status).toBe(202);
    const again = await r.post(doc);
    expect([again.status, await again.json()]).toEqual([200, { duplicate: true }]);
    const n = await r.db.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(await r.mara.inbox(r.ref, "service-reply")).toHaveLength(1);
  });

  it("a hub that cannot answer is a 503 (the sender's outbox retries), and the envelope is not marked seen", async () => {
    const doc = await r.mara.call(r.ref, "echo", { a: 1 });
    r.db.raw.exec("DELETE FROM l0w_directory");
    r.hub.directoryStatus = 500;
    const res = await r.post(doc);
    expect([res.status, await err(res)]).toEqual([503, "unavailable"]);
    r.hub.directoryStatus = null;
    expect((await r.post(doc)).status).toBe(202);
  });

  it("the directory entry is cached for five minutes and refetched for an unknown key id", async () => {
    r.hub.requests.length = 0;
    await r.post(await r.mara.call(r.ref, "echo"));
    await r.post(await r.mara.call(r.ref, "echo"));
    expect(r.hub.requests.filter((x) => x.includes("/members/mara"))).toHaveLength(0); // the hello cached it
    // mara rotates her signing key; the cached entry knows only the old one
    await r.mara.rotateSign("mara/sign2");
    r.mara.serviceToken = r.mara.serviceToken; // same token, issued to the old key
    r.hub.requests.length = 0;
    const res = await r.post(await r.mara.call(r.ref, "echo", { after: "rotation" }));
    expect(res.status).toBe(202); // token follows the rotation, entry refetched once
    expect(r.hub.requests.filter((x) => x.includes("/members/mara"))).toHaveLength(1);
    expect((await reply(r.mara, r)).result).toEqual({ after: "rotation" });
  });

  it("a key rotated without a signed rotation in the self-description is refused", async () => {
    r.mara.sign = await labelled("mara/other", "sign");
    r.mara.selfSeq++; // a new key, no history
    const res = await r.post(await r.mara.call(r.ref, "echo"));
    expect([res.status, await err(res)]).toEqual([403, "no_token"]);
  });

  it("a directory entry that goes back to an older seq is refused", async () => {
    r.mara.selfSeq = 5;
    await r.post(await r.mara.call(r.ref, "echo")); // within the cache: no fetch
    r.db.raw.exec("UPDATE l0w_directory SET fetched_at = 0");
    expect((await r.post(await r.mara.call(r.ref, "echo"))).status).toBe(202); // fetched, seq 5 stored
    r.mara.selfSeq = 2;
    r.db.raw.exec("UPDATE l0w_directory SET fetched_at = 0");
    expect((await r.post(await r.mara.call(r.ref, "echo"))).status).toBe(503);
  });
});

describe("bye", () => {
  it("forgets the member, revokes our token, drops what was queued, and later calls are refused", async () => {
    await r.connect(r.mara);
    const token = r.mara.serviceToken;
    expect((await r.post(await r.mara.envelope(r.ref, "service-bye", {}))).status).toBe(202);
    const call = await r.mara.envelope(r.ref, "service-call", { call: P.newId(), method: "echo", args: {}, role: null }, { token });
    const res = await r.post(call);
    expect([res.status, await err(res)]).toEqual([403, "no_token"]);
    expect((await r.db.prepare("SELECT count(*) AS n FROM l0w_members").first<{ n: number }>())!.n).toBe(0);
    expect((await r.db.prepare("SELECT count(*) AS n FROM l0w_tokens_held").first<{ n: number }>())!.n).toBe(0);
    const t = await r.db.prepare("SELECT revoked_at FROM l0w_tokens_issued").first<{ revoked_at: number | null }>();
    expect(t!.revoked_at).not.toBeNull();
  });

  it("onHello and onBye run, and a failing hook never fails the answer", async () => {
    const seen: string[] = [];
    const svc = createService({
      name: "testsvc",
      kind: "custom",
      methods: {},
      onHello: (ctx, info) => void seen.push(`hello ${ctx.from} ${info.release}`),
      onBye: (ctx) => {
        seen.push(`bye ${ctx.from}`);
        throw new Error("hook failed");
      },
    });
    const h = await rig({}, svc);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect((await h.post(await h.mara.hello(h.ref, { release: "1.2.3" }))).status).toBe(202);
    expect(seen).toEqual(["hello mara@hub.example 1.2.3"]);
    h.mara.serviceToken = (await h.mara.inbox(h.ref, "service-welcome"))[0].body.token;
    expect((await h.post(await h.mara.envelope(h.ref, "service-bye", {}))).status).toBe(202);
    expect(seen).toEqual(["hello mara@hub.example 1.2.3", "bye mara@hub.example"]);
    spy.mockRestore();
  });
});

describe("the outbox", () => {
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
    await r.connect(r.mara);
    r.mara.received = [];
  });

  it("a delivery that gets 503 is kept, resent as the same bytes after the backoff, and dropped once it gets a 2xx", async () => {
    r.mara.script = [503, 503];
    await r.post(await r.mara.call(r.ref, "echo", { n: 1 }));
    expect(r.mara.attempts).toBeGreaterThanOrEqual(1);
    expect(r.mara.received).toEqual([]);
    const row = () => r.db.prepare("SELECT * FROM l0w_outbox").first<{ envelope: string; attempts: number; next_at: number; last_status: number }>();
    const first = (await row())!;
    expect([first.attempts, first.last_status]).toEqual([1, 503]);
    const t0 = Math.floor(Date.now() / 1000);
    expect(first.next_at).toBe(t0 + 30);

    await r.cron(); // too early: nothing is due
    expect(r.mara.received).toEqual([]);
    vi.setSystemTime(new Date(Date.now() + 31_000));
    await r.cron(); // second 503
    const second = (await row())!;
    expect([second.attempts, second.last_status]).toEqual([2, 503]);
    expect(second.next_at).toBe(Math.floor(Date.now() / 1000) + 60);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await r.cron(); // now it goes through
    expect(r.mara.received).toHaveLength(1);
    expect(await row()).toBeNull();
    expect(JSON.stringify(r.mara.received[0])).toBe(second.envelope);
    expect((await reply(r.mara, r)).result).toEqual({ n: 1 });
  });

  it("the backoff reaches an hour and stays there", async () => {
    const { backoff } = await import("../src/outbox");
    expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(backoff)).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600, 3600]);
  });

  it("a 4xx other than 408 and 429 drops the envelope, 429 and 408 keep it, a network error keeps it", async () => {
    r.mara.script = [400];
    await r.post(await r.mara.call(r.ref, "echo"));
    expect((await r.db.prepare("SELECT count(*) AS n FROM l0w_outbox").first<{ n: number }>())!.n).toBe(0);
    for (const status of [429, 408]) {
      r.mara.script = [status];
      await r.post(await r.mara.call(r.ref, "echo"));
      expect((await r.db.prepare("SELECT count(*) AS n FROM l0w_outbox").first<{ n: number }>())!.n).toBe(1);
      r.db.raw.exec("DELETE FROM l0w_outbox");
    }
    r.mara.script = [0]; // the instance is offline: the fetch throws
    await r.post(await r.mara.call(r.ref, "echo"));
    expect((await r.db.prepare("SELECT count(*) AS n FROM l0w_outbox").first<{ n: number }>())!.n).toBe(1);
  });

  it("an envelope is given up on after 7 days", async () => {
    r.mara.script = Array(100).fill(503);
    await r.post(await r.mara.call(r.ref, "echo"));
    expect((await r.db.prepare("SELECT count(*) AS n FROM l0w_outbox").first<{ n: number }>())!.n).toBe(1);
    vi.setSystemTime(new Date(Date.now() + 7 * 86400_000 + 1000));
    // keep the entry cache and the member's token out of the way: only the age matters
    await r.cron();
    expect((await r.db.prepare("SELECT count(*) AS n FROM l0w_outbox").first<{ n: number }>())!.n).toBe(0);
  });

  it("seq counts per recipient", async () => {
    await r.post(await r.mara.call(r.ref, "echo"));
    await r.post(await r.mara.call(r.ref, "echo"));
    const all = await r.mara.inbox(r.ref);
    expect(all.map((x) => x.p.seq)).toEqual([2, 3]); // the welcome (1) was cleared from the log
    const ola = r.hub.members.get("ola")!;
    await r.connect(ola);
    expect((await ola.inbox(r.ref))[0].p.seq).toBe(1);
  });

  it("seen ids older than 9 days are purged by the cron handler, newer ones kept", async () => {
    await r.post(await r.mara.call(r.ref, "echo"));
    const n = async () => (await r.db.prepare("SELECT count(*) AS n FROM l0w_seen").first<{ n: number }>())!.n;
    const before = await n();
    vi.setSystemTime(new Date(Date.now() + 8 * 86400_000));
    await r.cron();
    expect(await n()).toBe(before);
    vi.setSystemTime(new Date(Date.now() + 2 * 86400_000));
    await r.cron();
    expect(await n()).toBe(0);
  });
});

describe("delivery routes", () => {
  it("without a HUB binding, an http dev hub gets the POST at HUB_BASE with the member's Host; the directory comes from HUB_BASE too", async () => {
    const calls: Array<{ url: string; host: string | null }> = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const host = new Headers(init?.headers).get("host");
      calls.push({ url: input, host });
      const u = new URL(input);
      return r.hub.handle(new Request(`https://${host ?? DOMAIN}${u.pathname}`, { method: init?.method ?? "GET", body: init?.body as string | undefined }));
    });
    try {
      const env = { ...r.env, HUB: undefined, HUB_BASE: "http://127.0.0.1:8770" };
      const res = await r.svc.fetch(new Request("https://x/api/peer/v0/inbox", { method: "POST", body: JSON.stringify(await r.mara.hello(r.ref)) }), env, asCtx(r.ctx));
      await r.ctx.flush();
      expect(res.status).toBe(202);
      expect(r.mara.received).toHaveLength(1);
      expect(calls.filter((c) => c.host === null).map((c) => c.url)).toEqual([
        "http://127.0.0.1:8770/.well-known/l0wagent/members/mara",
        "http://127.0.0.1:8770/.well-known/l0wagent/hub",
      ]);
      expect(calls.filter((c) => c.host).map((c) => [c.url, c.host])).toEqual([["http://127.0.0.1:8770/api/peer/v0/inbox", "mara.hub.example"]]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("with the binding, every request to the hub and to a member goes through it", async () => {
    const stub = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", stub);
    try {
      await r.connect(r.mara);
      await r.post(await r.mara.call(r.ref, "echo"));
      expect(stub).not.toHaveBeenCalled();
      expect(r.hub.requests).toContain("POST mara.hub.example/api/peer/v0/inbox");
      expect(r.hub.requests).toContain("GET hub.example/.well-known/l0wagent/hub");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the hub's key", () => {
  it("is pinned the first time and a different key is refused (a directory entry the pinned key did not sign is a 503)", async () => {
    await r.connect(r.mara);
    const evil = await labelled("evil-hub", "sign");
    r.hub.key = evil; // the hub's key changed with no rotation
    r.db.raw.exec("UPDATE l0w_directory SET fetched_at = 0");
    const res = await r.post(await r.mara.call(r.ref, "echo"));
    expect([res.status, await err(res)]).toEqual([503, "unavailable"]);
  });

  it("follows a rotation signed by the pinned key", async () => {
    await r.connect(r.mara);
    const oldKey = r.hub.key;
    const next = await labelled("hub-2", "sign");
    r.hub.history = [await docs.signDocument("rotation", P.buildRotation("hub@hub.example", oldKey.kid, next.key), [oldKey])];
    r.hub.key = next;
    r.db.raw.exec("UPDATE l0w_directory SET fetched_at = 0");
    expect((await r.post(await r.mara.call(r.ref, "echo"))).status).toBe(202);
    const pinned = await r.db.prepare("SELECT value FROM l0w_state WHERE key = 'hub_key'").first<{ value: string }>();
    expect(JSON.parse(pinned!.value).kid).toBe(next.kid);
  });
});

describe("migrations", () => {
  it("the generated core migrations match migrations/*.sql", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { CORE_MIGRATIONS } = await import("../src");
    const dir = join(import.meta.dirname, "..", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(CORE_MIGRATIONS).toEqual(files.map((f) => ({ name: f.replace(/\.sql$/, ""), sql: readFileSync(join(dir, f), "utf8") })));
  });

  it("the service's own migrations run once, after the framework's, and are recorded", async () => {
    await r.connect(r.mara);
    const names = (await r.db.prepare("SELECT name FROM l0w_migrations ORDER BY applied_at, name").all<{ name: string }>()).results.map((x) => x.name);
    expect(names).toContain("0001_core");
    expect(names).toContain("svc:0100_things");
    const { migrate } = await import("../src");
    await migrate(r.db, [{ name: "0100_things", sql: "SELECT 1;" }]); // already applied: not run again
  });

  it("splitStatements drops comment lines and splits at line-ending semicolons", async () => {
    const { splitStatements } = await import("../src");
    expect(splitStatements("-- c\nCREATE TABLE a (x INTEGER);\n\nINSERT INTO a VALUES (1);\n")).toEqual(["CREATE TABLE a (x INTEGER)", "INSERT INTO a VALUES (1)"]);
  });
});
