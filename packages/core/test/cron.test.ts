import { describe, expect, it, vi } from "vitest";
import { createService, type ServiceEnv } from "../src";
import { SERVICE_NAME, rig } from "./helpers";

describe("onCron", () => {
  it("runs on every cron run with the service's own address, and can emit events that go out in the same run", async () => {
    const seen: Array<{ from: string; roles: string[] }> = [];
    const svc = createService<ServiceEnv>({
      name: SERVICE_NAME,
      kind: "custom",
      methods: {},
      onCron: async (ctx) => {
        seen.push({ from: ctx.from, roles: ctx.roles });
        await ctx.emit("mara@hub.example", "tick", { n: seen.length });
      },
    });
    const r = await rig({}, svc as never);
    await r.connect(r.mara);
    await r.cron();
    await r.cron();
    expect(seen).toEqual([
      { from: `${SERVICE_NAME}@hub.example`, roles: [] },
      { from: `${SERVICE_NAME}@hub.example`, roles: [] },
    ]);
    const ev = (await r.mara.inbox(r.ref, "service-event")).map((e) => e.body);
    expect(ev).toEqual([
      { event: "tick", data: { n: 1 } },
      { event: "tick", data: { n: 2 } },
    ]);
  });

  it("an error in onCron is logged and doesn't stop the outbox", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const svc = createService<ServiceEnv>({ name: SERVICE_NAME, kind: "custom", methods: {}, onCron: () => Promise.reject(new Error("boom")) });
    const r = await rig({}, svc as never);
    await r.connect(r.mara);
    await r.cron();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
