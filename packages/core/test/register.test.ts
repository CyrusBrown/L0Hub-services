import { docs, payloads as P } from "@l0w/proto";
import { describe, expect, it } from "vitest";
import { buildRegistration, hostnamesFromCapabilities, keysFromSeed, registerWithHub, type RegisterSpec } from "../src";
import { FakeHub, FakeMember, SEED } from "./helpers";

const spec = (over: Partial<RegisterSpec> = {}): RegisterSpec => ({
  seed: SEED,
  name: "board",
  kind: "board",
  title: "Board",
  description: "Topics and posts",
  docs: "https://hub.example/services/board",
  roles: ["moderator", "poster"],
  extension: { git: "https://git.example/l0wservices.git", commit: "a".repeat(40), path: "extensions/board" },
  default: "on",
  ...over,
});

describe("hostnames", () => {
  it("are the capabilities' example with the example name replaced", async () => {
    const hub = await FakeHub.make();
    const caps = JSON.parse(atob(((await hub.capabilities()).payload).replace(/-/g, "+").replace(/_/g, "/")));
    expect(hostnamesFromCapabilities(caps, "board")).toEqual({ instance: "board.hub.example", files: "files--board.hubfiles.example" });
  });

  it("work for nested and flat layouts, ports, and refuse an example they cannot read", () => {
    const caps = (instance: string, files: string, name = "username") => ({ hostnames: { example: { name, instance, files } } });
    expect(hostnamesFromCapabilities(caps("username.localhost:8770", "files--username.localhost:8770"), "spaces")).toEqual({
      instance: "spaces.localhost:8770",
      files: "files--spaces.localhost:8770",
    });
    expect(hostnamesFromCapabilities(caps("username.hub.example", "files.username.hub.example"), "board").files).toBe("files.board.hub.example");
    // a name that is part of the domain is left alone
    expect(hostnamesFromCapabilities(caps("username.username-hub.example", "f--username.hubfiles.example"), "board").instance).toBe("board.username-hub.example");
    expect(() => hostnamesFromCapabilities(caps("hub.example", "files.example"), "board")).toThrow(/cannot find/);
    expect(() => hostnamesFromCapabilities({}, "board")).toThrow(/hostnames.example/);
  });
});

describe("the registration", () => {
  it("is a signed self document with the service's own derived keys, and the facts", async () => {
    const hub = await FakeHub.make();
    const caps = JSON.parse(atob((await hub.capabilities()).payload.replace(/-/g, "+").replace(/_/g, "/")));
    const { address, body } = await buildRegistration(spec(), caps, 4);
    expect(address).toBe("board@hub.example");
    expect(body).toMatchObject({ kind: "board", title: "Board", roles: ["moderator", "poster"], default: "on", extension: { path: "extensions/board" } });
    const self = await P.verifySelf(body.self);
    expect(self.address).toBe(address);
    expect(self.seq).toBe(4);
    expect(self.hostnames).toEqual({ instance: "board.hub.example", files: "files--board.hubfiles.example" });
    const k = await keysFromSeed(SEED);
    expect(self.keys.map((x: { kid: string }) => x.kid)).toEqual([k.sign.kid, k.seal.kid, k.recover.kid]);
    // the same seed gives the same keys every time, and the three uses differ
    const again = await keysFromSeed(SEED);
    expect(again.sign.kid).toBe(k.sign.kid);
    expect(new Set([k.sign.kid, k.seal.kid, k.recover.kid]).size).toBe(3);
    expect((await keysFromSeed(btoa("x".repeat(32)).replace(/=/g, ""))).sign.kid).not.toBe(k.sign.kid);
  });

  it("is checked like the hub checks it: bad roles and kinds are refused before sending", async () => {
    const hub = await FakeHub.make();
    const caps = JSON.parse(atob((await hub.capabilities()).payload.replace(/-/g, "+").replace(/_/g, "/")));
    await expect(buildRegistration(spec({ roles: ["Bad Role"] }), caps, 0)).rejects.toThrow();
    await expect(buildRegistration(spec({ kind: "nonsense" }), caps, 0)).rejects.toThrow();
    await expect(buildRegistration(spec({ extension: { git: "https://x.example/r.git", commit: "main", path: "a" } }), caps, 0)).rejects.toThrow();
  });
});

describe("registerWithHub", () => {
  async function setup() {
    const hub = await FakeHub.make();
    const puts: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
    let status = 201;
    const fetchStub = (async (input: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts.push({ url: input, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify(status < 300 ? { name: "board" } : { error: "bad_self" }), { status });
      }
      return hub.handle(new Request(input.replace("http://hub.test", "https://hub.example"), init));
    }) as typeof fetch;
    return { hub, puts, fetchStub, setStatus: (s: number) => (status = s) };
  }

  it("PUTs the body to /v0/admin/services/<name> with the admin token", async () => {
    const { puts, fetchStub } = await setup();
    const r = await registerWithHub({ hub: "http://hub.test/", adminToken: "tok", spec: spec(), fetch: fetchStub });
    expect(r.status).toBe(201);
    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe("http://hub.test/v0/admin/services/board");
    expect(puts[0].auth).toBe("Bearer tok");
    expect((await P.verifySelf(puts[0].body.self)).seq).toBe(0); // no entry yet
  });

  it("takes the next seq from the directory's current entry, an explicit seq wins, and --dry-run sends nothing", async () => {
    const { hub, puts, fetchStub } = await setup();
    const existing = hub.add(await FakeMember.make("board"));
    existing.selfSeq = 3;
    await registerWithHub({ hub: "http://hub.test", adminToken: "tok", spec: spec(), fetch: fetchStub });
    expect((await P.verifySelf(puts[0].body.self)).seq).toBe(4);
    await registerWithHub({ hub: "http://hub.test", adminToken: "tok", spec: spec({ seq: 9 }), fetch: fetchStub });
    expect((await P.verifySelf(puts[1].body.self)).seq).toBe(9);
    const dry = await registerWithHub({ hub: "http://hub.test", adminToken: "", spec: spec(), dryRun: true, fetch: fetchStub });
    expect(dry.status).toBe(0);
    expect(puts).toHaveLength(2);
  });

  it("reports the hub's refusal", async () => {
    const { fetchStub, setStatus } = await setup();
    setStatus(400);
    await expect(registerWithHub({ hub: "http://hub.test", adminToken: "tok", spec: spec(), fetch: fetchStub })).rejects.toThrow(/400.*bad_self/);
  });

  it("does not trust capabilities that do not verify", async () => {
    const { hub } = await setup();
    const bad = (async (input: string) => {
      const caps = await hub.capabilities();
      return new Response(JSON.stringify({ ...caps, sigs: [{ kid: caps.sigs![0].kid, sig: "A".repeat(86) }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(registerWithHub({ hub: "http://hub.test", adminToken: "t", spec: spec(), fetch: bad })).rejects.toThrow(/do not verify/);
    void docs;
  });
});
