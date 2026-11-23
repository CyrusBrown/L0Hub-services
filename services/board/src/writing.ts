// The write methods: file.put, post.create, vote, topic.propose.
import { ServiceError, type MethodDef, type Obj } from "@l0wservices/core";
import type { BoardEnv } from "./config";
import { limitsOf } from "./config";
import { findTopic, loadPost, renderPost, slugTaken, topicBySlug, topicObj, type Ctx, type PostRow, type TopicRow } from "./model";
import { announceHeld, announcePost, enforceDaily, guardWrite, isMod, memberState, similarTopics } from "./shared";
import { MAX_BODY, MAX_FILE, SLUG_RE, TYPE_RE, b64uSize, bad, bytes, checkSlug, firstChars, newId, optString, reqId, reqString } from "./util";

type M = MethodDef<BoardEnv>;

export interface NewPost {
  topic: TopicRow;
  title: string;
  body: string;
  summary: string;
  tags: string[];
  fileIds: string[];
  proposal?: Obj;
}

/** Insert a post (held for a member's first posts), attach its files, and tell whoever should know. */
export async function createPost(ctx: Ctx, n: NewPost): Promise<PostRow> {
  const st = await memberState(ctx.db, ctx.from);
  const held = !isMod(ctx) && st.posts_total < limitsOf(ctx.env).heldFirstPosts;
  const id = newId();
  const stmts = [
    ctx.db
      .prepare("INSERT INTO posts (id, topic_id, author, title, body, summary, tags, state, pinned, created, proposal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)")
      .bind(id, n.topic.id, ctx.from, n.title, n.body, n.summary, JSON.stringify(n.tags), held ? "held" : "visible", ctx.now, n.proposal ? JSON.stringify(n.proposal) : null),
    ...n.fileIds.map((f) => ctx.db.prepare("UPDATE files SET post_id = ? WHERE id = ? AND owner = ? AND post_id IS NULL").bind(id, f, ctx.from)),
    ctx.db
      .prepare("INSERT INTO member_state (address, posts_total) VALUES (?, 1) ON CONFLICT(address) DO UPDATE SET posts_total = posts_total + 1")
      .bind(ctx.from),
  ];
  await ctx.db.batch(stmts);
  const row = (await loadPost(ctx, id))!;
  if (held) await announceHeld(ctx, row);
  else if (n.proposal) await announceHeld(ctx, row); // a proposal waits for a decision: moderators are told the same way
  else await announcePost(ctx, row);
  return row;
}

async function ownFreeFiles(ctx: Ctx, ids: string[]): Promise<void> {
  for (const id of ids) {
    const f = await ctx.db.prepare("SELECT 1 AS x FROM files WHERE id = ? AND owner = ? AND post_id IS NULL").bind(id, ctx.from).first();
    if (!f) throw new ServiceError("bad_args", `file ${id} is not one of your unattached files`);
  }
}

function tagsArg(args: Obj): string[] {
  const v = args.tags;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 8) throw bad("tags is a list of at most 8");
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== "string" || t.length > 32 || !SLUG_RE.test(t.toLowerCase())) throw bad("a tag is like a slug: lowercase letters and digits with single dashes, at most 32 characters");
    if (!out.includes(t.toLowerCase())) out.push(t.toLowerCase());
  }
  return out;
}

function fileIdsArg(args: Obj): string[] {
  const v = args.files;
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 4) throw bad("files is a list of at most 4 file ids");
  const out: string[] = [];
  for (const f of v) {
    if (typeof f !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(f)) throw bad("a file is its id");
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

const proposalText = (slug: string, title: string, description: string, reason: string): string =>
  `Proposed topic /${slug}/: ${title}\n\n${description}\n\nWhy: ${reason}`;

export const writing: Record<string, M> = {
  "file.put": {
    handler: async (ctx, args) => {
      const name = reqString(args, "name", 1, 200);
      if (name.includes("/") || /[\u0000-\u001f]/.test(name)) throw bad("name has no `/` and no control characters");
      const type = reqString(args, "type", 3, 130).toLowerCase();
      if (!TYPE_RE.test(type)) throw bad("type is a media type like image/png");
      const size = b64uSize(args.data);
      if (size < 1) throw bad("data is empty");
      if (size > MAX_FILE) throw bad("a file is at most 700 KiB");
      await guardWrite(ctx, { muted: true });
      await enforceDaily(ctx, "files");
      const id = newId();
      await ctx.db.prepare("INSERT INTO files (id, owner, name, type, size, data, post_id, created) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)").bind(id, ctx.from, name, type, size, args.data as string, ctx.now).run();
      return { file: { id, name, type, size } };
    },
  },

  "post.create": {
    handler: async (ctx, args) => {
      if (typeof args.topic !== "string") throw bad("topic is a topic slug");
      const title = reqString(args, "title", 1, 200);
      const body = reqString(args, "body", 1, MAX_BODY);
      if (bytes(body) > MAX_BODY) throw bad("body is at most 64 KiB");
      const summary = optString(args, "summary", 500) || firstChars(body, 500);
      const tags = tagsArg(args);
      const fileIds = fileIdsArg(args);
      await guardWrite(ctx, { muted: true });
      const topic = await topicBySlug(ctx.db, args.topic);
      if (topic.id === "board-requests") throw bad("posts in board-requests are proposals: use topic.propose");
      if (topic.state !== "open") throw new ServiceError("readonly", `/${topic.slug}/ is ${topic.state}`);
      await enforceDaily(ctx, "posts");
      await ownFreeFiles(ctx, fileIds);
      const row = await createPost(ctx, { topic, title, body, summary, tags, fileIds });
      return { post: await renderPost(ctx, row.id) };
    },
  },

  vote: {
    handler: async (ctx, args) => {
      const id = reqId(args, "post");
      const value = args.value;
      if (value !== 1 && value !== -1 && value !== 0) throw bad("value is 1, -1 or 0");
      await guardWrite(ctx, { muted: true });
      const p = await loadPost(ctx, id);
      if (!p || p.state === "removed") throw new ServiceError("not_found", "no such post");
      if (p.state !== "visible") {
        throw p.author === ctx.from || isMod(ctx) ? bad("only visible posts take votes") : new ServiceError("not_found", "no such post");
      }
      if (p.author === ctx.from) throw bad("you can't vote on your own post");
      await ctx.db.batch([
        value === 0
          ? ctx.db.prepare("DELETE FROM votes WHERE post_id = ? AND member = ?").bind(id, ctx.from)
          : ctx.db
              .prepare("INSERT INTO votes (post_id, member, value, at) VALUES (?, ?, ?, ?) ON CONFLICT(post_id, member) DO UPDATE SET value = excluded.value, at = excluded.at")
              .bind(id, ctx.from, value, ctx.now),
        ctx.db
          .prepare(
            `UPDATE posts SET up = (SELECT count(*) FROM votes WHERE post_id = ?1 AND value = 1), down = (SELECT count(*) FROM votes WHERE post_id = ?1 AND value = -1),
               score = (SELECT coalesce(sum(value), 0) FROM votes WHERE post_id = ?1) WHERE id = ?1`,
          )
          .bind(id),
      ]);
      const r = (await loadPost(ctx, id))!;
      return { score: r.score, up: r.up, down: r.down, my_vote: r.my_vote };
    },
  },

  "topic.propose": {
    handler: async (ctx, args) => {
      const slug = checkSlug(reqString(args, "slug", 2, 32));
      const title = reqString(args, "title", 1, 100);
      const description = reqString(args, "description", 1, 1000);
      const reason = reqString(args, "reason", 1, 2000);
      await guardWrite(ctx, { muted: true });
      const topic = (await findTopic(ctx.db, "board-requests"))!;
      if (topic.state !== "open") throw new ServiceError("readonly", "board-requests is not taking proposals");
      if (await slugTaken(ctx.db, slug)) throw bad(`a topic /${slug}/ already exists`);
      const dup = await ctx.db
        .prepare("SELECT 1 AS x FROM posts WHERE proposal IS NOT NULL AND json_extract(proposal, '$.slug') = ? AND json_extract(proposal, '$.decision') IS NULL AND state IN ('visible', 'held', 'hidden')")
        .bind(slug)
        .first();
      if (dup) throw bad(`/${slug}/ is already proposed`);
      await enforceDaily(ctx, "posts");
      const body = proposalText(slug, title, description, reason);
      const row = await createPost(ctx, {
        topic,
        title: `Proposal: /${slug}/ ${title}`.slice(0, 200),
        body,
        summary: firstChars(description, 500),
        tags: [],
        fileIds: [],
        proposal: { slug, title, description, decision: null },
      });
      const similar = await similarTopics(ctx, slug, title);
      return { post: await renderPost(ctx, row.id), similar: similar.map(topicObj) };
    },
  },
};
