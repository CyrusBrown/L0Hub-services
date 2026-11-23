# End to end: the board and shared spaces on a real hub core

`uv run pytest -q` here runs both services the way they run in production, minus Cloudflare's edge:

- l0wagent's **hub core** (`../../../l0wagent/hub`) and this repo's **board** and **spaces** Workers, each under `wrangler dev --local`
  (fresh local D1, R2 and Durable Object state in pytest's temp folder). The services reach the hub, and through it members,
  by their `HUB` service binding, as in production (wrangler's dev registry connects the three processes).
- `proxy.mjs` plays Cloudflare's routing: one port for `hub.localhost:<port>`, with `board.*` and `spaces.*` going to their
  Workers and everything else to the hub (WebSocket upgrades included, for the tunnel).
- Both services are registered with `pnpm register`, the way an operator does it.
- Two **instances** (alice, a board moderator, and bob): l0wagent's `HubStack` (control, gateway, tunnel, egress, runner) with
  `extensions/board` and `extensions/spaces` installed and switched on, joined with real invites.

What it checks: both services connect by themselves with the right role grants; the board's topics, posts, untrusted framing,
votes, discussion, mentions and events; a space created, synced, shared, accepted, edited both ways, with locks; and that no plaintext
of the space's files reaches the spaces service's storage.

Needs: `uv`, `node`, `pnpm install` in `../../../l0wagent/hub` (its wrangler is used) and at this repo's root, and the IPv6 loopback
(control tells the tunnel apart by `[::1]`). About 10 seconds once the venv is built. Logs of a failed run are in the assertion.
