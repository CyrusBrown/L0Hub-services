// POST /api/peer/v0/inbox: the receiving checks of messages.md, in its order, stopping at the first failure.
import { b64, consts, docs, errors, messages, payloads as P, seal, times } from "@l0w/proto";
import type { Entry } from "./hub";
import { rotatedFrom } from "./hub";
import { HubUnavailable } from "./errors";
import type { Runtime } from "./runtime";
import type { Obj, ServiceEnv } from "./types";

/** An answer that is an error. */
export class Refuse extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail = "",
    readonly headers: Record<string, string> = {},
  ) {
    super(detail || code);
  }
}

const STATUS: Record<string, number> = {
  not_here: 404,
  bad_signature: 401,
  bad_seal: 400,
  bad_body: 400,
  bad_document: 400,
  bad_encoding: 400,
  unsupported_version: 400,
  unknown_kind: 422,
  too_large: 413,
};

/** A protocol error as an answer (a signature failure never says which check failed). */
export function refuseFrom(e: unknown): Refuse {
  if (e instanceof Refuse) return e;
  if (e instanceof HubUnavailable) return new Refuse(503, "unavailable", "the hub could not be reached; try again later", { "retry-after": "30" });
  if (e instanceof errors.ProtocolError) {
    return new Refuse(STATUS[e.code] ?? 400, e.code, e.code === "bad_signature" ? "" : e.detail);
  }
  throw e;
}

export interface Received {
  payload: Obj;
  body: Obj;
  from: string;
  entry: Entry;
}

/** The kinds this service handles. Every other kind is `422 unknown_kind`. */
export const HANDLED = ["service-hello", "service-bye", "service-call"];

async function readLimited(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > consts.MAX_ENVELOPE) throw new Refuse(413, "too_large", "envelope is over 16 MiB");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > consts.MAX_ENVELOPE) {
        await reader.cancel();
        throw new Refuse(413, "too_large", "envelope is over 16 MiB");
      }
      chunks.push(value);
    }
  }
  try {
    return b64.fromUtf8(b64.concat(...chunks));
  } catch {
    throw new Refuse(400, "bad_document", "body is not UTF-8");
  }
}

/** The payload of an envelope document, decoded and nothing else checked (null if it is not decodable). */
function peek(doc: unknown): Obj | null {
  try {
    const o = JSON.parse(b64.fromUtf8(b64.decode((doc as Obj).payload)));
    return docs.isObject(o) ? o : null;
  } catch {
    return null;
  }
}

/** Steps 1 to 6. Returns null for a duplicate (the caller answers `200 {"duplicate": true}`). */
export async function receive<E extends ServiceEnv>(rt: Runtime<E>, request: Request): Promise<Received | null> {
  const { cfg, keys, store, hub } = rt;
  const now = rt.now();

  // 1. size (rate limits are the hub's and Cloudflare's; see README)
  const text = await readLimited(request);

  // 2. parse; to is this service
  let doc: docs.Doc;
  let p: Obj;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Refuse(400, "bad_document", "body is not JSON");
  }
  try {
    p = messages.envelopePayload(doc);
  } catch (e) {
    // the library's shape rules call a missing token a bad document; messages.md step 3 makes it 403 no_token
    const raw = peek(doc);
    if (raw && typeof raw.kind === "string" && !P.TOKENLESS_KINDS.includes(raw.kind) && !("token" in raw)) {
      const to = (() => {
        try {
          return P.splitAddress(raw.to).join("@");
        } catch {
          return null;
        }
      })();
      if (to === cfg.address) throw new Refuse(403, "no_token", "no token");
      if (to !== null) throw new Refuse(404, "not_here", "not this address");
    }
    throw refuseFrom(e);
  }
  const [toName, toDomain] = P.splitAddress(p.to);
  if (`${toName}@${toDomain}` !== cfg.address) throw new Refuse(404, "not_here", "not this address");
  const [fromName, fromDomain] = P.splitAddress(p.from);
  const from = `${fromName}@${fromDomain}`;
  const hello = p.kind === "service-hello";

  // 3. the token (a hello carries none and is for members of this hub only)
  const st: { entry: Entry | null; fresh: boolean } = { entry: null, fresh: false };
  const load = async (refresh = false): Promise<Entry | null> => {
    st.entry = await hub.entry(from, { refresh });
    st.fresh = refresh || st.fresh;
    return st.entry;
  };
  try {
    if (hello) {
      if (fromDomain !== cfg.domain || !(await load())) throw new Refuse(403, "not_member", "only members of this hub may use this service");
    } else {
      const noToken = new Refuse(403, "no_token", "no token");
      let tid: string;
      try {
        tid = P.validateTokenDocument(p.token).id;
      } catch {
        throw noToken;
      }
      const rec = await store.issuedToken(tid);
      if (!rec || rec.revokedAt !== null || rec.holder !== from) throw noToken;
      try {
        await messages.verifyDeliveryToken(p.token, keys.sign.key, rec.holderKid, now);
      } catch {
        throw noToken;
      }
      if (!(await load())) throw noToken;
      // issued to this key, or to a key that rotated into it
      if (rec.holderKid !== p.from_kid && !rotatedFrom((st.entry as Entry).history, rec.holderKid, p.from_kid)) {
        if (st.fresh || !(await load(true)) || !rotatedFrom((st.entry as Entry).history, rec.holderKid, p.from_kid)) throw noToken;
      }
    }

    // 4. the signature, against the sender's current key (a directory entry up to five minutes old; refetched once for an unknown kid)
    if ((st.entry as Entry).signKey.kid !== p.from_kid && (st.fresh || !(await load(true)) || (st.entry as Entry).signKey.kid !== p.from_kid)) {
      throw new Refuse(401, "bad_signature");
    }
    const e = st.entry as Entry;
    try {
      await docs.verifyDocument(doc, [e.signKey], { expectedType: "envelope", required: [e.signKey.kid], now });
    } catch (err) {
      throw refuseFrom(err);
    }

    // 5. iat window, the kind, duplicate ids
    const iat = times.parseTime(p.iat);
    if (iat > now + consts.MAX_SKEW) throw new Refuse(400, "bad_document", "iat is in the future");
    if (iat < now - consts.ENVELOPE_MAX_AGE) throw new Refuse(400, "bad_document", "envelope is older than 8 days");
    if (!HANDLED.includes(p.kind)) throw new Refuse(422, "unknown_kind", `this service does not take ${JSON.stringify(p.kind)}`);
    if (!(await store.markSeen(from, p.id, now))) return null;

    // 6. open and validate the body
    let body: Obj;
    try {
      if (p.to_kid !== keys.seal.kid) throw new errors.SealError("no key for to_kid");
      const plain = seal.openSealed(keys.seal.private, p.sealed, seal.sealInfo(p.from, p.from_kid, p.to, p.to_kid, p.id));
      try {
        body = JSON.parse(b64.fromUtf8(plain));
      } catch {
        throw new errors.ValidationError("body is not valid JSON", "bad_body");
      }
      P.validateBody(p.kind, body);
    } catch (err) {
      throw refuseFrom(err);
    }
    return { payload: p, body, from, entry: e };
  } catch (err) {
    throw refuseFrom(err);
  }
}
