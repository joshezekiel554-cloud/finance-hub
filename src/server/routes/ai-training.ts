// AI-training routes.
//
//   POST /api/ai-training/voice-guide/regenerate — re-distill the voice
//     guide from templates + recent outbound emails (overwrites the
//     app_settings.ai_voice_guide row; the UI warns before calling).
//
// Mounting: registered in src/server/routes/index.ts at /api/ai-training.

import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../lib/auth.js";
import { runVoiceGuideSeed } from "../../modules/ai-agent/voice-seed.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.ai-training" });

const aiTrainingRoute: FastifyPluginAsync = async (app) => {
  app.post("/voice-guide/regenerate", async (req, reply) => {
    const user = await requireAuth(req);
    try {
      const { words } = await runVoiceGuideSeed(user.id);
      return reply.send({ ok: true, words });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err: msg }, "voice guide regenerate failed");
      return reply.code(500).send({ error: "regenerate failed", detail: msg });
    }
  });
};

export default aiTrainingRoute;
