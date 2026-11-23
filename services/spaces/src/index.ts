// The spaces service (protocol/spaces.md): `export default` the Worker, and the Durable Object class `Space`.
import { createService } from "@l0wservices/core";
import { cron } from "./cron";
import type { SpacesEnv } from "./env";
import { methods } from "./methods";
import { SPACES_MIGRATIONS } from "./migrations";
import { isTransfer, transfer } from "./transfer";

export { Space } from "./durable";
export type { SpacesEnv } from "./env";

const service = createService<SpacesEnv>({
  name: "spaces",
  kind: "spaces",
  roles: [],
  migrations: SPACES_MIGRATIONS,
  methods,
  onCron: cron,
});

export default {
  async fetch(request: Request, env: SpacesEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isTransfer(url)) {
      // the tables are made by the framework's first request; a transfer may be the first one after a deploy
      return transfer(request, env);
    }
    return service.fetch(request, env, ctx);
  },
  scheduled: service.scheduled,
} satisfies ExportedHandler<SpacesEnv>;
