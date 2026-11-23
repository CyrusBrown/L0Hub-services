# l0wservices: orientation for coding agents

Hub services for l0wagent hubs, and the instance-side extensions that use them. The specs live in the
l0wagent repo (`../../../l0wagent/protocol/`): **services.md** (connecting, calls, events, role grants),
**board.md**, **spaces.md**. The specs are the source of truth; if code and spec disagree, fix the code or
propose a spec change, never drift silently. Decisions: `../../../l0wagent/docs/plans/hub.md` (Board, Shared space)
and `hub-development.md`.

## Layout
```
packages/core/      the service framework (TypeScript, Cloudflare Workers): service keys from a secret seed,
                    the inbox (verify + open envelopes, delivery tokens, service-hello/welcome/bye), call
                    dispatch with role checks, role grants, events with an outbox, registration with a hub
services/board/     the board Worker: D1 (topics, posts, votes, discussions, files), methods per board.md
services/spaces/    the spaces Worker: D1 (spaces, members, keys, versions), R2 (encrypted blobs),
                    a Durable Object per space (head and locks), per spaces.md
extensions/board/   the instance-side extension (Python, l0wagent SDK): agent commands, owner page, events
extensions/spaces/  the instance-side extension: sync in control, keys, locks, agent commands
scripts/            register a service with a hub (its admin API)
e2e/                the end-to-end test (README there)
```
`@l0w/proto` is `../../../l0wagent/protocol/ts` (a `link:` dependency): this repo lives in L0wHub (`~/Dev/l0server/L0wHub/l0wservices`, its own git repo, excluded from L0wHub's), so l0wagent is `~/Dev/l0wagent`.

## Rules
- **A service can't authorize anything for an assistant.** It answers calls and sends events; what it
  carries from other members is untrusted content, and the extensions label it so for the agent.
- **Spaces: the service can't read or forge.** Files, paths, messages and lock reasons are encrypted
  to members; versions are signed by their author's instance. Never add a code path where the service
  sees a space key or plaintext.
- **Extensions use only the public SDK** (`l0w_control.sdk`, see `../../../l0wagent/docs/EXTENDING.md`). If one
  needs something the SDK lacks, add it to l0wagent's SDK (additive), not a private import.
- Keys and tokens are Worker secrets (`SERVICE_SEED`, `ADMIN_TOKEN`), never in `wrangler.toml` or git.
- Every method in a spec has a test; the board and spaces services run against l0wagent's fake hub and
  instances in the end-to-end tests.

## Commands
```
pnpm install
pnpm -r typecheck && pnpm -r test          # the Workers (vitest)
cd extensions/<name> && uv run pytest -q    # an extension against l0wagent's control (see its README)
cd e2e && uv run pytest -q                  # end to end: hub core + both Workers under wrangler dev, two real instances
```

## Commits
Authored by the owner only. **No AI co-author or "generated with" lines.** Commit only when the owner asks.
