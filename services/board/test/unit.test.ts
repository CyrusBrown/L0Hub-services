import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BOARD_MIGRATIONS } from "../src/migrations";
import { b64uSize, decodeCursor, encodeCursor, keyset, parseMentions, timeArg } from "../src/util";
import { limitsOf, rolesOf, isModerator, moderators, type BoardEnv } from "../src/config";

describe("migrations", () => {
  it("the generated migrations match migrations/*.sql", () => {
    const dir = join(import.meta.dirname, "..", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    expect(BOARD_MIGRATIONS).toEqual(files.map((f) => ({ name: f.replace(/\.sql$/, ""), sql: readFileSync(join(dir, f), "utf8") })));
    expect(files[0]).toMatch(/^0100_/); // after the framework's 0001
  });
});

describe("mentions", () => {
  it("@name is a member of this hub, @name@domain as written; mail addresses and repeats don't count", () => {
    const hub = "hub.example";
    expect(parseMentions("hi @Ola, and @kai-2.", hub)).toEqual(["ola@hub.example", "kai-2@hub.example"]);
    expect(parseMentions("(@pia) @pia @zed@other.example. me@pia.example", hub)).toEqual(["pia@hub.example", "zed@other.example"]);
    expect(parseMentions("@127@127.0.0.1:8770", "x")).toEqual(["127@127.0.0.1:8770"]);
    expect(parseMentions("no mention, an @ alone, @@x", hub)).toEqual([]);
    expect(parseMentions(Array.from({ length: 15 }, (_, i) => `@m${i}`).join(" "), hub)).toHaveLength(10);
  });
});

describe("helpers", () => {
  it("cursors round-trip and bad ones are bad_args", () => {
    expect(decodeCursor({ cursor: encodeCursor([1, 2]) }, 2)).toEqual([1, 2]);
    expect(decodeCursor({}, 2)).toBeUndefined();
    expect(() => decodeCursor({ cursor: encodeCursor([1]) }, 2)).toThrow();
    expect(() => decodeCursor({ cursor: "%%%" }, 1)).toThrow();
  });
  it("keyset builds a lexicographic comparison", () => {
    expect(keyset(["a", "b"], [5, 7], "<")).toEqual({ sql: "((a < ?) OR (a = ? AND b < ?))", args: [5, 5, 7] });
  });
  it("base64url sizes", () => {
    expect(b64uSize("")).toBe(0);
    expect(b64uSize("AAAA")).toBe(3);
    expect(b64uSize("AAA")).toBe(2);
    expect(b64uSize("AA")).toBe(1);
    expect(() => b64uSize("A")).toThrow();
    expect(() => b64uSize("AA==")).toThrow();
    expect(() => b64uSize("a+b/")).toThrow();
  });
  it("times", () => {
    expect(timeArg({ t: "2026-11-22T12:00:00Z" }, "t")).toBe(1795348800);
    expect(() => timeArg({ t: "yesterday" }, "t")).toThrow();
  });
  it("settings: defaults, overrides, roles from ROLES", () => {
    const env = { HUB_DOMAIN: "hub.example", ROLES: JSON.stringify({ moderator: ["mara", "ola@hub.example"], other: ["kai"] }), POSTS_PER_DAY: "9" } as unknown as BoardEnv;
    expect(limitsOf(env)).toEqual({ postsPerDay: 9, messagesPerDay: 10, filesPerDay: 20, heldFirstPosts: 2, maxWatches: 5, maxTopics: 0 });
    expect(rolesOf(env, "MARA@hub.example")).toEqual(["moderator"]);
    expect(rolesOf(env, "kai@hub.example")).toEqual(["other"]);
    expect(isModerator(env, "ola@hub.example")).toBe(true);
    expect(isModerator(env, "kai@hub.example")).toBe(false);
    expect(moderators(env).sort()).toEqual(["mara@hub.example", "ola@hub.example"]);
  });
});
