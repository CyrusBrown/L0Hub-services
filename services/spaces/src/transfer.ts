// PUT / GET https://<service hostname>/v0/blob/<ticket>: where blobs go in and out. The ticket is the credential.
// The service checks sizes and the first byte (0x01), never the contents: it can't read them.
import { ServiceError } from "@l0wservices/core";
import { BLOB_OVERHEAD, limits, type SpacesEnv } from "./env";
import { inSpace } from "./durable";
import { openTicket } from "./tickets";

const PREFIX = "/v0/blob/";

const reply = (status: number, error: string, detail = ""): Response =>
  new Response(JSON.stringify({ v: "l0w/0.1", error, detail }), { status, headers: { "content-type": "application/json" } });

const STATUS: Record<string, number> = {
  ticket_used: 410,
  quota_exceeded: 413,
  not_found: 404,
  not_member: 403,
};

class BadBlob extends Error {}

/** Passes the stored form through, checking it starts with 0x01 and is exactly `size` bytes. */
function checker(size: number, fail: (e: BadBlob) => void): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream({
    transform(chunk, controller) {
      if (seen === 0 && chunk.length > 0 && chunk[0] !== 1) {
        const e = new BadBlob("the stored form starts with 0x01");
        fail(e);
        throw e;
      }
      seen += chunk.length;
      if (seen > size) {
        const e = new BadBlob("more bytes than the size");
        fail(e);
        throw e;
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== size) {
        const e = new BadBlob("fewer bytes than the size");
        fail(e);
        throw e;
      }
    },
  });
}

export function isTransfer(url: URL): boolean {
  return url.pathname.startsWith(PREFIX);
}

export async function transfer(request: Request, env: SpacesEnv): Promise<Response> {
  const put = request.method === "PUT";
  if (!put && request.method !== "GET") return reply(405, "method_not_allowed");
  const opened = await openTicket(env.TICKET_KEY ?? "", new URL(request.url).pathname.slice(PREFIX.length));
  if (!opened) return reply(403, "bad_ticket");
  const { ticket: t, mac } = opened;
  if (t.dir !== (put ? "put" : "get")) return reply(403, "bad_ticket", "this URL is for the other direction");
  const now = Math.floor(Date.now() / 1000);
  if (t.exp <= now) return reply(410, "expired", "ask for a new URL");
  const key = `${t.space}/${t.id}`;
  const lim = limits(env);
  const release = () => inSpace(env, t.space, "ticketRelease", put ? { mac, space: t.space, id: t.id } : { mac }).catch(() => undefined);

  if (!put) {
    let size: number;
    try {
      size = (await inSpace(env, t.space, "blobGet", { space: t.space, by: t.by, id: t.id, mac, exp: t.exp })).result.size as number;
    } catch (e) {
      if (e instanceof ServiceError) return reply(STATUS[e.code] ?? 400, e.code, e.detail);
      throw e;
    }
    const obj = await env.BLOBS.get(key);
    if (!obj) {
      await release();
      return reply(404, "not_found", "the blob is not in storage");
    }
    return new Response(obj.body, { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(size), "cache-control": "no-store" } });
  }

  if (t.size < BLOB_OVERHEAD || t.size > lim.maxFile + BLOB_OVERHEAD) return reply(413, "too_large", `a file is at most ${lim.maxFile} bytes`);
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) return reply(411, "length_required", "send Content-Length");
  if (Number(declared) !== t.size) return reply(400, "size_mismatch", `the ticket is for ${t.size} bytes`);
  if (!request.body) return reply(400, "bad_blob", "no body");

  let begun: boolean;
  try {
    begun = !(await inSpace(env, t.space, "blobBegin", { space: t.space, by: t.by, id: t.id, size: t.size, mac, exp: t.exp, now })).result.exists;
  } catch (e) {
    if (e instanceof ServiceError) return reply(STATUS[e.code] ?? 400, e.code, e.detail);
    throw e;
  }
  if (!begun) {
    await request.body.cancel().catch(() => undefined); // a blob is never overwritten: its id names its contents
    return new Response(JSON.stringify({ v: "l0w/0.1", stored: true }), { status: 200, headers: { "content-type": "application/json" } });
  }

  let problem: BadBlob | null = null;
  let body: ReadableStream<Uint8Array> = request.body.pipeThrough(checker(t.size, (e) => (problem = e)));
  const FixedLength = (globalThis as unknown as { FixedLengthStream?: new (n: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).FixedLengthStream;
  if (FixedLength) {
    const fixed = new FixedLength(t.size);
    body.pipeTo(fixed.writable).catch(() => undefined);
    body = fixed.readable;
  }
  try {
    await env.BLOBS.put(key, body, { httpMetadata: { contentType: "application/octet-stream" } });
  } catch (e) {
    await env.BLOBS.delete(key).catch(() => undefined);
    await release();
    if (problem) return reply(400, "bad_blob", (problem as BadBlob).message);
    console.error("blob upload failed:", e);
    return reply(502, "storage_failed", "try again");
  }
  await inSpace(env, t.space, "blobCommit", { space: t.space, id: t.id, size: t.size, now });
  return new Response(JSON.stringify({ v: "l0w/0.1", stored: true }), { status: 201, headers: { "content-type": "application/json" } });
}
