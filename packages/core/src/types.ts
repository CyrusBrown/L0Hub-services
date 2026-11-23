import type { docs } from "@l0w/proto";
import type { Entry } from "./hub";

export type Obj = docs.Obj;
export type Doc = docs.Doc;

/** What a service's Worker needs. A service's own env type extends this (`createService<MyEnv>`). */
export interface ServiceEnv {
  /** Secret: base64url of 32 random bytes. The sign, seal and recover keys are derived from it. */
  SERVICE_SEED: string;
  /** The hub's domain, the part of addresses after the `@` (`hub.example`). */
  HUB_DOMAIN: string;
  /** The hub's base URL: `https://hub.example` in production, `http://127.0.0.1:8787` in development. */
  HUB_BASE: string;
  /** A service binding to the hub's Worker. When present, every request to the hub or to a member goes through it. */
  HUB?: Fetcher;
  /** JSON `{"moderator": ["mara@hub.example", "ola"]}`: who gets which role (a bare name means a member of this hub). */
  ROLES?: string;
  DB: D1Database;
}

/** Who is calling, what they carry, and what a handler may do. */
export interface CallContext<E extends ServiceEnv = ServiceEnv> {
  /** The caller's address, lowercase. Verified: a token this service issued and a signature by that member's key. */
  from: string;
  /** The role names this call carries that this service verified and still honors (empty when none). */
  roles: string[];
  env: E;
  db: D1Database;
  /** Send a `service-event` to a member that is connected to this service. Resolves to false (nothing is queued)
   * when `to` isn't connected. The event is queued in the outbox and delivered with retries. */
  emit(to: string, event: string, data: Obj): Promise<boolean>;
  /** Whole seconds since the epoch. */
  now: number;
  /** The verified directory entry of a member of this hub (its current signing and seal keys); null when `address` is not a
   * current member. Cached for five minutes (`refresh` asks again). Throws `HubUnavailable` when the hub can't say. */
  directory(address: string, opts?: { refresh?: boolean }): Promise<Entry | null>;
}

/** What `onHello` and `onBye` get: a call context without a role (these aren't calls). */
export type MemberContext<E extends ServiceEnv = ServiceEnv> = CallContext<E>;

export interface MethodDef<E extends ServiceEnv = ServiceEnv> {
  /** The role a call must carry (and the service must still honor), else the reply is `not_allowed`. */
  role?: string;
  handler(ctx: CallContext<E>, args: Obj): Promise<Obj> | Obj;
}

/** One SQL migration of the service's own, applied (once, in the order given) after the framework's. Statements are
 * separated by a semicolon at the end of a line; there must be no `;` inside a string. */
export interface Migration {
  name: string;
  sql: string;
}

export interface ServiceOptions<E extends ServiceEnv = ServiceEnv> {
  /** The service's name: its address is `<name>@<HUB_DOMAIN>`. */
  name: string;
  /** One of the well-known kinds (`board`, `spaces`, ...) or `custom`. */
  kind: string;
  /** The service's own migrations, applied after the framework's (see `README.md`). */
  migrations?: Migration[];
  methods: Record<string, MethodDef<E>>;
  /** The roles this service may grant. Default: every role `ROLES` names. */
  roles?: string[];
  /** A member connected (its `service-hello` was accepted and the welcome is queued). Errors are logged and ignored. */
  onHello?(ctx: MemberContext<E>, info: { release: string }): Promise<void> | void;
  /** A member left (`service-bye`, or it is gone from the hub). Errors are logged and ignored. */
  onBye?(ctx: MemberContext<E>): Promise<void> | void;
  /** Every cron run, before the outbox is flushed (so events queued here go out in the same run). `ctx.from` is the
   * service's own address and `ctx.roles` is empty. Errors are logged and ignored. */
  onCron?(ctx: CallContext<E>): Promise<void> | void;
}

/** The Worker exports of a service: `export default createService(...)`. */
export interface ServiceWorker<E extends ServiceEnv = ServiceEnv> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: E, ctx: ExecutionContext): Promise<void>;
}
