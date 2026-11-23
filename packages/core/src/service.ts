// createService: one service is one Worker; `export default createService({...})`.
import { docs, errors, messages, payloads as P } from "@l0w/proto";
import { rolesOf } from "./config";
import { ConfigError, HubUnavailable, ServiceError } from "./errors";
import { receive, refuseFrom, Refuse, type Received } from "./inbox";
import { rotatedFrom } from "./hub";
import { buildRuntime, type Runtime } from "./runtime";
import type { Obj, ServiceEnv, ServiceOptions, ServiceWorker } from "./types";

const INBOX = "/api/peer/v0/inbox";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const errorResponse = (r: Refuse): Response => json({ v: "l0w/0.1", error: r.code, detail: r.detail }, r.status, r.headers);

async function grants(rt: Runtime<ServiceEnv>, holder: string, holderKid: string, roles: string[]): Promise<docs.Doc[]> {
  const out: docs.Doc[] = [];
  for (const role of roles) out.push(await docs.signDocument("role-grant", P.buildRoleGrant(rt.cfg.address, holder, holderKid, role), [rt.keys.sign]));
  return out;
}

// --- service-hello / service-bye ---------------------------------------------------------------

async function hello<E extends ServiceEnv>(rt: Runtime<E>, r: Received): Promise<void> {
  const { payload: p, body, from, entry } = r;
  const bad = new Refuse(400, "bad_body", "the token is not theirs for this service");
  // their token for us: issuer = the sender (signed by the sender's key), holder = this service (this service's key)
  let theirs: Obj;
  try {
    theirs = await messages.verifyDeliveryToken(body.token, entry.signKey, rt.keys.sign.kid, rt.now());
  } catch {
    throw bad;
  }
  if (theirs.issuer.toLowerCase() !== from || theirs.holder.toLowerCase() !== rt.cfg.address) throw bad;

  const roles = rolesOf(rt.cfg, from);
  const mine = await messages.issueDeliveryToken(rt.keys.sign, rt.cfg.address, from, p.from_kid);
  await rt.store.connect(from, body.token, theirs.id, { id: P.validateTokenDocument(mine).id, holderKid: p.from_kid }, String(body.release), roles, rt.now());
  const id = await rt.outbox.enqueue("service-welcome", from, { token: mine, roles: await grants(rt, from, p.from_kid, roles) });
  if (id) rt.later(rt.outbox.deliverNow(id));
  await hook(rt, () => rt.opts.onHello?.(rt.context(from, []), { release: String(body.release) }));
}

async function bye<E extends ServiceEnv>(rt: Runtime<E>, r: Received): Promise<void> {
  if (await rt.store.disconnect(r.from, rt.now())) await hook(rt, () => rt.opts.onBye?.(rt.context(r.from, [])));
}

async function hook<E extends ServiceEnv>(_rt: Runtime<E>, fn: () => Promise<void> | void | undefined): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error("member hook failed:", e);
  }
}

// --- service-call ------------------------------------------------------------------------------

/** The role of the grant a call carries, when it is this service's, for this sender (or a key it rotated from), in date, and
 * still configured in ROLES. Anything else carries no role. */
async function honoredRoles<E extends ServiceEnv>(rt: Runtime<E>, r: Received): Promise<string[]> {
  const g = r.body.role;
  if (g === undefined || g === null) return [];
  try {
    const grant = await P.verifyRoleGrant(g, rt.keys.sign.key, { service: rt.cfg.address, holder: r.from, now: rt.now() });
    if (grant.holder_kid !== r.payload.from_kid && !rotatedFrom(r.entry.history, grant.holder_kid, r.payload.from_kid)) return [];
    return rt.cfg.roles.get(grant.role)?.has(r.from) ? [grant.role] : [];
  } catch {
    return [];
  }
}

async function runCall<E extends ServiceEnv>(rt: Runtime<E>, r: Received): Promise<{ ok: true; result: Obj } | { ok: false; error: Obj }> {
  const method: string = r.body.method;
  const def = Object.hasOwn(rt.opts.methods, method) ? rt.opts.methods[method] : undefined;
  if (!def) return { ok: false, error: new ServiceError("unknown_method", `no method ${JSON.stringify(method)}`).toJSON() };
  const roles = await honoredRoles(rt, r);
  if (def.role && !roles.includes(def.role)) {
    return { ok: false, error: new ServiceError("not_allowed", `this method needs the ${def.role} role`).toJSON() };
  }
  try {
    const result = await def.handler(rt.context(r.from, roles), r.body.args);
    if (!docs.isObject(result)) throw new Error(`method ${method} did not return an object`);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof ServiceError) return { ok: false, error: e.toJSON() };
    if (e instanceof HubUnavailable) return { ok: false, error: new ServiceError("unavailable", "the hub could not be reached").toJSON() };
    console.error(`method ${method} failed:`, e);
    return { ok: false, error: new ServiceError("internal", "the service failed").toJSON() };
  }
}

async function call<E extends ServiceEnv>(rt: Runtime<E>, r: Received): Promise<void> {
  const t0 = Date.now();
  const out = await runCall(rt, r);
  const reply = (o: typeof out): Obj => (o.ok ? { call: r.body.call, ok: true, result: o.result } : { call: r.body.call, ok: false, error: o.error });
  let id: string | null;
  try {
    id = await rt.outbox.enqueue("service-reply", r.from, reply(out));
  } catch (e) {
    if (!(e instanceof errors.ValidationError) || e.code !== "too_large") throw e;
    id = await rt.outbox.enqueue("service-reply", r.from, reply({ ok: false, error: new ServiceError("too_large", "the result is over 1 MiB").toJSON() }));
  }
  if (id) rt.later(rt.outbox.deliverNow(id));
  await rt.store.logCall(rt.now(), r.from, r.body.method, out.ok, out.ok ? null : String(out.error.code), Date.now() - t0);
}

// --- the cron handler --------------------------------------------------------------------------

async function syncRoles<E extends ServiceEnv>(rt: Runtime<E>): Promise<void> {
  for (const m of await rt.store.listMembers()) {
    const want = rolesOf(rt.cfg, m.address);
    if (JSON.stringify(want) === JSON.stringify([...m.roles].sort())) continue;
    try {
      const entry = await rt.hub.entry(m.address);
      if (!entry) {
        // gone from the hub: forget it
        if (await rt.store.disconnect(m.address, rt.now())) await hook(rt, () => rt.opts.onBye?.(rt.context(m.address, [])));
        continue;
      }
      const id = await rt.outbox.enqueue("service-event", m.address, { event: "roles", data: { grants: await grants(rt, m.address, entry.signKey.kid, want) } });
      if (id) await rt.store.setMemberRoles(m.address, want, rt.now());
    } catch (e) {
      console.error(`roles for ${m.address}:`, e); // the hub could not be asked: the next run tries again
    }
  }
}

// --- the Worker --------------------------------------------------------------------------------

export function createService<E extends ServiceEnv = ServiceEnv>(opts: ServiceOptions<E>): ServiceWorker<E> {
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      const get = request.method === "GET" || request.method === "HEAD";
      if (url.pathname === "/" && get) {
        try {
          const rt = await buildRuntime(env, ctx, opts);
          return json({ service: opts.name, address: rt.cfg.address, kind: opts.kind, v: "l0w/0.1", ok: true });
        } catch (e) {
          return configProblem(e);
        }
      }
      if (url.pathname !== INBOX || request.method !== "POST") return json({ v: "l0w/0.1", error: "not_found", detail: "" }, 404);
      let rt: Runtime<E>;
      try {
        rt = await buildRuntime(env, ctx, opts);
      } catch (e) {
        return configProblem(e);
      }
      let got: Received | null = null;
      try {
        got = await receive(rt, request);
        if (got === null) return json({ duplicate: true });
        if (got.payload.kind === "service-hello") await hello(rt, got);
        else if (got.payload.kind === "service-bye") await bye(rt, got);
        else await call(rt, got);
        return json({ v: "l0w/0.1", id: got.payload.id }, 202);
      } catch (e) {
        if (got) await rt.store.forgetSeen(got.from, got.payload.id).catch(() => undefined); // so the sender's retry is handled, not dropped as a duplicate
        try {
          return errorResponse(refuseFrom(e));
        } catch {
          console.error("inbox failed:", e);
          return json({ v: "l0w/0.1", error: "internal_error", detail: "" }, 500);
        }
      }
    },

    async scheduled(_controller, env, ctx) {
      const rt = await buildRuntime(env, ctx, opts);
      await syncRoles(rt);
      await hook(rt, () => rt.opts.onCron?.(rt.context(rt.cfg.address, [])));
      await rt.outbox.flush();
      await rt.store.purge(rt.now());
    },
  };
}

function configProblem(e: unknown): Response {
  if (e instanceof ConfigError) return json({ v: "l0w/0.1", error: "misconfigured", detail: e.message }, 500);
  console.error("startup failed:", e);
  return json({ v: "l0w/0.1", error: "internal_error", detail: "" }, 500);
}
