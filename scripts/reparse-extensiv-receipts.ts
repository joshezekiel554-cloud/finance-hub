/**
 * reparse-extensiv-receipts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Re-runs classifyExtensivEmail against every existing extensiv_receipts
 * row (joined back to its original email_log body) and updates
 * parsedItemsJson when the new parser extracts more items than the
 * previously-stored value. Used to retro-fix receipts whose body was
 * HTML-only and the older line-regex couldn't see <td> cells.
 *
 *   npx tsx scripts/reparse-extensiv-receipts.ts            # live
 *   npx tsx scripts/reparse-extensiv-receipts.ts --dry-run  # preview
 *
 * Idempotent. Only touches rows where the new parsed items differ.
 */

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { emailLog } from "../src/db/schema/crm.js";
import { extensivReceipts } from "../src/db/schema/returns.js";
import { classifyExtensivEmail } from "../src/modules/returns/extensiv-receipt-classifier.js";

function parseArgs(): { dryRun: boolean } {
  return { dryRun: process.argv.includes("--dry-run") };
}

async function main() {
  const { dryRun } = parseArgs();
  console.log("=== Re-parse extensiv_receipts ===");
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "LIVE"}\n`);

  const rows = await db
    .select({
      id: extensivReceipts.id,
      gmailMessageId: extensivReceipts.gmailMessageId,
      txNumber: extensivReceipts.txNumber,
      parsedItemsJson: extensivReceipts.parsedItemsJson,
      // Pull the source email so we can re-classify with the latest parser.
      fromAddress: emailLog.fromAddress,
      subject: emailLog.subject,
      body: emailLog.body,
    })
    .from(extensivReceipts)
    .leftJoin(
      emailLog,
      eq(extensivReceipts.gmailMessageId, emailLog.gmailMessageId),
    );

  console.log(`Receipts to re-evaluate: ${rows.length}\n`);

  let updated = 0;
  let unchanged = 0;
  let missingEmail = 0;

  for (const r of rows) {
    if (!r.body) {
      missingEmail++;
      continue;
    }
    const result = classifyExtensivEmail({
      from: r.fromAddress ?? "",
      subject: r.subject ?? "",
      body: r.body,
    });
    const newItems = result.parsedItems ?? [];
    const oldItems = Array.isArray(r.parsedItemsJson)
      ? (r.parsedItemsJson as Array<{ sku?: string; quantity?: number }>)
      : [];

    // Compare on the (sku, quantity) pairs sorted to avoid order
    // sensitivity. If they match exactly, skip the write.
    const norm = (
      arr: Array<{ sku?: string | undefined; quantity?: number | undefined }>,
    ) =>
      arr
        .map((p) => `${p.sku ?? ""}|${p.quantity ?? 0}`)
        .sort()
        .join(",");

    if (norm(newItems) === norm(oldItems)) {
      unchanged++;
      continue;
    }

    console.log(
      `  ✓ ${r.id} tx#${r.txNumber ?? "—"}: ${oldItems.length} → ${newItems.length} items`,
    );

    if (!dryRun) {
      await db
        .update(extensivReceipts)
        .set({ parsedItemsJson: newItems })
        .where(eq(extensivReceipts.id, r.id));
    }
    updated++;
  }

  console.log("\n=== Summary ===");
  console.log(`  ${dryRun ? "[DRY-RUN] " : ""}Items updated: ${updated}`);
  console.log(`  Unchanged                 : ${unchanged}`);
  console.log(`  Missing source email      : ${missingEmail}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
