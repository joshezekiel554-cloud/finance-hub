/**
 * backfill-imported-cm-links.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * For each finance-hub RMA that was imported from the desktop app and has
 * status=completed but no qboCreditMemoId yet, find the original credit
 * memo doc number from the desktop SQLite, look it up in QBO, and write
 * back creditMemoDocNumber + qboCreditMemoId so the detail page shows the
 * "View CM in QBO" link the same as a native completed RMA.
 *
 * USAGE
 * ─────
 *   npx tsx scripts/backfill-imported-cm-links.ts            # live
 *   npx tsx scripts/backfill-imported-cm-links.ts --dry-run  # preview only
 *   npx tsx scripts/backfill-imported-cm-links.ts \
 *     --sqlite-path "C:/Users/user/Documents/return software/data/returns.db"
 *
 * IDEMPOTENCY
 * ───────────
 *   Skips rows that already have qboCreditMemoId set, so it's safe to re-run.
 *
 * DOC# QUIRKS
 * ───────────
 *   The desktop app sometimes recorded doc numbers as "17336CRCR" (double
 *   CR suffix) due to a save-time bug. We try the value as-is first, then
 *   fall back to a CRCR→CR variant before giving up. Rows we can't match
 *   are listed at the end so the operator can fix them by hand.
 */

import "dotenv/config";
import path from "node:path";
import Database from "better-sqlite3";
import { and, eq, isNull, like } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { rmas } from "../src/db/schema/returns.js";
import { QboClient } from "../src/integrations/qb/client.js";

const DEFAULT_SQLITE_PATH = path.resolve(
  "C:/Users/user/Documents/return software/data/returns.db",
);

function parseArgs(): { sqlitePath: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let sqlitePath = DEFAULT_SQLITE_PATH;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--sqlite-path" && args[i + 1]) {
      sqlitePath = args[++i]!;
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    }
  }
  return { sqlitePath, dryRun };
}

// Generate fallback variants for a desktop doc# in case of the CRCR bug or
// missing CR suffix. Tried in order; first QBO match wins.
function docNumberCandidates(raw: string): string[] {
  const candidates = new Set<string>();
  const trimmed = raw.trim();
  if (trimmed) candidates.add(trimmed);
  // CRCR → CR (e.g. "17336CRCR" → "17336CR")
  if (/CRCR$/.test(trimmed)) {
    candidates.add(trimmed.replace(/CRCR$/, "CR"));
  }
  // No suffix at all → try with one CR appended
  if (!/CR$/i.test(trimmed)) {
    candidates.add(`${trimmed}CR`);
  }
  // Strip the CR suffix as a last resort (rare but defensive)
  if (/CR$/i.test(trimmed)) {
    candidates.add(trimmed.replace(/CR$/i, ""));
  }
  return Array.from(candidates);
}

async function main() {
  const { sqlitePath, dryRun } = parseArgs();

  console.log("=== Backfill imported-CM links ===");
  console.log(`SQLite path : ${sqlitePath}`);
  console.log(`Mode        : ${dryRun ? "DRY-RUN" : "LIVE"}`);
  console.log("");

  // Read desktop CM mapping: rma_number → credit_memo_id
  const sqlite = new Database(sqlitePath, { readonly: true });
  const desktopRows = sqlite
    .prepare(
      "SELECT rma_number, credit_memo_id FROM rmas WHERE status = 'completed' AND credit_memo_id IS NOT NULL AND credit_memo_id != ''",
    )
    .all() as Array<{ rma_number: string; credit_memo_id: string }>;
  sqlite.close();

  const desktopByNumber = new Map<string, string>();
  for (const r of desktopRows) desktopByNumber.set(r.rma_number, r.credit_memo_id);
  console.log(
    `Desktop completed rows with a doc number: ${desktopByNumber.size}\n`,
  );

  // Find finance-hub RMAs that need backfilling: imported (notes prefix),
  // status=completed, no qboCreditMemoId yet.
  const targets = await db
    .select({
      id: rmas.id,
      rmaNumber: rmas.rmaNumber,
      currentDocNumber: rmas.creditMemoDocNumber,
    })
    .from(rmas)
    .where(
      and(
        eq(rmas.status, "completed"),
        like(rmas.notes, "[Imported from desktop]%"),
        isNull(rmas.qboCreditMemoId),
      ),
    );

  console.log(`Finance-hub completed imports needing backfill: ${targets.length}\n`);

  if (targets.length === 0) {
    console.log("Nothing to do.");
    process.exit(0);
  }

  const qbo = new QboClient();

  let patched = 0;
  let alreadyOk = 0;
  const noDesktopMatch: string[] = [];
  const noQboMatch: Array<{ rmaNumber: string; tried: string[] }> = [];

  for (const t of targets) {
    if (!t.rmaNumber) {
      noDesktopMatch.push(`(no rma_number, id=${t.id})`);
      continue;
    }
    const desktopDocNumber = desktopByNumber.get(t.rmaNumber);
    if (!desktopDocNumber) {
      noDesktopMatch.push(t.rmaNumber);
      continue;
    }

    const candidates = docNumberCandidates(desktopDocNumber);
    let matched: { docNumber: string; qboId: string } | null = null;
    for (const candidate of candidates) {
      try {
        const cm = await qbo.getCreditMemoByDocNumber(candidate);
        if (cm) {
          matched = { docNumber: candidate, qboId: cm.Id };
          break;
        }
      } catch (err) {
        console.warn(
          `  [WARN] QBO lookup failed for ${t.rmaNumber} (tried "${candidate}"):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (!matched) {
      noQboMatch.push({ rmaNumber: t.rmaNumber, tried: candidates });
      continue;
    }

    const note =
      matched.docNumber !== desktopDocNumber
        ? ` (normalised "${desktopDocNumber}" → "${matched.docNumber}")`
        : "";
    console.log(
      `  ✓ ${t.rmaNumber} → CM ${matched.docNumber} (QBO id ${matched.qboId})${note}`,
    );

    if (!dryRun) {
      await db
        .update(rmas)
        .set({
          creditMemoDocNumber: matched.docNumber,
          qboCreditMemoId: matched.qboId,
        })
        .where(eq(rmas.id, t.id));
    }
    patched++;
  }

  console.log("\n=== Summary ===");
  console.log(`  ${dryRun ? "[DRY-RUN] " : ""}Patched          : ${patched}`);
  console.log(`  Already linked   : ${alreadyOk}`);
  console.log(`  Missing in desktop: ${noDesktopMatch.length}`);
  console.log(`  Not found in QBO  : ${noQboMatch.length}`);

  if (noDesktopMatch.length > 0) {
    console.log("\nMissing in desktop (rma_number not in desktop DB):");
    for (const n of noDesktopMatch) console.log(`  - ${n}`);
  }
  if (noQboMatch.length > 0) {
    console.log("\nNot found in QBO (tried these doc# variants):");
    for (const r of noQboMatch) {
      console.log(`  - ${r.rmaNumber}: ${r.tried.join(" | ")}`);
    }
    console.log(
      "\n  Fix these manually via the 'Already credited' button on the detail page.",
    );
  }

  process.exit(noQboMatch.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
