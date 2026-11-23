// A board Worker behind the core package's fake hub and fake members: real envelopes, end to end.
import { messages, payloads as P, type docs } from "@l0w/proto";
import { keysFromSeed, type Obj } from "@l0wservices/core";
import { vi } from "vitest";
import { fakeD1 } from "../../../packages/core/test/d1";
import { BASE, Ctx, DOMAIN, FakeHub, FakeMember, INBOX, SEED, asCtx, type ServiceRef } from "../../../packages/core/test/helpers";
import worker from "../src/index";
import type { BoardEnv } from "../src/config";

export interface Reply {
  call: string;
  ok: boolean;
  result?: Obj;
  error?: Obj;
}

export interface Event {
  event: string;
  data: Obj;
}

const HOST = `board.${DOMAIN}`;

export class BoardRig {
  hub!: FakeHub;
  db = fakeD1();
  env!: BoardEnv;
  ref!: ServiceRef;
  ctx = new Ctx();
  m: Record<string, FakeMember> = {};
  grants = new Map<string, docs.Doc[]>();
  private seen = new Map<FakeMember, { n: number; replies: Map<string, Reply>; events: Event[] }>();

  static async make(opts: { roles?: Record<string, string[]>; vars?: Partial<BoardEnv>; members?: string[] } = {}): Promise<BoardRig> {
    const r = new BoardRig();
    r.hub = await FakeHub.make();
    for (const n of opts.members ?? ["mara", "ola", "kai", "pia", "zed"]) r.m[n] = r.hub.add(await FakeMember.make(n));
    r.env = {
      SERVICE_SEED: SEED,
      HUB_DOMAIN: DOMAIN,
      HUB_BASE: BASE,
      HUB: r.hub.fetcher,
      ROLES: JSON.stringify(opts.roles ?? { moderator: ["mara"] }),
      DB: r.db,
      ADMIN_TOKEN: "admin-secret",
      HELD_FIRST_POSTS: 0, // tests that want held posts say so
      ...opts.vars,
    };
    const k = await keysFromSeed(SEED);
    r.ref = { address: `board@${DOMAIN}`, sign: k.sign.key, seal: k.seal.key };
    return r;
  }

  /** POST an envelope to the board's inbox, then let the deliveries it started finish. */
  async post(doc: unknown): Promise<Response> {
    const res = await worker.fetch(new Request(`https://${HOST}${INBOX}`, { method: "POST", body: JSON.stringify(doc) }), this.env, asCtx(this.ctx));
    await this.ctx.flush();
    return res;
  }

  async connect(...names: string[]): Promise<void> {
    for (const n of names) {
      const m = this.m[n];
      const res = await this.post(await m.hello(this.ref));
      if (res.status !== 202) throw new Error(`hello answered ${res.status}`);
      const w = (await this.decode(m)).find((x) => x.p.kind === "service-welcome")!;
      m.serviceToken = w.body.token;
      this.grants.set(n, w.body.roles);
    }
  }

  private async decode(m: FakeMember): Promise<Array<{ p: Obj; body: Obj }>> {
    const s = this.seen.get(m) ?? { n: 0, replies: new Map<string, Reply>(), events: [] as Event[] };
    this.seen.set(m, s);
    const out: Array<{ p: Obj; body: Obj }> = [];
    for (const d of m.received.slice(s.n)) {
      const [p, body] = await messages.openEnvelope(d, { myAddress: m.address, mySealKeys: { [m.seal.kid]: m.seal.private }, senderSignKey: this.ref.sign });
      out.push({ p, body });
      if (p.kind === "service-reply") s.replies.set(body.call, body as Reply);
      if (p.kind === "service-event") s.events.push(body as Event);
    }
    s.n = m.received.length;
    return out;
  }

  /** Call a method as `name`; `mod` attaches the moderator grant. Returns the whole reply. */
  async raw(name: string, method: string, args: Obj = {}, mod = false): Promise<Reply> {
    const m = this.m[name];
    const callId = P.newId();
    const grant = mod ? (this.grants.get(name) ?? [])[0] ?? null : null; // the board grants one role: moderator
    const res = await this.post(await m.call(this.ref, method, args, grant ?? null, { callId }));
    if (res.status !== 202) throw new Error(`call answered ${res.status}: ${await res.text()}`);
    await this.decode(m);
    return this.seen.get(m)!.replies.get(callId)!;
  }

  /** The result of a call that must succeed. */
  async ok(name: string, method: string, args: Obj = {}, mod = false): Promise<Obj> {
    const r = await this.raw(name, method, args, mod);
    if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r.error)}`);
    return r.result!;
  }

  /** The error of a call that must fail. */
  async err(name: string, method: string, args: Obj = {}, mod = false): Promise<Obj> {
    const r = await this.raw(name, method, args, mod);
    if (r.ok) throw new Error(`${method} should have failed: ${JSON.stringify(r.result)}`);
    return r.error!;
  }

  /** Events the member has received (all of them, or of one kind). */
  async events(name: string, kind?: string): Promise<Event[]> {
    const m = this.m[name];
    await this.decode(m);
    return this.seen.get(m)!.events.filter((e) => !kind || e.event === kind);
  }

  async cron(): Promise<void> {
    await worker.scheduled({} as ScheduledController, this.env, asCtx(this.ctx));
    await this.ctx.flush();
  }

  /** Admin API. */
  async admin(method: string, path: string, body?: unknown, token: string | null = "admin-secret"): Promise<{ status: number; json: Obj }> {
    const res = await worker.fetch(
      new Request(`https://${HOST}/v0/admin${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      }),
      this.env,
      asCtx(this.ctx),
    );
    return { status: res.status, json: (await res.json()) as Obj };
  }

  /** Move the clock (Date only; call `vi.useFakeTimers({ toFake: ["Date"] })` first). */
  advance(seconds: number): void {
    vi.setSystemTime(Date.now() + seconds * 1000);
  }

  /** A topic made by the moderator. */
  async topic(slug = "ml", title = "Machine learning"): Promise<Obj> {
    return ((await this.ok("mara", "mod.topic.create", { slug, title, description: `About ${title}` }, true)).topic as Obj);
  }
}
