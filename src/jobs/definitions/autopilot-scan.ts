import type { Job } from "bullmq";
import { createLogger } from "../../lib/logger.js";
import { runScan } from "../../modules/ai-agent/scanner.js";

const log = createLogger({ component: "jobs.autopilot-scan" });

export type AutopilotScanJobData = {
  trigger: "cron" | "manual";
  triggeredByUserId?: string;
};

export type AutopilotScanJobResult = {
  scanId: string;
  totalCandidates: number;
  proposalsGenerated: number;
};

export async function autopilotScanHandler(
  job: Job<AutopilotScanJobData>,
): Promise<AutopilotScanJobResult> {
  log.info(
    { jobId: job.id, trigger: job.data.trigger },
    "autopilot scan starting",
  );
  return await runScan(job.data.trigger, job.data.triggeredByUserId);
}
