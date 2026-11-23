# @l0wservices/core

The framework a hub service is built on (protocol/services.md and messages.md in the l0wagent repo). One service is
one Cloudflare Worker that calls `createService(...)` and exports what it returns:

```ts
// services/board/src/index.ts
import { createService, ServiceError, type ServiceEnv } from "@l0wservices/core";

export default createService<ServiceEnv>({
  name: "board",                 // the address is board@<HUB_DOMAIN>
  kind: "board",                 // a well-known kind, or "custom"
  roles: ["moderator"],          // what this service may grant (default: every role ROLES names)
  migrations: [{ name: "0100_topics", sql: "CREATE TABLE IF NOT EXISTS topics (...);\n" }],
  methods: {
    "topic.list": { handler: async (ctx, args) => ({ topics: [] }) },
    "topic.remove": {
      role: "moderator",         // the call must carry a grant for it that we still honor, else not_allowed
      handler: async (ctx, args) => {
        if (typeof args.id !== "string") throw new ServiceError("bad_args", "id is a string");
        await ctx.emit("ola@hub.example", "topic-removed", { id: args.id });
        return {};
      },
    },
  },
  onHello: async (ctx, { release }) => {},   // optional; errors are logged and ignored
  onBye: async (ctx) => {},
  onCron: async (ctx) => {},                  // optional; every cron run before the outbox flush (ctx.from is the service itself; ctx.emit works)
});
```

`createService` returns `{ fetch, scheduled }`: the Worker's `fetch` and its cron `scheduled` handler (the outbox and
role changes need the cron: `crons = ["* * * * *"]`, every minute or every five).

## Handlers

`handler(ctx, args) => object`. `args` is a JSON object (the body is at most 1 MiB). `ctx`:

| | |
|---|---|
| `from` | the caller's address, lowercase: a token this service issued, and a signature by that member's key, were checked |
| `roles` | role names this call carries that were verified (our signature, holder, holder key following rotations, `exp`) **and** are still listed in `ROLES` |
| `env`, `db` | the Worker's env and D1 |
| `emit(to, event, data)` | queue a `service-event` for a connected member; resolves `false` if `to` is not connected |
| `now` | whole seconds since the epoch |

`throw new ServiceError(code, detail, extra?)` answers `{ok: false, error: {code, detail, ...extra}}`. An unknown method is
`unknown_method`, a missing or invalid role `not_allowed`, an exception that is not a `ServiceError` is `internal` (logged; the
message never leaves the Worker), a hub that can't be reached `unavailable`, a result over 1 MiB `too_large`. Everything a
caller sends is untrusted content, and a service never authorizes anything for an assistant.

## Configuration (Worker env)

| | |
|---|---|
| `SERVICE_SEED` | **secret**: base64url of 32 random bytes. The sign, seal and recover keys are `HKDF-SHA256(seed, salt = "", info = "l0wservices/1 <use>")` (the Ed25519 / X25519 / Ed25519 seeds), so a redeploy keeps them. Make one with `node -e "console.log(crypto.randomBytes(32).toString('base64url'))"` |
| `HUB_DOMAIN` | the hub's domain, the part of addresses after `@` |
| `HUB_BASE` | `https://hub.example`; for development `http://127.0.0.1:8770` |
| `HUB` | optional service binding to the hub's Worker. When present, **every** request to the hub and to a member goes through it (the hub's `fetch` routes by Host) |
| `ROLES` | optional JSON `{"moderator": ["mara@hub.example", "ola"]}` (a bare name is a member of this hub) |
| `DB` | D1 |

Without a binding, envelopes go to `https://<member's instance hostname>/api/peer/v0/inbox`; if `HUB_BASE` is `http://`, they go
to `HUB_BASE` with the member's `Host` (the way the fake hub routes).

## What it does

- **Inbox** `POST /api/peer/v0/inbox`, the checks of messages.md in its order: size (16 MiB; `Content-Length` refuses early)
  -> parse and `to` (`404 not_here`) -> token (`403 no_token`: required except on `service-hello`; one this service issued,
  not revoked, to `from` / `from_kid` or a key that rotated into it; a missing token is also `no_token`) -> `service-hello` only
  from members of this hub (`403 not_member`) -> signature against the sender's directory key (`401 bad_signature`, no detail)
  -> `iat` window, kind (`422 unknown_kind` for anything but hello, bye and call), duplicate id (`200 {"duplicate": true}`) ->
  open the seal (`400 bad_seal`) and validate the body (`400 bad_body`) -> handle -> `202`. A hub that can't be asked is
  `503 unavailable`, so the sender's outbox retries. `GET /` is a tiny JSON status; everything else is 404.
- **service-hello**: their token (issuer = the sender, holder = this service, our key) is stored, ours is issued, and a
  `service-welcome` `{token, roles: [grants]}` is queued. A second hello revokes the token the first got.
  **service-bye** forgets the member, revokes our token and drops what was queued for it.
  **service-call** answers with a `service-reply` through the outbox.
- **Outbox**: every envelope we send (welcome, reply, event) is built once, sealed to the member's current seal key (their
  directory entry, cached 5 minutes), signed, given the member's token and the next `seq` for that member, stored in D1,
  and tried at once (in `waitUntil`), then by the cron handler: backoff 30 s doubling to 1 h, for 7 days; a 4xx other than
  408/429 drops it. Retries resend the same bytes.
- **Directory and hub key**: entries are verified (the member's signature and the hub's countersignature), cached in D1, never
  accepted at a lower `seq` than seen, and refetched once for an unknown key id. The hub's signing key is read from its
  capabilities the first time and **pinned** in D1; a change is followed only along rotation documents signed by the pinned
  key, anything else makes the service answer 503 (the owner of the service looks at it).
- **Roles**: grants come from `ROLES` and are signed by the service key (no `exp`; revoking = removing from `ROLES`, which
  stops them being honored at once). On cron, a member whose set changed gets `{"event": "roles", "data": {"grants": [...]}}`
  with the full current set. A member the hub no longer lists is forgotten.
- **Upkeep (cron)**: seen ids are kept 9 days, the call log (method and outcome per call, never arguments) 30 days.

## D1

The framework's tables are in `migrations/0001_core.sql` (members, tokens issued and held, seen ids, outbox, seq counters,
call log, directory cache, state). Two ways to apply them, use either (both are idempotent):

1. **Self-migrating** (default): `createService({migrations: [...]})` applies the framework's migrations and then the
   service's own, once each, recorded in `l0w_migrations`, on the first request or cron run of an isolate. Statements end
   with a `;` at the end of a line; no `;` inside strings (D1 runs a migration as a batch of prepared statements).
2. **Files**: `node ../../packages/core/scripts/merge-migrations.mjs migrations dist/migrations` copies the framework's
   files and the service's (name them `0100_...` and up) into one folder for wrangler's `migrations_dir`.

`src/core-migrations.ts` is generated from the SQL files (`pnpm gen`); a test fails if they differ.

## Registering with a hub

`scripts/register.ts` at the repo root builds the signed self document (the service's three public keys and the hostnames the
hub assigns, worked out from the capabilities' `hostnames.example`) and PUTs it to `<hub>/v0/admin/services/<name>`:

```
SERVICE_SEED=... ADMIN_TOKEN=... pnpm register --hub https://hub.example --name board --kind board --title Board \
  --roles moderator,poster --ext-git https://git.example/l0wservices.git --ext-commit <40 hex> --ext-path extensions/board
```

`--dry-run` prints the body; `--config service.json` supplies the options; `--seq N` sets the self document's seq (default:
one more than the directory's current entry, else 0). It is also `registerWithHub` / `buildRegistration` from this package.

## Tests

`pnpm test` (vitest, node). `test/helpers.ts` has a fake hub served by a fetch stub (capabilities and countersigned directory
entries), a fake member made with `@l0w/proto`, and a test service (`echo`, `whoami`, `secret` needing `tester`); D1 is a shim
over `node:sqlite` (`test/d1.ts`). `test/interop.test.ts` has the Python reference library open a welcome (skipped without `uv`).

## Not here

- **Rate limiting** (messages.md step 1: per sender and overall, `429`). Put Cloudflare rate-limiting rules on the service's
  route; the dedupe and token checks stop replays and strangers.
- The service does not serve `/.well-known/l0wagent/self`: the hub serves its directory entry.
- Service key rotation (keys follow the seed) and following a member's recovery-key rotations beyond the signed
  `history` of its self-description (the walk reads the hub-countersigned payload; it does not re-verify each rotation).
