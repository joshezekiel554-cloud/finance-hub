// Soft monthly budget ceiling (spec §11): never blocks — fires a
// notification when the month's Anthropic spend crosses 80% / 100% of
// app_settings.agent_monthly_budget_usd. Called fire-and-forget after
// agent turns; dedupe keyed per month+threshold so each fires once.

import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { aiInteractions } from "../../db/schema/audit.js";
import { users } from "../../db/schema/auth.js";
import { createLogger } from "../../lib/logger.js";
import { recordNotification } from "../notifications/index.js";
import { loadAppSettings } from "../statements/settings.js";

const log = createLogger({ component: "agent.budget" });

export async function getMonthSpendUsd(now = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(${aiInteractions.costUsd}), 0)` })
    .from(aiInteractions)
    .where(sql`${aiInteractions.occurredAt} >= ${monthStart}`);
  return Number(rows[0]?.total ?? 0);
}

export type BudgetStatus = {
  spentUsd: number;
  budgetUsd: number;
  pct: number;
};

export async function getBudgetStatus(now = new Date()): Promise<BudgetStatus> {
  const [spentUsd, settings] = await Promise.all([
    getMonthSpendUsd(now),
    loadAppSettings(),
  ]);
  const budgetUsd = Number(settings.agent_monthly_budget_usd) || 150;
  return {
    spentUsd,
    budgetUsd,
    pct: budgetUsd > 0 ? (spentUsd / budgetUsd) * 100 : 0,
  };
}

// Notify every team member once per month per threshold crossed.
// recordNotification's dedupeOnRefId makes repeat calls no-ops.
export async function checkBudgetAndNotify(now = new Date()): Promise<void> {
  try {
    const status = await getBudgetStatus(now);
    const month = now.toISOString().slice(0, 7);
    const thresholds: Array<{ pct: number; label: string }> = [
      { pct: 100, label: "100%" },
      { pct: 80, label: "80%" },
    ];
    const crossed = thresholds.find((t) => status.pct >= t.pct);
    if (!crossed) return;

    const team = await db.select({ id: users.id }).from(users);
    for (const member of team) {
      await recordNotification({
        userId: member.id,
        kind: "system",
        refType: "agent_budget",
        refId: `${month}:${crossed.pct}`,
        dedupeOnRefId: true,
        payload: {
          title: `AI spend has reached ${crossed.label} of the monthly budget`,
          body: `$${status.spentUsd.toFixed(2)} of $${status.budgetUsd.toFixed(2)} this month. The agent keeps working — adjust the budget in Settings if needed.`,
        },
      });
    }
  } catch (err) {
    log.warn({ err }, "budget check failed");
  }
}
