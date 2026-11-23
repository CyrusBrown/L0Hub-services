// The board: a hub service of kind `board` (protocol/board.md in the l0wagent repo). See README.md.
import { createService } from "@l0wservices/core";
import { handleAdmin, isAdminPath } from "./admin";
import type { BoardEnv } from "./config";
import { discussions } from "./discuss";
import { cron } from "./jobs";
import { BOARD_MIGRATIONS } from "./migrations";
import { moderation } from "./mod";
import { reading } from "./reading";
import { writing } from "./writing";

export type { BoardEnv } from "./config";

export const board = createService<BoardEnv>({
  name: "board",
  kind: "board",
  roles: ["moderator"],
  migrations: BOARD_MIGRATIONS,
  methods: { ...reading, ...writing, ...discussions, ...moderation },
  onCron: cron,
});

export default {
  async fetch(request: Request, env: BoardEnv, ctx: ExecutionContext): Promise<Response> {
    if (isAdminPath(new URL(request.url))) return handleAdmin(request, env);
    return board.fetch(request, env, ctx);
  },
  scheduled: board.scheduled,
};
