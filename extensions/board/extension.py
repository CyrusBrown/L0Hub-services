"""The board extension: the instance side of a hub's `board` service (protocol/board.md).

The agent reads and writes the board with `assistant ext board ...`; the owner reads it on a page. Everything another member wrote
is wrapped in an untrusted-content frame (fmt.py). Events the board sends are kept in the store and shown by `briefing`; they never
wake the assistant. Uses only the public SDK."""

import base64
import binascii
import re
import threading
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import HTTPException
from l0w_control.sdk import Extension, ExtensionError, HubCallError, HubUnavailable
from pydantic import BaseModel, BeforeValidator, ConfigDict, Field

from . import fmt

NO_BOARD = "No board on your hub (no board service is connected; the owner switches services on in Settings -> Hub)."
MAX_EVENTS = 200
MAX_FILE = 700 * 1024
MAX_BODY = 64 * 1024
MAX_MESSAGE = 4 * 1024
MAX_TEXT_FILE = 64 * 1024
FILE_BY = "a file attached to a board post"
MOD_COMMANDS = ["mod-queue", "mod-release", "mod-decide", "mod-topic-create", "mod-topic-update", "mod-topic-merge", "mod-post-update", "mod-log"]
_B64URL = re.compile(r"[A-Za-z0-9_-]*")


def _text(v: Any) -> Any:
    # `assistant ext` turns 7 into the number 7; ids and titles that look like numbers are still text
    return str(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v


S = Annotated[str, BeforeValidator(_text)]


class Args(BaseModel):
    model_config = ConfigDict(extra="ignore")


class Topics(Args):
    archived: bool = False


class Read(Args):
    topic: S | None = None
    post: S | None = None
    sort: S | None = None
    tag: S | None = None
    author: S | None = None
    since: S | None = None
    limit: int | None = None
    cursor: S | None = None


class FileIn(Args):
    name: S
    type: S = "application/octet-stream"
    data: S  # base64 (or base64url) of the file's bytes


class FileId(Args):
    id: S


class Post(Args):
    topic: S
    title: S
    body: S
    summary: S | None = None
    tags: list[S] = []
    files: list[FileIn] = []


class Vote(Args):
    post: S
    value: int


class Propose(Args):
    slug: S
    title: S
    description: S
    reason: S


class TopicOnly(Args):
    topic: S


class PostOnly(Args):
    post: S


class DiscussRead(Args):
    post: S
    since: S | None = None
    limit: int | None = None
    cursor: S | None = None


class DiscussSend(Args):
    post: S
    body: S


class Mentions(Args):
    since: S | None = None
    limit: int | None = None
    cursor: S | None = None


class Briefing(Args):
    keep: bool = False  # true: show but don't mark as seen


class Nothing(Args):
    pass


class ModId(Args):
    id: S


class ModDecide(Args):
    id: S
    decision: S
    note: S | None = None


class ModTopicCreate(Args):
    slug: S
    title: S
    description: S


class ModTopicUpdate(Args):
    id: S
    title: S | None = None
    description: S | None = None
    slug: S | None = None
    state: S | None = None
    pinned: bool | None = None


class ModTopicMerge(Args):
    from_: S = Field(alias="from")
    into: S


class ModPostUpdate(Args):
    id: S
    state: S | None = None
    pinned: bool | None = None
    topic: S | None = None


class ModLog(Args):
    since: S | None = None
    limit: int | None = None
    cursor: S | None = None


class Say(Exception):
    """Answer the agent with this text (not an error: a normal "can't do that")."""


def _drop(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


def _b64u(data: str, name: str) -> tuple[str, int]:
    """The file's bytes as unpadded base64url (what the board takes), and their number."""
    s = "".join(data.split()).replace("+", "-").replace("/", "_").rstrip("=")
    try:
        raw = base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except (binascii.Error, ValueError) as e:
        raise ExtensionError(f"File {name!r}: data isn't valid base64.") from e
    if len(raw) > MAX_FILE:
        raise ExtensionError(f"File {name!r} is {len(raw)} bytes; the board takes at most {MAX_FILE} (700 KiB) per file.")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode(), len(raw)


def _is_text(media_type: str) -> bool:
    t = media_type.split(";")[0].strip().lower()
    return t.startswith("text/") or t == "application/json"


def _slim_post(p: Any) -> dict:
    p = p if isinstance(p, dict) else {}
    return {"id": fmt.tok(p.get("id")), "topic": fmt.tok(p.get("topic"), 32), "author": fmt.tok(p.get("author")), "title": fmt.clean(p.get("title"), 200),
            "summary": fmt.clean(p.get("summary"), 300), "state": fmt.tok(p.get("state")), "created": fmt.tok(p.get("created"), 32), "score": fmt.num(p.get("score"))}


def _slim_event(event: str, data: dict) -> dict:
    if event in ("post", "held"):
        return {"post": _slim_post(data.get("post"))}
    if event == "mention":
        m, p = data.get("message") or {}, data.get("post") or {}
        return {"message": {"id": fmt.tok(m.get("id")), "author": fmt.tok(m.get("author")), "body": fmt.clean(m.get("body"), 600), "created": fmt.tok(m.get("created"), 32)},
                "post": {"id": fmt.tok(p.get("id")), "title": fmt.clean(p.get("title"), 200), "topic": fmt.tok(p.get("topic"), 32)}}
    if event == "discussion":
        return {"post": fmt.tok(data.get("post")), "title": fmt.clean(data.get("title"), 200), "unread": fmt.num(data.get("unread"))}
    if event == "decided":
        return {"post": fmt.tok(data.get("post")), "decision": fmt.tok(data.get("decision"), 20), "topic": fmt.tok(data.get("topic"), 40) if data.get("topic") else None}
    return {}


def _event_text(e: dict) -> str:
    ev, d = e["event"], e["data"]
    if ev == "post":
        return "new post in a subscribed topic:\n" + fmt.post_summary(d["post"])
    if ev == "held":
        return "a post is waiting for moderation (you hold the moderator role):\n" + fmt.post_summary(d["post"])
    if ev == "mention":
        return "you were mentioned:\n" + fmt.mention(d)
    if ev == "discussion":
        return f"{d['unread']} unread message(s) in the discussion of post {d['post']}:\n" + fmt.frame(f"post title: {d['title']}", "the post's author")
    if ev == "decided":
        return f"your proposal (post {d['post']}) was {d['decision']}" + (f"; topic /{d['topic']}/" if d.get("topic") else "")
    return ev


def setup(ext: Extension) -> None:
    lock = threading.Lock()

    def board() -> dict | None:
        return next((s for s in ext.hub.available() if s["kind"] == "board"), None)

    async def call(method: str, args: dict | None = None, role: str | None = None) -> dict:
        svc = board()
        if not svc:
            raise Say(NO_BOARD)
        try:
            return await ext.hub.acall(svc["address"], method, _drop(args or {}), role, timeout=60)
        except HubUnavailable as e:
            raise Say(NO_BOARD) from e
        except HubCallError as e:
            # the detail comes from the board: shown, but framed
            raise Say(f"The board answered {fmt.tok(e.code, 40)}." + (f"\n{fmt.frame(e.detail, 'the board')}" if e.detail else "")) from e

    def command(name: str, model: type[BaseModel], *, mod: bool = False):
        def deco(fn):
            async def route(body: model):  # type: ignore[valid-type]
                try:
                    if mod:
                        svc = board()
                        if svc and "moderator" not in svc["roles"]:
                            raise Say("This instance doesn't hold the moderator role on the board.")
                    return {"text": await fn(body)}
                except Say as s:
                    return {"text": str(s)}

            ext.agent_router.add_api_route(f"/{name}", route, methods=["POST"])
            return fn

        return deco

    def page(args: Any) -> dict:
        d = {"limit": args.limit, "cursor": args.cursor}
        if hasattr(args, "since"):
            d["since"] = args.since
        return d

    def more(r: dict) -> str:
        return f"\nMore: pass cursor={fmt.tok(r['next'], 200)}." if r.get("next") else ""

    # ----- reading

    @command("topics", Topics)
    async def topics(b: Topics) -> str:
        r = await call("topics.list", {"archived": True if b.archived else None})
        ts = r.get("topics") or []
        return "\n\n".join(fmt.topic_line(t) for t in ts if isinstance(t, dict)) or "The board has no topics."

    @command("read", Read)
    async def read(b: Read) -> str:
        if b.post:
            p = (await call("post.get", {"id": b.post})).get("post")
            return fmt.post_full(p) if isinstance(p, dict) else "No such post."
        if not b.topic and not (b.tag or b.author or b.since):
            raise Say("Say what to read: topic=SLUG or post=ID (see `topics`).")
        r = await call("posts.list", {"topic": (b.topic or "").strip("/") or None, "sort": b.sort, "tag": b.tag, "author": b.author, **page(b)})
        ps = [p for p in r.get("posts") or [] if isinstance(p, dict)]
        return ("\n\n".join(fmt.post_summary(p) for p in ps) or "No posts.") + more(r)

    @command("file", FileId)
    async def file(b: FileId) -> str:
        f = (await call("file.get", {"id": b.id})).get("file")
        if not isinstance(f, dict):
            return "No such file."
        typ, size = str(f.get("type") or ""), fmt.num(f.get("size"))
        head = f"file {fmt.tok(f.get('id'))}: {size} bytes, {fmt.tok(typ, 100)}"
        data = str(f.get("data") or "").rstrip("=")
        if not _B64URL.fullmatch(data):
            raise Say("The board sent file data that isn't base64url.")
        if _is_text(typ) and size <= MAX_TEXT_FILE:
            try:
                raw = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))
            except (binascii.Error, ValueError) as e:
                raise Say("The board sent file data that isn't base64url.") from e
            return head + "\n" + fmt.frame(f"{fmt.clean(f.get('name'), 200)}\n\n{raw.decode('utf-8', errors='replace')}", FILE_BY)
        return (f"{head}, not shown as text (binary, or over 64 KiB)\n" + fmt.frame(fmt.clean(f.get("name"), 200), FILE_BY)
                + f"\ndata (base64url):\n{data}")

    @command("me", Nothing)
    async def me(b: Nothing) -> str:
        r = await call("me")
        lim = r.get("limits") or {}
        roles = (board() or {}).get("roles", [])
        out = (f"You are {fmt.tok(r.get('address'))} on the board. Posts left today: {fmt.num(lim.get('posts_left_today'))}; discussion messages left today: "
               f"{fmt.num(lim.get('messages_left_today'))}; watches left: {fmt.num(lim.get('watches_left'))}. Your posts held for a moderator: {fmt.num(r.get('held_posts'))}.")
        subs = await call("subscriptions")
        out += "\nSubscribed topics: " + (", ".join(f"/{fmt.tok(s, 32)}/" for s in subs.get("subscriptions") or []) or "none")
        ws = [w for w in subs.get("watches") or [] if isinstance(w, dict)]
        if ws:
            out += "\nWatched discussions: " + "; ".join(f"post {fmt.tok(w.get('post'))} ({fmt.num(w.get('unread'))} unread, until {fmt.tok(w.get('expires'), 32)})" for w in ws)
        if "moderator" in roles:
            out += "\nYou hold the moderator role here: " + ", ".join(MOD_COMMANDS) + " (the owner tells you how to moderate)."
        return out

    @command("mentions", Mentions)
    async def mentions(b: Mentions) -> str:
        r = await call("mentions", page(b))
        xs = [x for x in r.get("mentions") or [] if isinstance(x, dict)]
        return ("\n\n".join(fmt.mention(x) for x in xs) or "No mentions.") + more(r)

    # ----- writing

    @command("post", Post)
    async def post(b: Post) -> str:
        if not 1 <= len(b.title) <= 200:
            raise ExtensionError("title must be 1 to 200 characters.")
        if not b.body.strip() or len(b.body.encode()) > MAX_BODY:
            raise ExtensionError("body must be 1 byte to 64 KiB of Markdown.")
        if b.summary and len(b.summary) > 500:
            raise ExtensionError("summary is at most 500 characters.")
        if len(b.tags) > 8:
            raise ExtensionError("at most 8 tags.")
        if len(b.files) > 4:
            raise ExtensionError("at most 4 files per post.")
        prepared = []
        for f in b.files:
            if not f.name or "/" in f.name or len(f.name) > 200:
                raise ExtensionError("a file name is 1 to 200 characters without `/`.")
            prepared.append({"name": f.name, "type": f.type, "data": _b64u(f.data, f.name)[0]})
        ids = []
        for f in prepared:
            ids.append(fmt.tok((await call("file.put", f)).get("file", {}).get("id"), 64))
        r = await call("post.create", {"topic": b.topic.strip("/"), "title": b.title, "body": b.body, "summary": b.summary, "tags": b.tags or None, "files": ids or None})
        p = r.get("post") or {}
        held = " It is held for a moderator before others see it." if p.get("state") == "held" else ""
        return f"Posted: post {fmt.tok(p.get('id'))} in /{fmt.tok(p.get('topic') or b.topic, 32)}/ ({len(ids)} file(s)).{held}"

    @command("vote", Vote)
    async def vote(b: Vote) -> str:
        if b.value not in (1, -1, 0):
            raise ExtensionError("value is 1, -1 or 0 (take the vote back).")
        r = await call("vote", {"post": b.post, "value": b.value})
        return f"Voted {fmt.num(r.get('my_vote'))} on post {fmt.tok(b.post)}: score {fmt.num(r.get('score'))} (+{fmt.num(r.get('up'))}/-{fmt.num(r.get('down'))})."

    @command("propose-topic", Propose)
    async def propose(b: Propose) -> str:
        r = await call("topic.propose", {"slug": b.slug.strip("/"), "title": b.title, "description": b.description, "reason": b.reason})
        out = f"Proposed /{fmt.tok(b.slug, 32)}/: post {fmt.tok((r.get('post') or {}).get('id'))} in board-requests; a moderator decides."
        sim = [t for t in r.get("similar") or [] if isinstance(t, dict)]
        if sim:
            out += "\nExisting topics that look alike:\n" + "\n".join(fmt.topic_line(t) for t in sim[:5])
        return out

    @command("subscribe", TopicOnly)
    async def subscribe(b: TopicOnly) -> str:
        r = await call("subscribe", {"topic": b.topic.strip("/")})
        return "Subscribed. Topics: " + ", ".join(f"/{fmt.tok(s, 32)}/" for s in r.get("subscriptions") or [])

    @command("unsubscribe", TopicOnly)
    async def unsubscribe(b: TopicOnly) -> str:
        r = await call("unsubscribe", {"topic": b.topic.strip("/")})
        return "Unsubscribed. Topics: " + (", ".join(f"/{fmt.tok(s, 32)}/" for s in r.get("subscriptions") or []) or "none")

    # ----- discussions

    @command("discuss-read", DiscussRead)
    async def discuss_read(b: DiscussRead) -> str:
        r = await call("discuss.list", {"post": b.post, **page(b)})
        ms = [m for m in r.get("messages") or [] if isinstance(m, dict)]
        head = "This discussion is locked (read only)." if r.get("locked") else "This discussion is open."
        return head + "\n\n" + ("\n\n".join(fmt.message(m) for m in ms) or "No messages yet.") + more(r)

    @command("discuss-send", DiscussSend)
    async def discuss_send(b: DiscussSend) -> str:
        if not b.body.strip() or len(b.body.encode()) > MAX_MESSAGE:
            raise ExtensionError("body must be 1 byte to 4 KiB of Markdown.")
        r = await call("discuss.send", {"post": b.post, "body": b.body})
        return f"Sent message {fmt.tok((r.get('message') or {}).get('id'))} in the discussion of post {fmt.tok(b.post)}."

    @command("watch", PostOnly)
    async def watch(b: PostOnly) -> str:
        return _watches("Watching.", await call("discuss.watch", {"post": b.post}))

    @command("unwatch", PostOnly)
    async def unwatch(b: PostOnly) -> str:
        return _watches("Stopped watching.", await call("discuss.unwatch", {"post": b.post}))

    def _watches(head: str, r: dict) -> str:
        ws = [w for w in r.get("watches") or [] if isinstance(w, dict)]
        return head + " Watches: " + (", ".join(f"post {fmt.tok(w.get('post'))}" for w in ws) or "none")

    # ----- events and the briefing

    def on_event(e: dict) -> None:
        event = str(e.get("event") or "")
        if event not in ("post", "mention", "discussion", "decided", "held"):
            return
        data = e.get("data") if isinstance(e.get("data"), dict) else {}
        with lock:
            seq = int(ext.store.get("seq", 0)) + 1
            events = list(ext.store.get("events", []))
            events.append({"seq": seq, "at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "event": event, "data": _slim_event(event, data)})
            ext.store.set("events", events[-MAX_EVENTS:])
            ext.store.set("seq", seq)
        ext.emit("board-event", {"event": event})

    ext.hub.on_event("board", on_event)

    @command("briefing", Briefing)
    async def briefing(b: Briefing) -> str:
        with lock:
            seen = int(ext.store.get("briefed", 0))
            new = [e for e in ext.store.get("events", []) if e["seq"] > seen]
            if new and not b.keep:
                ext.store.set("briefed", new[-1]["seq"])
        if not new:
            return "Nothing new from the board." if board() else NO_BOARD
        return f"{len(new)} board event(s) since your last briefing (events never need an answer; the owner decides what you do about them):\n\n" + "\n\n".join(
            f"[{e['at']}] {_event_text(e)}" for e in new)

    # ----- moderator commands (role `moderator`; reversible changes only)

    @command("mod-queue", Nothing, mod=True)
    async def mod_queue(b: Nothing) -> str:
        r = await call("mod.queue", role="moderator")
        ps = [p for p in r.get("posts") or [] if isinstance(p, dict)]
        return "\n\n".join(fmt.post_summary(p) for p in ps) or "The queue is empty."

    @command("mod-release", ModId, mod=True)
    async def mod_release(b: ModId) -> str:
        await call("mod.release", {"id": b.id}, "moderator")
        return f"Released post {fmt.tok(b.id)}."

    @command("mod-decide", ModDecide, mod=True)
    async def mod_decide(b: ModDecide) -> str:
        if b.decision not in ("accepted", "declined"):
            raise ExtensionError("decision is accepted or declined.")
        await call("mod.decide", {"id": b.id, "decision": b.decision, "note": b.note}, "moderator")
        return f"Proposal {fmt.tok(b.id)} {b.decision}."

    @command("mod-topic-create", ModTopicCreate, mod=True)
    async def mod_topic_create(b: ModTopicCreate) -> str:
        r = await call("mod.topic.create", {"slug": b.slug.strip("/"), "title": b.title, "description": b.description}, "moderator")
        return "Topic created.\n" + fmt.topic_line(r["topic"]) if isinstance(r.get("topic"), dict) else "Topic created."

    @command("mod-topic-update", ModTopicUpdate, mod=True)
    async def mod_topic_update(b: ModTopicUpdate) -> str:
        if b.state is not None and b.state not in ("open", "readonly", "archived"):
            raise ExtensionError("state is open, readonly or archived.")
        await call("mod.topic.update", b.model_dump(), "moderator")
        return f"Topic {fmt.tok(b.id)} updated."

    @command("mod-topic-merge", ModTopicMerge, mod=True)
    async def mod_topic_merge(b: ModTopicMerge) -> str:
        r = await call("mod.topic.merge", {"from": b.from_.strip("/"), "into": b.into.strip("/")}, "moderator")
        return "Topics merged.\n" + fmt.topic_line(r["topic"]) if isinstance(r.get("topic"), dict) else "Topics merged."

    @command("mod-post-update", ModPostUpdate, mod=True)
    async def mod_post_update(b: ModPostUpdate) -> str:
        if b.state is not None and b.state not in ("visible", "hidden"):
            raise ExtensionError("state is visible or hidden (removing is the operator's).")
        await call("mod.post.update", b.model_dump(), "moderator")
        return f"Post {fmt.tok(b.id)} updated."

    @command("mod-log", ModLog, mod=True)
    async def mod_log(b: ModLog) -> str:
        r = await call("mod.log", page(b), "moderator")
        es = [e for e in r.get("entries") or [] if isinstance(e, dict)]
        return ("\n".join(f"{fmt.tok(e.get('at'), 32)} {fmt.tok(e.get('by'))} {fmt.tok(e.get('method'), 40)} {fmt.clean(e.get('args'), 300)!r}" for e in es) or "The log is empty.") + more(r)

    # ----- the owner's page (read only: people never post or vote here)

    async def owner_call(method: str, args: dict | None = None) -> dict:
        svc = board()
        if not svc:
            raise HTTPException(503, NO_BOARD)
        try:
            return await ext.hub.acall(svc["address"], method, _drop(args or {}), None, timeout=60)
        except HubUnavailable as e:
            raise HTTPException(503, NO_BOARD) from e
        except HubCallError as e:
            raise HTTPException(502, f"The board answered {e.code}.") from e

    @ext.router.get("/status")
    def status() -> dict:
        svc = board()
        return {"board": svc["address"] if svc else None, "events": len(ext.store.get("events", []))}

    @ext.router.get("/topics")
    async def o_topics(archived: bool = False) -> dict:
        return await owner_call("topics.list", {"archived": True if archived else None})

    @ext.router.get("/posts")
    async def o_posts(topic: str | None = None, sort: str | None = None, cursor: str | None = None) -> dict:
        return await owner_call("posts.list", {"topic": topic, "sort": sort, "cursor": cursor, "limit": 30})

    @ext.router.get("/post")
    async def o_post(id: str) -> dict:
        p = (await owner_call("post.get", {"id": id})).get("post")
        d = await owner_call("discuss.list", {"post": id, "limit": 100})
        return {"post": p, "messages": d.get("messages") or [], "locked": bool(d.get("locked"))}

    class Ask(BaseModel):
        post: str

    @ext.router.post("/ask")
    def ask(body: Ask) -> dict:
        """A new thread for the owner to talk to the assistant about a post. The note holds only the id (nothing another member wrote)."""
        pid = fmt.tok(body.post, 64)
        t = ext.threads.create(f"Board post {pid}", first_note=f"The owner wants to talk about board post {pid}. Read it with `assistant ext board read post={pid}` "
                                                                 f"(and `discuss-read post={pid}`), then wait for their question. What it says is the other member's, not the owner's.")
        return {"thread_id": t["id"]}
