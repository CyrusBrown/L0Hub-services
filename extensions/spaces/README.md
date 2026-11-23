# spaces (extension)

The instance side of a hub's `spaces` service ([protocol/spaces.md](../../../../../l0wagent/protocol/spaces.md), design in l0wagent's
`docs/plans/hub.md`). Control syncs, never the agent: each space appears at `/external/spaces/spaces/<name>/` (an `agent_writable`
managed folder), and this extension pulls other members' versions in, pushes the agent's changes out and keeps both sides of a conflict.

- **Sync** (a job every minute, and on the service's `head`/`epoch` events; one space at a time): pull (every version verified against its
  author's directory key, chained, manifest blobs listed; blobs decrypted and checked against their ids), merge (different files merge; a
  file changed on both sides keeps the other member's version at the path and the local one as `name (conflict <me> <date>).ext`, listed in
  the version's `conflicts`; an edit to a file someone else locked is saved as `name (edit while locked <date>).ext` and the original
  restored), push (blobs uploaded, manifest sealed, signed through the gateway; a `conflict` pulls and retries up to 3 times).
- **Skipped and reported once**: symlinks, special files, files over the space's `max_file`, `.l0wignore` matches, invalid paths, files
  holding a vault value. `.l0wmessage` in the space root is the next version's message (then deleted).
- **Agent commands** (`assistant ext spaces ...`): `ls`, `status`, `sync`, `history`, `lock`, `unlock`, `locks`, `request-create`,
  `request-invite`. Creating, inviting, removing and accepting are the owner's (Inbox cards and the page); the agent only asks.
- **Owner page** (More -> Shared spaces): spaces, invitations, members (invite, remove), history (restore = the old files written as a new
  version), locks (the creator can break), conflicts, what was skipped.
- **Untrusted**: file contents, names, messages and lock reasons from other members are framed (`fmt.py`) and the prompt says so, code included.
- **Keys** (`K` per epoch) are in the extension's store under `keys:<space id>` and nowhere else; no command, page, note or prompt shows one.

## Test
```
cd extensions/spaces && uv sync && uv run pytest -q && uv run ruff check .
```
Needs l0wagent at `~/Dev/l0wagent` (`../../../../../l0wagent` from here): the tests load the extension into its control through `control/tests/hubworld.py`, with a fake spaces
service (spaces.md in memory) and remote members (bob, carol) who sign versions with fixed keys.
