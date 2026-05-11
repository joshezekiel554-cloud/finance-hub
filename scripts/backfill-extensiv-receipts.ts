/**
 * backfill-extensiv-receipts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Idempotent one-shot to retro-classify Bluechip notification emails that
 * landed in email_log BEFORE the gmail-poller's receipt classifier was
 * wired in. Without this, those rows are invisible to both /invoicing
 * (filtered out of the shipment pipeline as receipts) and the Returns
 * section (no extensiv_receipts row).
 *
 *   npx tsx scripts/backfill-extensiv-receipts.ts            # live
 *   npx tsx scripts/backfill-extensiv-receipts.ts --dry-run  # preview
 *
 * What it does, per email_log row from notifications@secure-wms.com:
 *   1. Skip if extensiv_receipts.gmail_message_id already exists.
 *   2. classifyExtensivEmail({from,subject,body}). Skip non-receipt.
 *   3. matchReceiptToRma(...) → record matchKind / rmaId.
 *   4. INSERT extensiv_receipts row.
 *
 * Future emails are picked up by the gmail poller's
 * maybeProcessExtensivReceipt — same path, no schema change here.
 */

import "dotenv/config";
import { eq, isNotNull, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../src/db/index.js";
import { emailLog } from "../src/db/schema/crm.js";
import { extensivReceipts } from "../src/db/schema/returns.js";
import { classifyExtensivEmail } from "../src/modules/returns/extensiv-receipt-classifier.js";
import { matchReceiptToRma } from "../src/modules/returns/rma-matcher.js";

function parseArgs(): { dryRun: boolean } {
  return { dryRun: process.argv.includes("--dry-run") };
}

async function main() {
  const { dryRun } = parseArgs();
  console.log("=== Backfill extensiv_receipts ===");
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "LIVE"}\n`);

  // Pull every email_log row whose from address mentions the Bluechip
  // sender. Cheaper than scanning the whole table and the from_address
  // column is varchar(255) so LIKE is fine.
  const rows = await db
    .select({
      id: emailLog.id,
      gmailMessageId: emailLog.gmailMessageId,
      fromAddress: emailLog.fromAddress,
      subject: emailLog.subject,
      body: emailLog.body,
    })
    .from(emailLog)
    .where(like(emailLog.fromAddress, "%notifications@secure-wms.com%"));

  console.log(`Candidate Bluechip emails in email_log: ${rows.length}`);

  // Existing receipt rows so we can skip duplicates idempotently.
  const existing = await db
    .select({ gmailMessageId: extensivReceipts.gmailMessageId })
    .from(extensivReceipts)
    .where(isNotNull(extensivReceipts.gmailMessageId));
  const existingSet = new Set(existing.map((r) => r.gmailMessageId));
  console.log(`Already-classified receipts in DB: ${existingSet.size}\n`);

  let classified = 0;
  let alreadyClassified = 0;
  let notReceipt = 0;
  let inserted = 0;
  const matchKindCounts: Record<string, number> = {};

  for (const row of rows) {
    if (existingSet.has(row.gmailMessageId)) {
      alreadyClassified++;
      continue;
    }
    const result = classifyExtensivEmail({
      from: row.fromAddress ?? "",
      subject: row.subject ?? "",
      body: row.body ?? "",
    });
    if (result.direction !== "return_receipt") {
      notReceipt++;
      continue;
    }
    classified++;

    // Run the matcher with whatever signals the classifier extracted.
    const match = await matchReceiptToRma({
      txNumber: result.txNumber,
      refString: result.refString,
      parsedItems: result.parsedItems,
    });
    matchKindCounts[match.kind] = (matchKindCounts[match.kind] ?? 0) + 1;

    const rmaId = match.kind !== "no_match" ? match.rmaId : null;
    const matchConfidence =
      match.kind === "fuzzy_customer_sku"
        ? String(match.confidence.toFixed(2))
        : match.kind !== "no_match"
          ? "1.00"
          : null;

    console.log(
      `  ✓ ${row.gmailMessageId} → ${match.kind}` +
        (rmaId ? ` (rma ${rmaId})` : "") +
        (result.txNumber ? ` tx#${result.txNumber}` : ""),
    );

    if (!dryRun) {
      await db.insert(extensivReceipts).values({
        id: nanoid(24),
        rmaId,
        matchKind: match.kind,
        matchConfidence,
        txNumber: result.txNumber ?? null,
        refString: result.refString ?? null,
        parsedItemsJson: result.parsedItems ?? [],
        inferredCustomerName: null,
        gmailMessageId: row.gmailMessageId,
      });
    }
    inserted++;
  }

  console.log("\n=== Summary ===");
  console.log(`  Classified as receipt    : ${classified}`);
  console.log(`  Already in extensiv_receipts: ${alreadyClassified}`);
  console.log(`  Not a receipt            : ${notReceipt}`);
  console.log(`  ${dryRun ? "[DRY-RUN] " : ""}Inserted: ${inserted}`);
  if (Object.keys(matchKindCounts).length > 0) {
    console.log("  Match kinds:");
    for (const [k, v] of Object.entries(matchKindCounts)) {
      console.log(`    ${k}: ${v}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
