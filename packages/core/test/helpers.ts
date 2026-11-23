// A fake hub (served by an in-test fetch stub), a fake member made with @l0w/proto, and a test service.
import { b64, docs, keys, messages, payloads as P } from "@l0w/proto";
import { createService, ServiceError, type ServiceEnv, keysFromSeed, type Doc, type Obj } from "../src";
import { fakeD1 } from "./d1";

export const DOMAIN = "hub.example";
export const BASE = "https://hub.example";
export const IAT = "2026-11-17T21:30:00Z";
export const SEED = b64.encode(new Uint8Array(32).fill(7));
export const INBOX = "/api/peer/v0/inbox";

/** A key pair from a seed made by hashing a label. */
export async function labelled(label: string, use: string): Promise<keys.KeyPair> {
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", b64.utf8(label)));
  return keys.fromSeed(seed, use, IAT);
}

export class Ctx {
  pending: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>): void {
    this.pending.push(p);
  }
  passThroughOnException(): void {}
  /** Wait for everything handed to waitUntil (a reply's first delivery attempt). */
  async flush(): Promise<void> {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }
}
export const asCtx = (c: Ctx) => c as unknown as ExecutionContext;

// --- the fake member ---------------------------------------------------------------------------

export class FakeMember {
  address: string;
  host: string;
  sign!: keys.KeyPair;
  seal!: keys.KeyPair;
  recover!: keys.KeyPair;
  selfSeq = 0;
  history: Doc[] = [];
  /** the tokens this member issued to services, by service address */
  issued = new Map<string, Doc>();
  /** the token the service gave this member (from its welcome) */
  serviceToken: Doc | null = null;
  /** what the member's instance received */
  received: Doc[] = [];
  /** statuses for the next deliveries to this member's inbox (then 202) */
  script: number[] = [];
  attempts = 0;
  seq = 0;

  constructor(
    readonly name: string,
    domain = DOMAIN,
  ) {
    this.address = `${name}@${domain}`;
    this.host = `${name}.${domain}`;
  }

  static async make(name: string, label = name): Promise<FakeMember> {
    const m = new FakeMember(name);
    m.sign = await labelled(`${label}/sign`, "sign");
    m.seal = await labelled(`${label}/seal`, "seal");
    m.recover = await labelled(`${label}/recover`, "recover");
    return m;
  }

  async selfDoc(): Promise<Doc> {
    const p = P.buildSelf(this.address, this.selfSeq, [this.sign.key, this.seal.key, this.recover.key], { instance: this.host, files: `files--${this.name}.hubfiles.example` }, { history: this.history });
    return docs.signDocument("self", p, [this.sign]);
  }

  /** Rotate the signing key: a rotation document signed by the old key, a new self (seq + 1) signed by the new one. */
  async rotateSign(label: string): Promise<void> {
    const next = await labelled(label, "sign");
    const rot = await docs.signDocument("rotation", P.buildRotation(this.address, this.sign.kid, next.key), [this.sign]);
    this.history.push(rot);
    this.sign = next;
    this.selfSeq++;
  }

  /** The token this member issues to a service: the service holds it, and its holder is the service. */
  async tokenFor(service: ServiceRef): Promise<Doc> {
    const t = await messages.issueDeliveryToken(this.sign, this.address, service.address, service.sign.kid);
    this.issued.set(service.address, t);
    return t;
  }

  async envelope(
    service: ServiceRef,
    kind: string,
    body: Obj,
    opts: { token?: Doc | null; signer?: keys.KeyPair; seq?: number; iat?: string | number; envId?: string; toSeal?: keys.Key } = {},
  ): Promise<Doc> {
    const token = opts.token === undefined ? this.serviceToken : opts.token;
    const signer = opts.signer ?? this.sign;
    return messages.makeEnvelope(signer, signer.kid, this.address, service.address, opts.toSeal ?? service.seal, kind, body, opts.seq ?? ++this.seq, token, { iat: opts.iat, envId: opts.envId });
  }

  async hello(service: ServiceRef, opts: { release?: string; token?: Doc } = {}): Promise<Doc> {
    return this.envelope(service, "service-hello", { token: opts.token ?? (await this.tokenFor(service)), release: opts.release ?? "0.9.0" }, { token: null });
  }

  call(service: ServiceRef, method: string, args: Obj = {}, role: Doc | null = null, opts: { callId?: string } = {}): Promise<Doc> {
    return this.envelope(service, "service-call", { call: opts.callId ?? P.newId(), method, args, role });
  }

  /** What the member's instance gets from the service: decoded envelopes of the given kind. */
  async inbox(service: ServiceRef, kind?: string): Promise<Array<{ p: Obj; body: Obj }>> {
    const out: Array<{ p: Obj; body: Obj }> = [];
    for (const d of this.received) {
      const [p, body] = await messages.openEnvelope(d, { myAddress: this.address, mySealKeys: { [this.seal.kid]: this.seal.private }, senderSignKey: service.sign });
      if (!kind || p.kind === kind) out.push({ p, body });
    }
    return out;
  }

  /** The member instance's inbox endpoint. */
  async deliver(req: Request): Promise<Response> {
    this.attempts++;
    const status = this.script.shift() ?? 202;
    if (status === 0) throw new TypeError("fetch failed"); // offline
    if (status < 300) this.received.push(JSON.parse(await req.text()));
    return new Response(JSON.stringify({ ok: status < 300 }), { status });
  }
}

export interface ServiceRef {
  address: string;
  sign: keys.Key;
  seal: keys.Key;
}

// --- the fake hub ------------------------------------------------------------------------------

export class FakeHub {
  key!: keys.KeyPair;
  members = new Map<string, FakeMember>();
  left = new Set<string>();
  /** directory answers: set to a status to make the directory fail */
  directoryStatus: number | null = null;
  requests: string[] = [];
  history: Doc[] = [];
  fetcher: Fetcher = { fetch: (input: RequestInfo | URL, init?: RequestInit) => this.handle(new Request(input as string, init)) } as unknown as Fetcher;

  static async make(label = "hub"): Promise<FakeHub> {
    const h = new FakeHub();
    h.key = await labelled(label, "sign");
    return h;
  }

  add(m: FakeMember): FakeMember {
    this.members.set(m.name, m);
    return m;
  }

  async capabilities(): Promise<Doc> {
    const payload = P.buildHub({
      name: "Test hub",
      domain: DOMAIN,
      keys: [this.key.key],
      api: `${BASE}/v0/`,
      tunnel: `wss://${DOMAIN}/v0/tunnel`,
      minRelease: "0.8.0",
      membership: { invites: true, signups: "closed", require_2fa: true },
      hostnames: { layout: "two-domains", example: { name: "username", instance: `username.${DOMAIN}`, files: "files--username.hubfiles.example" } },
      limits: { tunnel_streams: 64, request_body_bytes: 1048576, auth_rate_per_minute: 20 },
    });
    if (this.history.length) payload.history = this.history;
    return docs.signDocument("hub", payload, [this.key]);
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.requests.push(`${req.method} ${url.host}${url.pathname}`);
    const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.host === DOMAIN) {
      if (url.pathname === "/.well-known/l0wagent/hub") return j(await this.capabilities());
      const m = /^\/\.well-known\/l0wagent\/members\/([^/]+)$/.exec(url.pathname);
      if (m) {
        if (this.directoryStatus !== null) return j({ error: "down" }, this.directoryStatus);
        if (this.left.has(m[1])) return j({ error: "left" }, 410);
        const member = this.members.get(m[1]);
        if (!member) return j({ error: "no_such_member" }, 404);
        return j(await docs.countersignDirectory(await member.selfDoc(), this.key));
      }
      return j({ error: "not_found" }, 404);
    }
    for (const member of this.members.values()) {
      if (url.host === member.host && url.pathname === INBOX && req.method === "POST") return member.deliver(req);
    }
    return j({ error: "no_route" }, 502);
  }
}

// --- the test service --------------------------------------------------------------------------

export interface TestEnv extends ServiceEnv {}

export const SERVICE_NAME = "testsvc";

export const testService = () =>
  createService<TestEnv>({
    name: SERVICE_NAME,
    kind: "custom",
    roles: ["tester"],
    migrations: [{ name: "0100_things", sql: "CREATE TABLE IF NOT EXISTS things (id INTEGER PRIMARY KEY, who TEXT NOT NULL);\n" }],
    methods: {
      echo: { handler: async (_ctx, args) => args },
      whoami: { handler: async (ctx) => ({ address: ctx.from, roles: ctx.roles }) },
      secret: { role: "tester", handler: async () => ({ secret: "xyzzy" }) },
      remember: {
        handler: async (ctx) => {
          await ctx.db.prepare("INSERT INTO things (who) VALUES (?)").bind(ctx.from).run();
          const n = await ctx.db.prepare("SELECT count(*) AS n FROM things").first<{ n: number }>();
          return { count: n!.n };
        },
      },
      refuse: {
        handler: async () => {
          throw new ServiceError("rate_limited", "slow down", { retry_after: 30, code: "ignored" });
        },
      },
      crash: {
        handler: async () => {
          throw new Error("secret internals");
        },
      },
      notObject: { handler: (async () => 5) as unknown as () => Promise<Obj> },
      big: { handler: async () => ({ blob: "x".repeat(1_100_000) }) },
      shout: {
        handler: async (ctx, args) => ({ sent: await ctx.emit(String(args.to), "shout", { text: String(args.text) }) }),
      },
    },
  });

export interface Rig {
  hub: FakeHub;
  db: ReturnType<typeof fakeD1>;
  env: TestEnv;
  svc: ReturnType<typeof testService>;
  ctx: Ctx;
  ref: ServiceRef;
  mara: FakeMember;
  /** POST an envelope to the service's inbox, then let the deliveries it started finish. */
  post(doc: unknown, init?: { headers?: Record<string, string>; raw?: string }): Promise<Response>;
  /** Connect a member: hello in, welcome out (and the token from it kept). */
  connect(m: FakeMember): Promise<Obj>;
  /** Run the cron handler. */
  cron(): Promise<void>;
}

export async function rig(roles: Record<string, string[]> = { tester: ["mara"] }, service?: ReturnType<typeof testService>): Promise<Rig> {
  const hub = await FakeHub.make();
  const mara = hub.add(await FakeMember.make("mara"));
  hub.add(await FakeMember.make("ola"));
  const db = fakeD1();
  const env: TestEnv = { SERVICE_SEED: SEED, HUB_DOMAIN: DOMAIN, HUB_BASE: BASE, HUB: hub.fetcher, ROLES: JSON.stringify(roles), DB: db };
  const k = await keysFromSeed(SEED);
  const ref: ServiceRef = { address: `${SERVICE_NAME}@${DOMAIN}`, sign: k.sign.key, seal: k.seal.key };
  const svc = service ?? testService();
  const ctx = new Ctx();
  const r: Rig = {
    hub,
    db,
    env,
    svc,
    ctx,
    ref,
    mara,
    async post(doc, init = {}) {
      const res = await svc.fetch(
        new Request(`https://${SERVICE_NAME}.${DOMAIN}${INBOX}`, { method: "POST", body: init.raw ?? JSON.stringify(doc), headers: init.headers }),
        env,
        asCtx(ctx),
      );
      await ctx.flush();
      return res;
    },
    async connect(m) {
      const res = await r.post(await m.hello(ref));
      if (res.status !== 202) throw new Error(`hello answered ${res.status}: ${await res.text()}`);
      const [w] = await m.inbox(ref, "service-welcome");
      m.serviceToken = w.body.token;
      return w.body;
    },
    async cron() {
      await svc.scheduled({} as ScheduledController, env, asCtx(ctx));
      await ctx.flush();
    },
  };
  return r;
}
