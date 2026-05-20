import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { runCorrectionsDistill } from "../../modules/ai-agent/corrections.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "jobs.ai-corrections-distill" });

export type AiCorrectionsDistillJobData = { trigger: "cron" };
export type AiCorrectionsDistillJobResult = {
  ran: boolean;
  proposed?: number;
  reason?: string;
};

// Weekly learn-from-edits distill. Gated by app_settings.ai_corrections_cron_enabled
// (default off) so the repeatable always exists but no-ops until enabled.
export async function aiCorrectionsDistillHandler(
  job: Job<AiCorrectionsDistillJobData>,
): Promise<AiCorrectionsDistillJobResult> {
  const jobLog = log.child({ jobId: job.id });
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "ai_corrections_cron_enabled"))
    .limit(1);
  if (rows[0]?.value !== "true") {
    jobLog.info({ stage: "skipped" }, "corrections cron disabled");
    return { ran: false, reason: "disabled" };
  }
  const result = await runCorrectionsDistill(null);
  jobLog.info({ proposed: result.proposed }, "corrections cron complete");
  return { ran: true, proposed: result.proposed, reason: result.reason };
}
