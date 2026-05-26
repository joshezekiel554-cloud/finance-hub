import type { Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { createLogger } from "../../lib/logger.js";
import { runScan } from "../../modules/ai-agent/scanner.js";

const log = createLogger({ component: "jobs.autopilot-scan" });

export type AutopilotScanJobData = {
  trigger: "cron" | "manual";
  triggeredByUserId?: string;
};

export type AutopilotScanJobResult =
  | {
      scanId: string;
      totalCandidates: number;
      proposalsGenerated: number;
    }
  | { ran: false; reason: string };

export async function autopilotScanHandler(
  job: Job<AutopilotScanJobData>,
): Promise<AutopilotScanJobResult> {
  // Manual triggers bypass the gate — "Run autopilot now" should always run.
  if (job.data.trigger === "cron") {
    const rows = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "autopilot_scan_cron_enabled"))
      .limit(1);
    if (rows[0]?.value !== "true") {
      log.info(
        { jobId: job.id, stage: "skipped" },
        "autopilot scan cron disabled",
      );
      return { ran: false, reason: "disabled" };
    }
  }
  log.info(
    { jobId: job.id, trigger: job.data.trigger },
    "autopilot scan starting",
  );
  return await runScan(job.data.trigger, job.data.triggeredByUserId);
}
