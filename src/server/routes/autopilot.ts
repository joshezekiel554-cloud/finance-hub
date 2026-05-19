// Autopilot routes. v0 surfaces:
//   POST /api/autopilot/scan                   — manually trigger a scan
//   GET  /api/autopilot/proposals              — list proposals (Task 7)
//   GET  /api/autopilot/proposals/:id          — single proposal (Task 7)
//   POST /api/autopilot/proposals/draft        — bulk draft via AI (Task 6)
//   POST /api/autopilot/proposals/:id/approve  — fire underlying action (Task 7)
//   POST /api/autopilot/proposals/:id/dismiss  — soft skip (Task 7)
//   POST /api/autopilot/proposals/:id/snooze   — silence for N hours (Task 7)

import type { FastifyPluginAsync } from "fastify";
import {
  AUTOPILOT_SCAN_JOB,
  getQueues,
} from "../../jobs/queues.js";
import type { AutopilotScanJobData } from "../../jobs/definitions/autopilot-scan.js";
import { requireAuth } from "../lib/auth.js";

const autopilotRoute: FastifyPluginAsync = async (app) => {
  app.post("/scan", async (req, reply) => {
    const user = await requireAuth(req);
    const queues = getQueues();
    const job = await queues.autopilotScan.add(AUTOPILOT_SCAN_JOB, {
      trigger: "manual",
      triggeredByUserId: user.id,
    } as AutopilotScanJobData);
    return reply.send({ jobId: job.id });
  });
};

export default autopilotRoute;
