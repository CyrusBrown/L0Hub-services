"""The spaces extension: the instance side of a hub's `spaces` service (protocol/spaces.md).

Control syncs, never the agent: this extension pulls other members' versions into `/external/spaces/spaces/<name>/`, pushes what the agent
changed there, and keeps both sides of a conflict. The owner decides about spaces (creating, inviting, removing, accepting); the agent can
only ask, through Inbox cards. Everything other members wrote is untrusted and framed as such for the agent. The space keys never leave
the extension's store: no command, page or note ever shows one. Uses only the public SDK plus l0wproto."""

import inspect
from typing import Annotated, Any

from fastapi import HTTPException
from l0w_control.sdk import Extension, ExtensionError, HubCallError
from l0wproto.errors import ProtocolError
from l0wproto.payloads import split_address
from pydantic import BaseModel, BeforeValidator, ConfigDict

from . import engine as E
from . import fmt

SyncError = (E.SpaceError, HubCallError, ExtensionError)


def _text(v: Any) -> Any:
    return str(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v


S = Annotated[str, BeforeValidator(_text)]


class Args(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Nothing(Args):
    pass


class SpaceOnly(Args):
    space: S


class History(Args):
    space: S
    limit: int = 15


class LockIn(Args):
    space: S | None = None
    path: S
    reason: S = ""
    ttl_hours: int | None = None


class UnlockIn(Args):
    space: S | None = None
    path: S


class LocksIn(Args):
    space: S | None = None


class ReqCreate(Args):
    name: S
    reason: S = ""


class ReqInvite(Args):
    space: S
    member: S
    reason: S = ""


class SpaceRef(Args):
    space: S


class NameIn(Args):
    name: S


class MemberIn(Args):
    space: S
    member: S


class RestoreIn(Args):
    space: S
    seq: int


class TagIn(Args):
    space: S
    tag: S


def why(e: Exception) -> str:
    if isinstance(e, HubCallError):
        return E.describe(e)
    if isinstance(e, ExtensionError):
        return f"Control refused: {fmt.clean(str(e), 200)}"
    return str(e)


def setup(ext: Extension) -> None:
    eng = E.Engine(ext)

    # ── agent commands ───────────────────────────────────────────────────────────────────────────
    def command(name: str, model: type[BaseModel]):
        def deco(fn):
            def route(body: model):  # type: ignore[valid-type]
                try:
                    return {"text": fn(body)}
                except SyncError as e:
                    return {"text": why(e)}

            ext.agent_router.add_api_route(f"/{name}", route, methods=["POST"])
            return fn

        return deco

    def agent_dir(r: dict) -> str:
        return f"{ext.folders.agent_path(E.FOLDER)}/{fmt.tok(r['dir'], 80)}/"

    def summary(r: dict) -> str:
        head = r.get("head") or {}
        bits = [f"{fmt.tok(r['name'], 60)}: {agent_dir(r)}", f"state {fmt.tok(r['state'], 20)}", f"creator {fmt.tok(r['creator'], 120)}"]
        if r["state"] == "member":
            bits += [f"version {fmt.num(head.get('seq'))}", f"epoch {fmt.num(r['epoch'])}",
                     "synced " + fmt.tok(r.get("last_sync") or "not yet", 32)]
        ms = [m for m in r.get("members") or [] if isinstance(m, dict)]
        if ms:
            bits.append("members " + ", ".join(fmt.tok(m["address"], 120) + (" (invited)" if m["state"] == "invited" else "") for m in ms[:20]))
        out = "- " + "; ".join(bits)
        if r.get("error"):
            out += f"\n  problem: {fmt.tok(r['error'], 300)}"
        if r.get("conflicts"):
            out += "\n  files left in conflict by the last version:\n" + fmt.frame("\n".join(fmt.clean(c, 300) for c in r["conflicts"][:30]), "the space's members", "a shared space")
        return out

    @command("ls", Nothing)
    def ls(b: Nothing) -> str:
        rs = eng.recs()
        if not rs:
            return ("You have no shared spaces. The owner creates them (and accepts invitations) in the Shared spaces page; "
                    "you can ask with `request-create`.")
        return "Shared spaces (control syncs them about every minute; you only edit the files):\n" + "\n".join(summary(r) for r in rs)

    @command("status", SpaceOnly)
    def status(b: SpaceOnly) -> str:
        r = eng.find(b.space)
        out = summary(r)
        sk = r.get("skipped") or {}
        if sk:
            out += "\n  not synced:\n" + fmt.frame("\n".join(f"{fmt.clean(p, 300)} {fmt.tok(w, 80)}" for p, w in sorted(sk.items())[:40]), "files in this space")
        if r.get("pending_conflicts"):
            out += "\n  conflict copies waiting to be pushed for: " + ", ".join(fmt.tok(p, 200) for p in r["pending_conflicts"][:20])
        lk = ext.store.get(f"locks:{r['id']}") or {}
        if lk:
            out += "\n  locks:\n" + "\n".join(lock_line(p, x) for p, x in sorted(lk.items()))
        return out

    @command("sync", SpaceOnly)
    def sync(b: SpaceOnly) -> str:
        r = eng.find(b.space)
        res = eng.sync(r["id"])
        ext.emit("spaces-changed", {})
        bits = [f"Synced {fmt.tok(r['name'], 60)}: {res['pulled']} new version(s) pulled, {res['pushed']} pushed."]
        if res["conflicts"]:
            bits.append("Files changed on both sides, both kept (see the copies named `... (conflict ...)`): " + fmt.frame("\n".join(res["conflicts"]), "the space's members"))
        if res["locked"]:
            bits.append("Edits to locked files were saved as copies: " + fmt.frame("\n".join(f"{p} -> {c}" for p, c in res["locked"]), "the space's members"))
        return " ".join(bits[:1]) + "".join("\n" + x for x in bits[1:])

    @command("history", History)
    def history(b: History) -> str:
        r = eng.find(b.space)
        hs = list(reversed(eng.history(r["id"])))[: max(1, min(b.limit, 50))]
        if not hs:
            return "No versions yet."
        return "\n\n".join(f"version {fmt.num(h['seq'])} by {fmt.tok(h['author'], 120)} at {fmt.tok(h.get('at'), 32)}, {fmt.num(h.get('files'))} files\n"
                           + fmt.frame(h.get("message") or "(no message)", h["author"], f"the space {fmt.tok(r['name'], 40)}") for h in hs)

    def locate(space: str | None, path: str) -> tuple[dict, str]:
        pre = f"{ext.folders.agent_path(E.FOLDER)}/"
        path = path.strip()
        if path.startswith(pre):
            d, _, rest = path[len(pre):].partition("/")
            return eng.find(space or d), rest
        if not space:
            raise E.SpaceError("Say which space: space=NAME (or give the path under /external/spaces/...).")
        return eng.find(space), path.lstrip("/")

    def lock_line(p: str, x: dict) -> str:
        mine = x.get("holder") == (ext.store.get("me") or "")
        return (f"- {fmt.tok(p, 300)}: held by {fmt.tok(x.get('holder'), 120)}{' (you)' if mine else ''} until {fmt.tok(x.get('expires'), 32)}"
                + ("\n" + fmt.frame(x["reason"], x.get("holder"), "a lock's reason") if x.get("reason") and not mine
                   else (f", reason: {fmt.clean(x['reason'], 200)}" if x.get("reason") else "")))

    @command("lock", LockIn)
    def lock(b: LockIn) -> str:
        r, rel = locate(b.space, b.path)
        if r["state"] != "member":
            raise E.SpaceError("You aren't a member of that space.")
        return eng.lock_take(r, rel, b.reason, b.ttl_hours)

    @command("unlock", UnlockIn)
    def unlock(b: UnlockIn) -> str:
        r, rel = locate(b.space, b.path)
        return eng.lock_release(r, rel)

    @command("locks", LocksIn)
    def locks(b: LocksIn) -> str:
        rs = [eng.find(b.space)] if b.space else [r for r in eng.recs() if r["state"] == "member"]
        out = []
        me = ""
        try:
            me = eng.me()["address"]
            ext.store.set("me", me)
        except E.SpaceError:
            pass
        for r in rs:
            keys = eng.keys_of(r["id"])
            try:
                cur = eng.open_locks(r, keys)
            except SyncError:
                cur = ext.store.get(f"locks:{r['id']}") or {}
            out.append(f"{fmt.tok(r['name'], 60)}: " + ("\n" + "\n".join(lock_line(p, x) for p, x in sorted(cur.items())) if cur else "no locks"))
        return "\n".join(out) or "You have no shared spaces."

    def open_card(kind: str, key: str, value: str) -> bool:
        return any(c["kind"] == kind and c["data"].get(key) == value for c in ext.inbox.open())

    @command("request-create", ReqCreate)
    def request_create(b: ReqCreate) -> str:
        name = b.name.strip().lower()
        if not E.SLUG.match(name) or len(name) > 40:
            raise ExtensionError("A space's name is lowercase letters, digits and single dashes, up to 40 characters.")
        if open_card("request-create", "name", name):
            return f"The owner already has a request to create {name}; wait for their answer."
        ext.inbox.card("request-create", f"Your assistant asks to create the shared space {name}", {"name": name, "reason": fmt.clean(b.reason, 400)})
        return f"Asked the owner to create the space {name}. They decide; you'll see it in `ls` if they do."

    @command("request-invite", ReqInvite)
    def request_invite(b: ReqInvite) -> str:
        r = eng.find(b.space)
        member = b.member.strip().lower()
        try:
            split_address(member)
        except ProtocolError as e:
            raise ExtensionError("A member is an address like name@hub.example.") from e
        if open_card("request-invite", "key", f"{r['id']}\n{member}"):
            return "The owner already has that request; wait for their answer."
        ext.inbox.card("request-invite", f"Your assistant asks to invite {member} to {fmt.tok(r['name'], 60)}",
                       {"space": r["id"], "name": fmt.tok(r["name"], 60), "member": member, "key": f"{r['id']}\n{member}", "reason": fmt.clean(b.reason, 400)})
        return f"Asked the owner to invite {fmt.tok(member, 120)} to {fmt.tok(r['name'], 60)}. They decide."

    # ── cards: the owner decides ─────────────────────────────────────────────────────────────────
    def done(text: str) -> None:
        ext.emit("spaces-changed", {})
        eng.tell(text)

    def on_card(e: dict) -> None:
        kind, action, card = e.get("kind"), e.get("action"), e.get("card") or {}
        try:
            if kind == "invite":
                r = eng.rec(str(card.get("space")))
                if not r:
                    return
                if action == "accept":
                    eng.accept(r)
                    done(f"The owner accepted the invitation to the shared space {fmt.tok(r['name'], 60)}; it syncs into {agent_dir(r)}.")
                else:
                    eng.decline(r)
                    ext.emit("spaces-changed", {})
            elif kind == "request-create":
                if action == "approve":
                    r = eng.create(str(card.get("name")))
                    done(f"The owner approved your request: the shared space {fmt.tok(r['name'], 60)} exists, at {agent_dir(r)}.")
                else:
                    eng.tell(f"The owner declined your request to create the space {fmt.tok(card.get('name'), 60)}.")
            elif kind == "request-invite":
                if action == "approve":
                    eng.invite(eng.find(str(card.get("space"))), str(card.get("member")))
                    done(f"The owner approved your request: {fmt.tok(card.get('member'), 120)} was invited to {fmt.tok(card.get('name'), 60)}.")
                else:
                    eng.tell(f"The owner declined your request to invite {fmt.tok(card.get('member'), 120)} to {fmt.tok(card.get('name'), 60)}.")
        except SyncError as err:
            ext.notify("Shared spaces", f"That didn't work: {why(err)}", "/x/spaces/spaces")
            ext.store.set("last_action_error", why(err)[:300])

    ext.on("extension_card_resolved", on_card)

    # ── events and the job ───────────────────────────────────────────────────────────────────────
    def handle_invited(sid: str) -> None:
        try:
            me = eng.me()["address"]
            sp = next((s for s in eng.call("spaces.list").get("spaces") or [] if isinstance(s, dict) and s.get("id") == sid), None)
        except SyncError:
            return
        if not sp or not any(isinstance(m, dict) and str(m.get("address", "")).lower() == me and m.get("state") == "invited" for m in sp.get("members") or []):
            return  # an event the service sent that its own list doesn't back up: ignored
        r = eng.rec(sid)
        if r and (r["state"] == "member" or r.get("card")):
            return
        r = eng.adopt(sp, "invited") if not r else eng.update(sid, state="invited", creator=fmt.tok(sp.get("creator"), 120).lower(), name=fmt.tok(sp.get("name"), 80))
        cid = ext.inbox.card("invite", f"Invitation to the shared space {fmt.tok(r['name'], 60)} from {fmt.tok(r['creator'], 120)}",
                             {"space": sid, "name": fmt.tok(r["name"], 60), "creator": fmt.tok(r["creator"], 120)})
        eng.update(sid, card=cid)
        ext.emit("spaces-changed", {})

    def background(sid: str) -> None:
        try:
            eng.request_sync(sid)
        except SyncError:
            pass  # recorded on the space (error)
        ext.emit("spaces-changed", {})

    def on_event(e: dict) -> None:
        ev = str(e.get("event") or "")
        d = e.get("data") if isinstance(e.get("data"), dict) else {}
        sid = str(d.get("space") or "")
        if not E.SPACE_ID.match(sid):
            return
        if ev == "invited":
            return handle_invited(sid)
        r = eng.rec(sid)
        if not r:
            return
        try:
            if ev in ("head", "epoch") and r["state"] == "member":
                background(sid)
            elif ev == "members" and r["state"] == "member":
                eng.refresh_info(r)
            elif ev == "lock" and r["state"] == "member":
                eng.open_locks(r, eng.keys_of(sid))
            elif ev == "rekey":
                eng.regrant(r, str(d.get("member") or "").lower())
            elif ev in ("removed", "deleted"):
                eng.update(sid, state="removed" if ev == "removed" else "deleted", error=None)
                ext.notify("Shared spaces", f"{fmt.tok(r['name'], 60)} was {ev}; its files stay in the folder but no longer sync.", "/x/spaces/spaces")
        except SyncError:
            pass
        ext.emit("spaces-changed", {})

    ext.hub.on_event("spaces", on_event)

    def discover() -> None:
        me = eng.me()["address"]
        listed = {str(s.get("id")): s for s in eng.call("spaces.list").get("spaces") or [] if isinstance(s, dict) and E.SPACE_ID.match(str(s.get("id")))}
        for sid, sp in listed.items():
            mine = next((m.get("state") for m in sp.get("members") or [] if isinstance(m, dict) and str(m.get("address", "")).lower() == me), None)
            r = eng.rec(sid)
            if mine == "invited":
                if not r or (r["state"] != "invited" and r["state"] != "member"):
                    handle_invited(sid)
            elif mine == "member":
                if not r:
                    eng.adopt(sp, "member")
                elif r["state"] in ("invited", "removed"):
                    eng.update(sid, state="member")
        for r in eng.recs():
            if r["state"] == "member" and r["id"] not in listed:
                eng.update(r["id"], state="removed", error="The service no longer lists this space for you.")

    def job() -> None:
        try:
            eng.svc()
            discover()
        except SyncError:
            return
        for r in eng.recs():
            if r["state"] == "member":
                background(r["id"])

    ext.every(60, job)

    # ── the owner's page: owner decisions, read-mostly ───────────────────────────────────────────
    def owner(fn):
        def run(*a, **k):
            try:
                return fn(*a, **k)
            except E.SpaceError as e:
                raise HTTPException(400, str(e)) from e
            except HubCallError as e:
                raise HTTPException(502, E.describe(e)) from e
            except ExtensionError as e:
                raise HTTPException(400, why(e)) from e

        run.__name__ = fn.__name__
        run.__signature__ = inspect.signature(fn)  # type: ignore[attr-defined]
        return run

    @ext.router.get("/status")
    def o_status() -> dict:
        try:
            svc = eng.svc()
        except E.SpaceError:
            svc = None
        try:
            me = eng.me()["address"]
        except E.SpaceError:
            me = None
        return {"service": svc, "me": me, "folder": ext.folders.agent_path(E.FOLDER), "spaces": [eng.view(r) for r in eng.recs()]}

    @ext.router.get("/space")
    @owner
    def o_space(id: str) -> dict:
        r = eng.rec(id)
        if not r:
            raise E.SpaceError("Unknown space.")
        if r["state"] == "member":
            try:
                eng.open_locks(r, eng.keys_of(id))
            except SyncError:
                pass
        return eng.view(r, full=True)

    @ext.router.post("/create")
    @owner
    def o_create(body: NameIn) -> dict:
        return eng.view(eng.create(body.name))

    @ext.router.post("/invite")
    @owner
    def o_invite(body: MemberIn) -> dict:
        r = eng.find(body.space)
        eng.invite(r, body.member)
        return eng.view(eng.rec(r["id"]))

    @ext.router.post("/remove")
    @owner
    def o_remove(body: MemberIn) -> dict:
        r = eng.find(body.space)
        eng.remove_member(r, body.member)
        return eng.view(eng.rec(r["id"]))

    def withdraw(r: dict) -> None:
        if r.get("card"):
            try:
                ext.inbox.withdraw(int(r["card"]))
            except ExtensionError:
                pass

    @ext.router.post("/accept")
    @owner
    def o_accept(body: SpaceRef) -> dict:
        r = eng.find(body.space)
        if r["state"] != "invited":
            raise E.SpaceError("That isn't an invitation.")
        withdraw(r)
        eng.accept(r)
        return eng.view(eng.rec(r["id"]))

    @ext.router.post("/decline")
    @owner
    def o_decline(body: SpaceRef) -> dict:
        r = eng.find(body.space)
        withdraw(r)
        eng.decline(r)
        return eng.view(eng.rec(r["id"]))

    @ext.router.post("/leave")
    @owner
    def o_leave(body: SpaceRef) -> dict:
        r = eng.find(body.space)
        eng.leave(r)
        return eng.view(eng.rec(r["id"]))

    @ext.router.post("/delete")
    @owner
    def o_delete(body: SpaceRef) -> dict:
        r = eng.find(body.space)
        eng.delete(r)
        return eng.view(eng.rec(r["id"]))

    @ext.router.post("/sync")
    @owner
    def o_sync(body: SpaceRef) -> dict:
        r = eng.find(body.space)
        eng.sync(r["id"])
        return eng.view(eng.rec(r["id"]))

    @ext.router.post("/restore")
    @owner
    def o_restore(body: RestoreIn) -> dict:
        r = eng.find(body.space)
        eng.restore(r, body.seq)
        return eng.view(eng.rec(r["id"]), full=True)

    @ext.router.post("/break-lock")
    @owner
    def o_break(body: TagIn) -> dict:
        r = eng.find(body.space)
        eng.lock_break(r, body.tag)
        eng.open_locks(r, eng.keys_of(r["id"]))
        return eng.view(eng.rec(r["id"]), full=True)
