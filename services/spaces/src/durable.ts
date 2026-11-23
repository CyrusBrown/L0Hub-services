// The Durable Object: one per space, named by the space id. It runs one command at a time (an explicit queue, because a
// Durable Object's input gate does not cover awaits on D1 or R2), so the head, the epoch, the members and the locks
// change one command after another. The data itself is in D1; the object holds nothing between commands.
import { ensureMigrated, ServiceError } from "@l0wservices/core";
import { SpaceCore, type Outcome } from "./core";
import { limits, type SpacesEnv } from "./env";
import { SPACES_MIGRATIONS } from "./migrations";

export class Space implements DurableObject {
  private core: SpaceCore;
  private db: D1Database;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    _state: DurableObjectState,
    env: Pick<SpacesEnv, "DB" | "BLOBS"> & Partial<SpacesEnv>,
  ) {
    this.db = env.DB;
    this.core = new SpaceCore(env, limits(env));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  async fetch(request: Request): Promise<Response> {
    const { cmd, args } = (await request.json()) as { cmd: string; args: Record<string, unknown> };
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    try {
      await ensureMigrated(this.db, SPACES_MIGRATIONS);
      const out = await this.serial(() => this.core.run(cmd, args));
      return reply({ ok: true, ...out });
    } catch (e) {
      if (e instanceof ServiceError) return reply({ ok: false, error: e.toJSON() });
      console.error(`space command ${cmd} failed:`, e);
      return reply({ ok: false, error: { code: "internal", detail: "the service failed" } });
    }
  }
}

/** Run a command in the space's Durable Object. A refusal comes back as the ServiceError the command threw. */
export async function inSpace(env: Pick<SpacesEnv, "SPACE">, space: string, cmd: string, args: Record<string, unknown>): Promise<Outcome> {
  const stub = env.SPACE.get(env.SPACE.idFromName(space));
  const res = await stub.fetch("https://space.internal/cmd", { method: "POST", body: JSON.stringify({ cmd, args }) });
  const body = (await res.json()) as { ok: boolean; result?: Outcome["result"]; events?: Outcome["events"]; error?: Record<string, unknown> };
  if (!body.ok) {
    const { code, detail, ...extra } = body.error ?? {};
    throw new ServiceError(String(code ?? "internal"), String(detail ?? ""), extra);
  }
  return { result: body.result ?? {}, events: body.events ?? [] };
}
