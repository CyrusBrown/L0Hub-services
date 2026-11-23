// What one request (or one cron run) works with.
import { loadConfig, type Config } from "./config";
import { Hub } from "./hub";
import { serviceKeys, type ServiceKeys } from "./keys";
import { ensureMigrated } from "./migrate";
import { Outbox } from "./outbox";
import { Store } from "./store";
import type { CallContext, Obj, ServiceEnv, ServiceOptions } from "./types";

export interface Runtime<E extends ServiceEnv> {
  env: E;
  cfg: Config;
  keys: ServiceKeys;
  store: Store;
  hub: Hub;
  outbox: Outbox;
  opts: ServiceOptions<E>;
  ctx: ExecutionContext;
  now(): number;
  /** Queue an event for a connected member and start delivering it. */
  emit(to: string, event: string, data: Obj): Promise<boolean>;
  /** Run `p` after the response (errors are logged, never thrown). */
  later(p: Promise<unknown>): void;
  context(from: string, roles: string[]): CallContext<E>;
}

export const epoch = (): number => Math.floor(Date.now() / 1000);

export async function buildRuntime<E extends ServiceEnv>(env: E, ctx: ExecutionContext, opts: ServiceOptions<E>): Promise<Runtime<E>> {
  const cfg = loadConfig(env, opts as ServiceOptions<never>);
  const keys = await serviceKeys(env.SERVICE_SEED);
  await ensureMigrated(env.DB, opts.migrations);
  const store = new Store(env.DB);
  const hub = new Hub(env, cfg, store, epoch);
  const outbox = new Outbox(env, cfg, store, hub, keys, epoch);
  const later = (p: Promise<unknown>) => ctx.waitUntil(p.catch((e) => console.error("background task failed:", e)));
  const rt: Runtime<E> = {
    env,
    cfg,
    keys,
    store,
    hub,
    outbox,
    opts,
    ctx,
    now: epoch,
    later,
    async emit(to, event, data) {
      const id = await outbox.enqueue("service-event", to, { event, data });
      if (id === null) return false;
      later(outbox.deliverNow(id));
      return true;
    },
    context(from, roles) {
      return { from, roles, env, db: env.DB, emit: (to, event, data) => rt.emit(to, event, data), now: epoch(), directory: (a, o) => hub.entry(a, o) };
    },
  };
  return rt;
}
