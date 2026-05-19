import { desc, eq } from "drizzle-orm";
import { db } from "../../../db/index.js";
import { syncRuns, SYNC_KINDS } from "../../../db/schema/audit.js";

export type Candidate = {
  entityType: "cron_job";
  entityId: string;
  summary: Record<string, unknown>;
};

type SyncRow = {
  id: string;
  status: "running" | "ok" | "failed" | "partial";
  startedAt: Date;
  errorMessage: string | null;
};

function checkConsecutiveFailures(rows: SyncRow[]): boolean {
  const newest = rows.at(0);
  const second = rows.at(1);
  const third = rows.at(2);

  if (!newest || !second) return false;
  if (newest.status === "running") return false;
  if (newest.status !== "failed" || second.status !== "failed") return false;
  if (third !== undefined && third.status !== "ok") return false;
  return true;
}

export async function findCandidates(): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  for (const kind of SYNC_KINDS) {
    const rows = await db
      .select({
        id: syncRuns.id,
        status: syncRuns.status,
        startedAt: syncRuns.startedAt,
        errorMessage: syncRuns.errorMessage,
      })
      .from(syncRuns)
      .where(eq(syncRuns.kind, kind))
      .orderBy(desc(syncRuns.startedAt))
      .limit(3);

    if (!checkConsecutiveFailures(rows)) continue;

    const newest = rows.at(0)!;
    candidates.push({
      entityType: "cron_job",
      entityId: kind,
      summary: {
        jobKind: kind,
        lastFailureAt: newest.startedAt.toISOString(),
        lastErrorExcerpt: (newest.errorMessage ?? "").slice(0, 500),
      },
    });
  }

  return candidates;
}

export async function isStillEligible(entityId: string): Promise<boolean> {
  const rows = await db
    .select({
      status: syncRuns.status,
      startedAt: syncRuns.startedAt,
    })
    .from(syncRuns)
    .where(eq(syncRuns.kind, entityId as (typeof SYNC_KINDS)[number]))
    .orderBy(desc(syncRuns.startedAt))
    .limit(3);

  return checkConsecutiveFailures(
    rows.map((r) => ({ id: "", errorMessage: null, ...r })),
  );
}
