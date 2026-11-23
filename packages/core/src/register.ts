// Registering a service with a hub: PUT <hub>/v0/admin/services/<name> (hub/README.md "Hub services"), with the operator's
// admin token. The body is the service's facts and its signed self document (address, keys, hostnames).
import { b64, docs, errors, keys, payloads as P } from "@l0w/proto";
import { keysFromSeed, type ServiceKeys } from "./keys";
import type { Doc, Obj } from "./types";

export interface RegisterSpec {
  /** SERVICE_SEED: base64url of 32 bytes. */
  seed: string;
  name: string;
  kind: string;
  title: string;
  description?: string;
  docs?: string;
  roles: string[];
  extension?: { git: string; commit: string; path: string };
  default: "on" | "off";
  /** The self document's seq. Default: one more than the directory's current entry for this name, else 0. */
  seq?: number;
}

/** The hostnames the hub would assign to `name`, worked out from the capabilities' example (`hostnames.example`:
 * `{name, instance, files}`): the example name, where it first stands as a whole part of a label, becomes `name`
 * (capabilities.md). The hub checks the result against its own patterns, so a wrong guess is refused, not published. */
export function hostnamesFromCapabilities(capabilities: Obj, name: string): { instance: string; files: string } {
  const ex = capabilities.hostnames?.example;
  if (!docs.isObject(ex) || typeof ex.instance !== "string" || typeof ex.files !== "string") {
    throw new Error("the hub's capabilities carry no hostnames.example to take the pattern from");
  }
  const example = typeof ex.name === "string" && ex.name ? ex.name : "username";
  const esc = example.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[.:-])${esc}(?=$|[.:-])`);
  const fill = (h: string): string => {
    const out = h.replace(re, (_m, pre: string) => pre + name);
    if (out === h) throw new Error(`cannot find the example name ${JSON.stringify(example)} in ${JSON.stringify(h)}`);
    return out;
  };
  return { instance: fill(ex.instance), files: fill(ex.files) };
}

/** The signed self document: the service's three public keys and its hostnames, signed by its signing key. */
export async function buildSelfDocument(
  k: ServiceKeys,
  address: string,
  hostnames: { instance: string; files: string },
  seq: number,
  iat?: string | number,
): Promise<Doc> {
  return docs.signDocument("self", P.buildSelf(address, seq, [k.sign.key, k.seal.key, k.recover.key], hostnames, { iat }), [k.sign]);
}

/** The PUT body for one service. */
export async function buildRegistration(spec: RegisterSpec, capabilities: Obj, seq: number): Promise<{ address: string; body: Obj }> {
  const address = `${spec.name}@${String(capabilities.domain).toLowerCase()}`;
  const k = await keysFromSeed(spec.seed);
  const hostnames = hostnamesFromCapabilities(capabilities, spec.name);
  const body: Obj = {
    kind: spec.kind,
    title: spec.title,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.docs ? { docs: spec.docs } : {}),
    roles: spec.roles,
    ...(spec.extension ? { extension: spec.extension } : {}),
    default: spec.default,
    self: await buildSelfDocument(k, address, hostnames, seq),
  };
  // the same checks the hub makes of the service document, so a mistake shows here
  P.validateService(P.buildService(address, spec.kind, spec.roles, { title: spec.title, description: spec.description, docs: spec.docs, extension: spec.extension, default: spec.default }), String(capabilities.domain));
  return { address, body };
}

export interface RegisterResult {
  address: string;
  status: number;
  response: unknown;
  body: Obj;
}

/** Fetch the hub's capabilities, build the registration and PUT it. `dryRun` stops before the PUT (status 0). */
export async function registerWithHub(opts: {
  hub: string;
  adminToken: string;
  spec: RegisterSpec;
  dryRun?: boolean;
  fetch?: typeof fetch;
}): Promise<RegisterResult> {
  const hub = opts.hub.replace(/\/+$/, "");
  const f = opts.fetch ?? fetch;
  const capRes = await f(`${hub}/.well-known/l0wagent/hub`);
  if (capRes.status !== 200) throw new Error(`the hub's capabilities answered ${capRes.status}`);
  let caps: Obj;
  try {
    caps = await P.verifyHub(await capRes.json());
  } catch (e) {
    throw new Error(`the hub's capabilities do not verify: ${e instanceof errors.ProtocolError ? e.detail : (e as Error).message}`);
  }
  let seq = opts.spec.seq;
  if (seq === undefined) {
    seq = 0;
    const cur = await f(`${hub}/.well-known/l0wagent/members/${encodeURIComponent(opts.spec.name)}`);
    if (cur.status === 200) {
      try {
        // not verified: only the number is used, and the hub refuses a PUT whose seq goes down
        seq = (JSON.parse(b64.fromUtf8(b64.decode(((await cur.json()) as Doc).payload))).seq as number) + 1;
      } catch {
        seq = 0;
      }
    } else await cur.body?.cancel();
  }
  const { address, body } = await buildRegistration(opts.spec, caps, seq);
  if (opts.dryRun) return { address, status: 0, response: null, body };
  const res = await f(`${hub}/v0/admin/services/${encodeURIComponent(opts.spec.name)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.adminToken}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let response: unknown = text;
  try {
    response = JSON.parse(text);
  } catch {
    /* keep the text */
  }
  if (res.status !== 200 && res.status !== 201) throw new Error(`the hub refused the registration: ${res.status} ${text}`);
  return { address, status: res.status, response, body };
}

