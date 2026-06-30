// Time Clock routes (registered at /api by index.ts).
//
//   POST /api/time-clock/in     requireAuth + clock-enabled → 200 status | 409 already_open
//   POST /api/time-clock/out    requireAuth + clock-enabled → 200 status | 409 not_open
//   GET  /api/time-clock/status requireAuth                 → getStatus payload
//
// in/out are gated to the `time_clock_user_ids` allow-list (403 otherwise);
// status returns enabled:false for non-allow-list users so the card hides.

import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../lib/auth.js";
import {
  clockIn,
  clockOut,
  getStatus,
  isClockEnabled,
} from "../../modules/time-clock/service.js";

const timeClockRoute: FastifyPluginAsync = async (app) => {
  // --- POST /time-clock/in ------------------------------------------------
  app.post("/time-clock/in", async (req, reply) => {
    const user = await requireAuth(req);
    if (!(await isClockEnabled(user.id))) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const result = await clockIn(user.id);
    if (!result.ok) {
      return reply.code(409).send({ error: result.reason });
    }
    return reply.send(await getStatus(user.id));
  });

  // --- POST /time-clock/out -----------------------------------------------
  app.post("/time-clock/out", async (req, reply) => {
    const user = await requireAuth(req);
    if (!(await isClockEnabled(user.id))) {
      return reply.code(403).send({ error: "Forbidden" });
    }
    const result = await clockOut(user.id);
    if (!result.ok) {
      return reply.code(409).send({ error: result.reason });
    }
    return reply.send(await getStatus(user.id));
  });

  // --- GET /time-clock/status ---------------------------------------------
  app.get("/time-clock/status", async (req, reply) => {
    const user = await requireAuth(req);
    return reply.send(await getStatus(user.id));
  });
};

export default timeClockRoute;
