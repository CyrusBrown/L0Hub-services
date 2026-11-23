# @l0wservices/spaces

The shared spaces hub service (`kind: "spaces"`, `protocol/spaces.md` in the l0wagent repo): synced folders, end to end
encrypted, every version signed by its author's instance, locks for files that can't merge. One Cloudflare Worker built on
`@l0wservices/core`, with D1, an R2 bucket and one Durable Object per space.

**The service can't read or forge a space.** It never sees a space key or a plaintext: key documents arrive sealed to their
member and signed by the creator, versions are signed by their author, blobs and lock details are ciphertext. It only
*verifies* signatures (against the creator's or author's current directory entry) and stores what passes. It can withhold or delay.

## How it is put together

| | |
|---|---|
| `src/index.ts` | the Worker: `createService` (inbox, calls, events) plus the blob transfer routes; exports the Durable Object class `Space` |
| `src/methods.ts` | every method of spaces.md; verifies documents, reads from D1, sends changes to the Durable Object, then sends its events |
| `src/core.ts` | `SpaceCore`, a plain class: every change that must be atomic (push, members and epochs, locks, uploads, GC) over D1 and R2 |
| `src/durable.ts` | `Space`: runs one `SpaceCore` command at a time per space (an explicit queue: D1 awaits don't hold a Durable Object's input gate) |
| `src/transfer.ts`, `src/tickets.ts` | `PUT`/`GET /v0/blob/<ticket>`: HMAC tickets over space, id, size, direction, expiry and member; single use recorded in D1 |
| `src/cron.ts` | via core's `onCron`: expire locks, drop deleted spaces, GC (hourly), forget used tickets, `rekey` detection |
| `migrations/0100_spaces.sql` | the tables; `pnpm gen` writes `src/migrations.ts` from it (a test fails if they differ) |

Data: D1 holds spaces, members, space-key documents (per space, epoch and member), versions, the blob list and locks; R2 holds the
stored form of each blob at `<space>/<blob id>`.

## Behaviour worth knowing

- **Space ids** are chosen by the creator and named in its first key document; the service accepts an id of 1 to 64 characters
  of `[A-Za-z0-9_-]` that is not taken (`exists`).
- **Invitations** carry a key document for every epoch 1..current, one each, all creator-signed and for the invitee (the head's
  files may use older epochs' blobs); `keys.get` returns them all after `space.accept`.
- **Errors** (`error.code`, extra fields beside `detail`): `conflict` `{head: {seq, version}}` (the head moved, or the epoch is
  not current), `locked` `{lock}`, `missing_blobs` `{missing}`, `missing_keys` `{members}` (remove) or `{epochs}` (invite), `quota_exceeded`, `too_large`,
  `limit_reached`, `exists`, `bad_epoch`, `bad_signature`, `bad_document`, `bad_args`, `not_found` (no such space, or you are
  not in it), `not_member` (invited, not yet accepted), `not_allowed` (creator-only, holder-only), `unknown_member`.
- **Version ids** are `v.` + base64url of the first 16 bytes of SHA-256 of the document's `payload` string. A retried push of
  the version that is already stored answers success.
- **Quota**: `size` is the bytes of stored blobs some version uses; an upload is refused once everything stored (used or not) plus
  it would pass the quota, and a push re-checks. **Max file** applies to the contents: the stored form (`0x01` + ciphertext + tag)
  may be 17 bytes longer.
- **Removing** a member needs a new-epoch key document for every other member and invitee, bumps the epoch, drops the member's
  keys and clears all locks. Withdrawing an invitation starts no epoch (an invitee gets keys only after accepting; a pending invitee is also given a new-epoch key by the removal).
- **GC** (hourly): an upload no version used goes after 7 days; a blob no version of the last 90 days uses goes after 90 days;
  the head's blobs stay. A deleted space is hidden at once and dropped (blobs and rows) after 7 days.

## Deploy

```
cd services/spaces
cp wrangler.example.toml wrangler.toml      # then edit: hostnames, HUB_DOMAIN, HUB_BASE, the hub's Worker name
wrangler d1 create l0w-spaces               # put the database_id in wrangler.toml
wrangler r2 bucket create l0w-spaces-blobs
node -e "console.log(crypto.randomBytes(32).toString('base64url'))" | wrangler secret put SERVICE_SEED
node -e "console.log(crypto.randomBytes(32).toString('base64url'))" | wrangler secret put TICKET_KEY
wrangler deploy                             # creates the Durable Object class `Space` (migration v1)
```

The tables are made on the first request or cron run (or merge them for `migrations_dir`: `pnpm migrations`). Keep the seed:
the service's keys derive from it, so a redeploy with the same seed is the same service.

Then register it with the hub (from the repo root, with the same `SERVICE_SEED` and the hub's admin token):

```
SERVICE_SEED=... ADMIN_TOKEN=... pnpm register --hub https://hub.example --name spaces --kind spaces --title "Shared spaces" \
  --description "Synced folders, end to end encrypted" --ext-git https://git.example/l0wservices.git --ext-commit <40 hex> --ext-path extensions/spaces
```

The hub lists the service in its capabilities, assigns its hostnames (put the instance hostname in the route, and in
`SERVICE_HOST` if it isn't `spaces.<HUB_DOMAIN>`), and members' instances connect with `service-hello`. Transfer URLs are on that
hostname, so the route must cover `/v0/blob/*` as well as `/api/peer/v0/inbox`. Add a Cloudflare rate-limiting rule to the route.

## Tests

`pnpm test`: the real `Space` class behind an in-memory namespace (one object per id), over core's fake hub and members, in-memory
R2 and D1 (`node:sqlite`). Real signed space-key (HPKE-sealed) and space-version documents are built with `@l0w/proto`.
