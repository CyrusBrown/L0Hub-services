// A world for the spaces service: the core's fake hub and members, an in-memory R2, and a Durable Object namespace that runs the
// real `Space` class (one instance per space id, as on Cloudflare) over the same D1.
import { b64, docs, keys, messages, payloads as P, seal, times } from "@l0w/proto";
import { keysFromSeed, type Doc, type Obj } from "@l0wservices/core";
import { Ctx, FakeHub, FakeMember, SEED, asCtx, DOMAIN, BASE, INBOX, labelled, type ServiceRef } from "@l0wservices/core/test/helpers";
import { fakeD1 } from "@l0wservices/core/test/d1";
import worker, { Space, type SpacesEnv } from "../src/index";
import { versionId } from "../src/verify";

export { FakeMember, DOMAIN };

export class FakeR2 {
  objects = new Map<string, Uint8Array>();
  puts: string[] = [];
  async put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string): Promise<unknown> {
    let bytes: Uint8Array;
    if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, bytes);
    this.puts.push(key);
    return {};
  }
  async get(key: string): Promise<unknown> {
    const b = this.objects.get(key);
    return b ? { size: b.length, body: new Response(b).body } : null;
  }
  async delete(k: string | string[]): Promise<void> {
    for (const key of Array.isArray(k) ? k : [k]) this.objects.delete(key);
  }
  async list(o: { prefix?: string } = {}): Promise<unknown> {
    return { objects: [...this.objects.keys()].filter((k) => k.startsWith(o.prefix ?? "")).map((key) => ({ key })), truncated: false };
  }
}

/** One Space object per id, made on first use, each running one command at a time. */
export class FakeNamespace {
  objects = new Map<string, Space>();
  constructor(private env: () => SpacesEnv) {}
  idFromName(name: string): string {
    return name;
  }
  get(id: string) {
    return {
      fetch: (input: string, init?: RequestInit) => {
        let o = this.objects.get(id);
        if (!o) this.objects.set(id, (o = new Space({} as DurableObjectState, this.env())));
        return o.fetch(new Request(input, init));
      },
    };
  }
}

export const K = (n = 1): Uint8Array => new Uint8Array(32).fill(n);
export const randomBlobId = (epoch = 1): string => `e${epoch}.${b64.encode(crypto.getRandomValues(new Uint8Array(32)))}`;
export const stored = (n: number): Uint8Array => {
  const b = crypto.getRandomValues(new Uint8Array(n));
  b[0] = 1;
  return b;
};

export interface Reply {
  ok: boolean;
  result?: Obj;
  error?: Obj;
}

export class World {
  hub!: FakeHub;
  db = fakeD1();
  r2 = new FakeR2();
  ns = new FakeNamespace(() => this.env);
  env!: SpacesEnv;
  ctx = new Ctx();
  ref!: ServiceRef;
  cursors = new Map<string, number>();
  m: Record<string, FakeMember> = {};

  static async make(vars: Partial<SpacesEnv> = {}, names = ["mara", "ola", "pat", "zed"]): Promise<World> {
    const w = new World();
    w.hub = await FakeHub.make();
    for (const n of names) w.m[n] = w.hub.add(await FakeMember.make(n));
    w.env = {
      SERVICE_SEED: SEED,
      HUB_DOMAIN: DOMAIN,
      HUB_BASE: BASE,
      HUB: w.hub.fetcher,
      DB: w.db,
      BLOBS: w.r2 as unknown as R2Bucket,
      SPACE: w.ns as unknown as DurableObjectNamespace,
      TICKET_KEY: "test ticket key",
      ...vars,
    };
    const k = await keysFromSeed(SEED);
    w.ref = { address: `spaces@${DOMAIN}`, sign: k.sign.key, seal: k.seal.key };
    for (const n of names) await w.connect(w.m[n]);
    return w;
  }

  async post(doc: unknown): Promise<Response> {
    const res = await worker.fetch(new Request(`https://spaces.${DOMAIN}${INBOX}`, { method: "POST", body: JSON.stringify(doc) }), this.env, asCtx(this.ctx));
    await this.ctx.flush();
    return res;
  }

  async connect(m: FakeMember): Promise<void> {
    const res = await this.post(await m.hello(this.ref));
    if (res.status !== 202) throw new Error(`hello answered ${res.status}`);
    const [w] = await m.inbox(this.ref, "service-welcome");
    m.serviceToken = w.body.token;
  }

  async call(m: FakeMember, method: string, args: Obj = {}): Promise<Reply> {
    const callId = P.newId();
    const res = await this.post(await m.call(this.ref, method, args, null, { callId }));
    if (res.status !== 202) throw new Error(`call answered ${res.status}: ${await res.text()}`);
    const all = await m.inbox(this.ref, "service-reply");
    const r = all.find((x) => x.body.call === callId);
    if (!r) throw new Error("no reply");
    return r.body as Reply;
  }

  /** The result, or a thrown error naming the code (for the happy paths). */
  async ok(m: FakeMember, method: string, args: Obj = {}): Promise<Obj> {
    const r = await this.call(m, method, args);
    if (!r.ok) throw new Error(`${method} failed: ${JSON.stringify(r.error)}`);
    return r.result!;
  }

  /** The error object of a call that must fail. */
  async fail(m: FakeMember, method: string, args: Obj = {}): Promise<Obj> {
    const r = await this.call(m, method, args);
    if (r.ok) throw new Error(`${method} succeeded: ${JSON.stringify(r.result)}`);
    return r.error!;
  }

  /** Events this member got since the last time it asked. */
  async events(m: FakeMember, name?: string): Promise<Array<{ event: string; data: Obj }>> {
    const all = await m.inbox(this.ref, "service-event");
    const from = this.cursors.get(m.address) ?? 0;
    this.cursors.set(m.address, all.length);
    return all.slice(from).map((x) => ({ event: x.body.event as string, data: x.body.data as Obj })).filter((e) => !name || e.event === name);
  }

  /** The member's seal key changes (its self document gets a higher seq); it keeps the old private key, as an instance does. */
  async rotateSeal(m: FakeMember, label: string): Promise<void> {
    const olds = [...((m as unknown as { olds?: keys.KeyPair[] }).olds ?? []), m.seal];
    (m as unknown as { olds: keys.KeyPair[] }).olds = olds;
    m.seal = await labelled(label, "seal");
    m.selfSeq++;
    const ref = this.ref;
    m.inbox = async (_service: unknown, kind?: string) => {
      const out: Array<{ p: Obj; body: Obj }> = [];
      const all = Object.fromEntries([...olds, m.seal].map((k) => [k.kid, k.private]));
      for (const d of m.received) {
        const [p, body] = await messages.openEnvelope(d, { myAddress: m.address, mySealKeys: all, senderSignKey: ref.sign });
        if (!kind || p.kind === kind) out.push({ p, body });
      }
      return out;
    };
    this.db.raw.prepare("UPDATE l0w_directory SET fetched_at = 0").run(); // the service's directory cache expires
  }

  async cron(): Promise<void> {
    await worker.scheduled({} as ScheduledController, this.env, asCtx(this.ctx));
    await this.ctx.flush();
  }

  // --- documents -------------------------------------------------------------------------------

  async keyDoc(granter: FakeMember, space: string, epoch: number, to: FakeMember, secret = K(epoch), opts: { granterKey?: keys.KeyPair; sealKid?: string; mutate?: (p: Obj) => void } = {}): Promise<Doc> {
    const kid = opts.sealKid ?? to.seal.kid;
    const signer = opts.granterKey ?? granter.sign;
    const info = b64.utf8(`l0wagent-space-key/1\n${space}\n${epoch}\n${to.address}\n${kid}\n${granter.address}\n${signer.kid}`);
    const sealed = seal.seal(to.seal.key.pub, secret, info);
    const p: Obj = {
      v: "l0w/0.1", type: "space-key", iat: times.formatTime(Math.floor(Date.now() / 1000)), space, epoch,
      member: to.address, member_kid: kid, granter: granter.address, granter_kid: signer.kid, sealed,
    };
    opts.mutate?.(p);
    return docs.signDocument("space-key", p, [signer]);
  }

  async versionDoc(author: FakeMember, space: string, seq: number, parent: string | null, epoch: number, blobs: string[], opts: { signer?: keys.KeyPair; mutate?: (p: Obj) => void } = {}): Promise<Doc> {
    const p: Obj = {
      v: "l0w/0.1", type: "space-version", iat: times.formatTime(Math.floor(Date.now() / 1000)), space, seq, parent, epoch, author: author.address,
      blobs: [...new Set(blobs)].sort(), meta: { nonce: b64.encode(crypto.getRandomValues(new Uint8Array(12))), ct: b64.encode(crypto.getRandomValues(new Uint8Array(40))) },
    };
    opts.mutate?.(p);
    return docs.signDocument("space-version", p, [opts.signer ?? author.sign]);
  }

  // --- flows -----------------------------------------------------------------------------------

  /** mara creates space `id` (epoch 1). */
  async create(creator: FakeMember, id: string, name = "frame"): Promise<Obj> {
    return (await this.ok(creator, "space.create", { name, keys: [await this.keyDoc(creator, id, 1, creator)] })).space as Obj;
  }

  /** key documents for every epoch 1..`upto` (what an invitation carries) */
  async keysFor(creator: FakeMember, id: string, who: FakeMember, upto = 1): Promise<Doc[]> {
    return Promise.all(Array.from({ length: upto }, (_, i) => this.keyDoc(creator, id, i + 1, who)));
  }

  /** invite and accept (`upto`: the space's current epoch) */
  async join(creator: FakeMember, id: string, who: FakeMember, upto = 1): Promise<void> {
    await this.ok(creator, "members.invite", { space: id, member: who.address, keys: await this.keysFor(creator, id, who, upto) });
    await this.ok(who, "space.accept", { space: id });
  }

  /** upload a blob through the real URLs */
  async upload(m: FakeMember, space: string, id: string, bytes: Uint8Array): Promise<Response> {
    const { url } = await this.ok(m, "blob.upload", { space, id, size: bytes.length });
    return this.put(url as string, bytes);
  }

  async put(url: string, bytes: Uint8Array, headers: Record<string, string> = { "content-length": String(bytes.length) }): Promise<Response> {
    return worker.fetch(new Request(url, { method: "PUT", body: bytes, headers }), this.env, asCtx(this.ctx));
  }

  async get(url: string): Promise<Response> {
    return worker.fetch(new Request(url), this.env, asCtx(this.ctx));
  }

  /** push a version on top of the space's head */
  async push(m: FakeMember, space: string, blobs: string[] = [], opts: { epoch?: number } = {}): Promise<Obj> {
    const head = await this.ok(m, "head", { space });
    const sp = (await this.ok(m, "space.get", { space })).space as Obj;
    const doc = await this.versionDoc(m, space, (head.seq as number) + 1, head.version as string | null, opts.epoch ?? (sp.epoch as number), blobs);
    return this.ok(m, "version.push", { space, version: doc });
  }
}

export { versionId };
