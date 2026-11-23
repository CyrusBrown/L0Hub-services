// TypeScript <-> Python: the service's welcome and a role grant, opened and verified by the Python reference library.
// Skipped when `uv` is missing or the l0wagent checkout is not next to this repo.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { b64 } from "@l0w/proto";
import { describe, expect, it } from "vitest";
import { rig } from "./helpers";

const PY_DIR = join(import.meta.dirname, "..", "..", "..", "..", "..", "..", "l0wagent", "protocol", "py");
const have = (() => {
  if (!existsSync(PY_DIR)) return false;
  const r = spawnSync("uv", ["run", "python", "-c", "import l0wproto"], { cwd: PY_DIR, encoding: "utf8", timeout: 120_000 });
  return !r.error && r.status === 0;
})();

const PY_OPEN = `
import json, sys
from l0wproto import keys, messages as M, payloads as P
i = json.load(sys.stdin)
seed = bytes.fromhex(i["seal_seed"])
sk = keys.from_seed(seed, "seal", i["created"])
svc = keys.Key.from_dict(i["service_key"])
p, body = M.open_envelope(i["doc"], my_address=i["address"], my_seal_keys={sk.kid: seed}, sender_sign_key=svc)
tok = M.verify_delivery_token(body["token"], svc, i["holder_kid"])
tok_in_env = M.verify_delivery_token(p["token"], keys.Key.from_dict(i["holder_key"]), i["service_kid"])
grants = [P.verify_role_grant(g, svc, service=i["service"], holder=i["address"], holder_kid=i["holder_kid"]) for g in body["roles"]]
json.dump({"kind": p["kind"], "from": p["from"], "seq": p["seq"], "token_holder": tok["holder"], "token_in_env": tok_in_env["issuer"],
           "roles": [g["role"] for g in grants]}, sys.stdout)
`;

describe.skipIf(!have)("Python reference library opens what this service sends", () => {
  it("a service-welcome opens, its token and role grant verify", async () => {
    const r = await rig();
    await r.connect(r.mara);
    const doc = r.mara.received[0];
    const input = {
      doc,
      address: r.mara.address,
      seal_seed: b64.toHex(r.mara.seal.private),
      created: r.mara.seal.key.created,
      service_key: r.ref.sign.toJSON(),
      holder_kid: r.mara.sign.kid,
      holder_key: r.mara.sign.key.toJSON(),
      service_kid: r.ref.sign.kid,
      service: r.ref.address,
    };
    const out = spawnSync("uv", ["run", "python", "-c", PY_OPEN], { cwd: PY_DIR, input: JSON.stringify(input), encoding: "utf8", timeout: 120_000 });
    if (out.status !== 0) throw new Error(`python failed: ${out.stderr}`);
    expect(JSON.parse(out.stdout)).toEqual({
      kind: "service-welcome",
      from: "testsvc@hub.example",
      seq: 1,
      token_holder: "mara@hub.example",
      token_in_env: "mara@hub.example",
      roles: ["tester"],
    });
  }, 180_000);
});
