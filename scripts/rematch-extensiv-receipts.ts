/**
 * rematch-extensiv-receipts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Re-runs matchReceiptToRma against every no_match extensiv_receipts row
 * that's still pending review (not dismissed, not confirmed). Use after
 * widening matcher rules (e.g. accepting "approved" status) so previously
 * unmatchable rows pick up their RMA without manual work.
 *
 *   npx tsx scripts/rematch-extensiv-receipts.ts            # live
 *   npx tsx scripts/rematch-extensiv-receipts.ts --dry-run  # preview
 *
 * Idempotent. Only touches rows whose match would change (no_match → a
 * real match). Doesn't downgrade or re-evaluate already-matched rows.
 */

import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { extensivReceipts, rmas } from "../src/db/schema/returns.js";
import { matchReceiptToRma } from "../src/modules/returns/rma-matcher.js";

// Use a placeholder user for auto-confirms during the backfill. The audit
// trail shows the action came from this script via the activity log;
// no real operator was involved. The dev account is a safe choice that
// already exists in the user table.
const AUTO_CONFIRM_USER_ID = "dev-joshezekiel554-gmail-com";

function parseArgs(): { dryRun: boolean } {
  return { dryRun: process.argv.includes("--dry-run") };
}

async function main() {
  const { dryRun } = parseArgs();
  console.log("=== Re-match extensiv_receipts ===");
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "LIVE"}\n`);

  const rows = await db
    .select({
      id: extensivReceipts.id,
      txNumber: extensivReceipts.txNumber,
      refString: extensivReceipts.refString,
      parsedItemsJson: extensivReceipts.parsedItemsJson,
    })
    .from(extensivReceipts)
    .where(
      and(
        eq(extensivReceipts.matchKind, "no_match"),
        isNull(extensivReceipts.confirmedAt),
        isNull(extensivReceipts.dismissedAt),
      ),
    );

  console.log(`Pending no_match receipts to re-evaluate: ${rows.length}\n`);

  let upgraded = 0;
  let autoConfirmed = 0;
  let stillNoMatch = 0;

  for (const r of rows) {
    const parsedItems = Array.isArray(r.parsedItemsJson)
      ? (r.parsedItemsJson as Array<{ sku?: string; quantity?: number }>)
          .filter((p) => p && typeof p.sku === "string")
          .map((p) => ({ sku: p.sku as string }))
      : [];
    const match = await matchReceiptToRma({
      txNumber: r.txNumber ?? undefined,
      refString: r.refString ?? undefined,
      parsedItems,
    });
    if (match.kind === "no_match") {
      stillNoMatch++;
      continue;
    }
    const matchConfidence =
      match.kind === "fuzzy_customer_sku"
        ? String(match.confidence.toFixed(2))
        : "1.00";

    // Look up the linked RMA's status. When it's already "completed", the
    // receipt is purely audit — auto-confirm it in the same UPDATE so it
    // doesn't sit in the pending queue forever.
    const rmaRows = await db
      .select({ status: rmas.status })
      .from(rmas)
      .where(eq(rmas.id, match.rmaId))
      .limit(1);
    const linkedStatus = rmaRows[0]?.status ?? null;
    const shouldAutoConfirm = linkedStatus === "completed";

    console.log(
      `  ✓ ${r.id} → ${match.kind} (rma ${match.rmaId}, ${linkedStatus})` +
        (r.txNumber ? ` tx#${r.txNumber}` : "") +
        (shouldAutoConfirm ? "  [auto-confirmed: CM already issued]" : ""),
    );
    if (!dryRun) {
      await db
        .update(extensivReceipts)
        .set({
          rmaId: match.rmaId,
          matchKind: match.kind,
          matchConfidence,
          ...(shouldAutoConfirm
            ? {
                confirmedAt: new Date(),
                confirmedByUserId: AUTO_CONFIRM_USER_ID,
              }
            : {}),
        })
        .where(eq(extensivReceipts.id, r.id));
    }
    upgraded++;
    if (shouldAutoConfirm) autoConfirmed++;
  }

  console.log("\n=== Summary ===");
  console.log(`  ${dryRun ? "[DRY-RUN] " : ""}Upgraded to a real match: ${upgraded}`);
  console.log(`     of which auto-confirmed (linked RMA is completed): ${autoConfirmed}`);
  console.log(`  Still no_match (truly unrecognised): ${stillNoMatch}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
