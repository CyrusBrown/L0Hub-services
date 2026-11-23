// Transfer tickets: the path of a blob URL. `<b64url(JSON [space, id, size, dir, exp, by, nonce])>.<b64url(HMAC-SHA256)>`.
// The HMAC covers everything in the ticket, so a ticket can't be changed; single use is recorded in D1 (tickets table).
import { b64 } from "@l0w/proto";

export interface Ticket {
  space: string;
  id: string;
  size: number;
  dir: "put" | "get";
  exp: number;
  by: string;
}

const PREFIX = "l0wspaces-ticket/1\n";

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", b64.utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function makeTicket(secret: string, t: Ticket): Promise<string> {
  const body = b64.encode(b64.utf8(JSON.stringify([t.space, t.id, t.size, t.dir, t.exp, t.by, b64.encode(crypto.getRandomValues(new Uint8Array(9)))])));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), b64.utf8(PREFIX + body)));
  return `${body}.${b64.encode(mac)}`;
}

/** The ticket and its MAC (which names it in the used-tickets table), or null when it is not one this service made. */
export async function openTicket(secret: string, token: string): Promise<{ ticket: Ticket; mac: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const mac = b64.decode(parts[1]);
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), mac, b64.utf8(PREFIX + parts[0])))) return null;
    const [space, id, size, dir, exp, by] = JSON.parse(b64.fromUtf8(b64.decode(parts[0])));
    if (typeof space !== "string" || typeof id !== "string" || !Number.isInteger(size) || (dir !== "put" && dir !== "get") || !Number.isInteger(exp) || typeof by !== "string") return null;
    return { ticket: { space, id, size, dir, exp, by }, mac: parts[1] };
  } catch {
    return null;
  }
}
