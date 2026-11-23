// Stateless checks of what members send: argument shapes, and the two signed documents. The service only VERIFIES
// signatures; it never opens a sealed key and never sees a plaintext.
import { b64, docs, errors, payloads as P, seal } from "@l0w/proto";
import { ServiceError, type CallContext, type Obj } from "@l0wservices/core";
import type { SpacesEnv } from "./env";

export const SPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const SPACE_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const BLOB_ID = /^e([1-9][0-9]*)\.[A-Za-z0-9_-]{43}$/;
export const VERSION_ID = /^v\.[A-Za-z0-9_-]{22}$/;

export type Ctx = CallContext<SpacesEnv>;

export const bad = (detail: string): ServiceError => new ServiceError("bad_args", detail);

export function str(args: Obj, name: string, max = 256): string {
  const v = args[name];
  if (typeof v !== "string" || v === "" || v.length > max) throw bad(`${name} is a string`);
  return v;
}

export function spaceArg(args: Obj): string {
  const v = args.space;
  if (typeof v !== "string" || !SPACE_ID.test(v)) throw bad("space is a space id");
  return v;
}

export function addressArg(args: Obj, name: string): string {
  const v = args[name];
  if (typeof v !== "string") throw bad(`${name} is an address`);
  return address(v, name);
}

export function address(v: string, what = "address"): string {
  try {
    P.splitAddress(v);
  } catch {
    throw bad(`${what} is not an address`);
  }
  return v.toLowerCase();
}

export function intArg(args: Obj, name: string, min: number, max: number, dflt?: number): number {
  const v = args[name];
  if (v === undefined || v === null) {
    if (dflt !== undefined) return dflt;
    throw bad(`${name} is an integer`);
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${name} is an integer from ${min} to ${max}`);
  return v;
}

/** A proto error as the service's own answer. */
function refused(e: unknown, what: string): ServiceError {
  if (e instanceof errors.SignatureError) return new ServiceError("bad_signature", `the ${what} does not verify`);
  if (e instanceof errors.ProtocolError) return new ServiceError("bad_document", `the ${what} is not valid: ${e.detail}`);
  return e as ServiceError;
}

/** `"v." + base64url(first 16 bytes of SHA-256(the document's payload string as ASCII))`. */
export async function versionId(doc: { payload: string }): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b64.utf8(doc.payload)));
  return "v." + b64.encode(h.subarray(0, 16));
}


// --- space-key ---------------------------------------------------------------------------------

export interface KeyDoc {
  doc: docs.Doc;
  space: string;
  epoch: number;
  member: string;
  memberKid: string;
}

/** A space-key document, signed by the creator's CURRENT signing key (their directory entry), granter = creator.
 * `space` and `epoch` are the caller's to compare with what the space needs. */
export async function checkKeyDoc(ctx: Ctx, raw: unknown, creator: string): Promise<KeyDoc> {
  let doc: docs.Doc;
  let p: Obj;
  try {
    doc = docs.shape(raw);
    if (doc.type !== "space-key") throw new errors.DocumentError("expected a space-key document");
    if (!Array.isArray(doc.sigs) || doc.sigs.length !== 1) throw new errors.SignatureError("a space key carries exactly one signature");
    const entry = await ctx.directory(creator);
    if (!entry) throw new ServiceError("bad_signature", "the granter is not a member of this hub");
    p = await docs.verifyDocument(doc, [entry.signKey], { expectedType: "space-key", required: [entry.signKey.kid] });
    if (p.granter_kid !== entry.signKey.kid) throw new errors.SignatureError("granter_kid is not the signing key");
  } catch (e) {
    throw refused(e, "space key");
  }
  if (typeof p.space !== "string" || !SPACE_ID.test(p.space)) throw new ServiceError("bad_document", "the space key names no valid space");
  if (!Number.isInteger(p.epoch) || p.epoch < 1) throw new ServiceError("bad_document", "the space key's epoch is an integer from 1");
  if (typeof p.member !== "string" || typeof p.granter !== "string") throw new ServiceError("bad_document", "the space key names no member or granter");
  let member: string;
  let granter: string;
  try {
    member = address(p.member);
    granter = address(p.granter);
  } catch {
    throw new ServiceError("bad_document", "the space key's addresses are not addresses");
  }
  if (granter !== creator) throw new ServiceError("bad_document", "the space key is not granted by the space's creator");
  if (typeof p.member_kid !== "string" || !/^k1\.[A-Za-z0-9_-]{22}$/.test(p.member_kid)) throw new ServiceError("bad_document", "member_kid is a key id");
  const s = p.sealed;
  if (!docs.isObject(s) || s.alg !== seal.ALG || typeof s.enc !== "string" || typeof s.ct !== "string") {
    throw new ServiceError("bad_document", "sealed is not an HPKE seal");
  }
  return { doc, space: p.space, epoch: p.epoch, member, memberKid: p.member_kid };
}

// --- space-version -----------------------------------------------------------------------------

export interface VersionDoc {
  doc: docs.Doc;
  id: string;
  space: string;
  seq: number;
  parent: string | null;
  epoch: number;
  author: string;
  blobs: string[];
}

/** A space-version document signed by `author`'s current signing key. Whether the author is a member and the chain is right
 * is the Durable Object's to decide. */
export async function checkVersionDoc(ctx: Ctx, raw: unknown, author: string): Promise<VersionDoc> {
  let doc: docs.Doc;
  let p: Obj;
  try {
    doc = docs.shape(raw);
    if (doc.type !== "space-version") throw new errors.DocumentError("expected a space-version document");
    if (!Array.isArray(doc.sigs) || doc.sigs.length !== 1) throw new errors.SignatureError("a space version carries exactly one signature");
    const entry = await ctx.directory(author);
    if (!entry) throw new ServiceError("bad_signature", "the author is not a member of this hub");
    p = await docs.verifyDocument(doc, [entry.signKey], { expectedType: "space-version", required: [entry.signKey.kid] });
  } catch (e) {
    throw refused(e, "version");
  }
  const need = (ok: boolean, what: string) => {
    if (!ok) throw new ServiceError("bad_document", `the version's ${what} is not valid`);
  };
  need(typeof p.space === "string" && SPACE_ID.test(p.space), "space");
  need(Number.isInteger(p.seq) && p.seq >= 1, "seq");
  need(p.seq === 1 ? p.parent === null : typeof p.parent === "string" && VERSION_ID.test(p.parent), "parent");
  need(Number.isInteger(p.epoch) && p.epoch >= 1, "epoch");
  need(typeof p.author === "string" && address(p.author) === author, "author");
  need(Array.isArray(p.blobs), "blobs");
  need(p.blobs.every((b: unknown) => typeof b === "string" && BLOB_ID.test(b)), "blobs");
  need(p.blobs.every((b: string, i: number) => i === 0 || p.blobs[i - 1] < b), "blobs (sorted ascending, distinct)");
  need(p.blobs.every((b: string) => Number(BLOB_ID.exec(b)![1]) <= p.epoch), "blobs (an epoch after the version's)");
  need(docs.isObject(p.meta) && typeof p.meta.nonce === "string" && typeof p.meta.ct === "string", "meta");
  try {
    need(b64.decode(p.meta.nonce).length === 12, "meta.nonce");
    b64.decode(p.meta.ct);
  } catch {
    need(false, "meta");
  }
  return { doc, id: await versionId(doc), space: p.space, seq: p.seq, parent: p.parent, epoch: p.epoch, author, blobs: p.blobs };
}

