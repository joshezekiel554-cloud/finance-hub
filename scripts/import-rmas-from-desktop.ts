/**
 * import-rmas-from-desktop.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One-shot migration script: reads RMAs from the PyQt5 desktop app's SQLite
 * database and selectively imports them into finance-hub's MySQL via Drizzle.
 *
 * USAGE EXAMPLES
 * ──────────────
 *   # Import specific RMA numbers:
 *   npx tsx scripts/import-rmas-from-desktop.ts --rma-numbers RMA-2025-0001,RMA-2025-0002
 *
 *   # Import all RMAs created within a date range:
 *   npx tsx scripts/import-rmas-from-desktop.ts --from-date 2025-01-01 --to-date 2025-12-31
 *
 *   # Custom SQLite path (defaults to the desktop app's standard location):
 *   npx tsx scripts/import-rmas-from-desktop.ts \
 *     --sqlite-path "C:/Users/user/Documents/return software/data/returns.db" \
 *     --from-date 2025-01-01 --to-date 2025-12-31
 *
 *   # Dry-run (print what would be imported, no writes):
 *   npx tsx scripts/import-rmas-from-desktop.ts --from-date 2025-01-01 --dry-run
 *
 * IDEMPOTENCY
 * ───────────
 *   If an RMA with the same rma_number already exists in finance-hub the row
 *   is SKIPPED (no update). Re-running the script is safe.
 *
 * WHAT IS NOT IMPORTED
 * ────────────────────
 *   - Photos: the desktop uses filesystem paths; finance-hub uses Drive.
 *     The operator should upload photos manually via the return-detail page.
 *   - Consignment renewals: not part of the RMA schema.
 *   - Drive folders: not created here; created lazily on first photo upload.
 *
 * CREATED_BY_USER_ID
 * ──────────────────
 *   All imported rows are attributed to the IMPORT_USER_ID env variable.
 *   Set this to the nanoid of the operator running the import:
 *     IMPORT_USER_ID=<your-user-id> npx tsx scripts/import-rmas-from-desktop.ts ...
 *   If not set, a placeholder value is used and will need to be patched.
 */

import "dotenv/config";
import path from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { rmas, rmaItems, type RmaStatus, type RmaReturnType } from "../src/db/schema/returns.js";
import { customers } from "../src/db/schema/customers.js";

// ─── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_SQLITE_PATH = path.resolve(
  "C:/Users/user/Documents/return software/data/returns.db",
);

const IMPORT_USER_ID =
  process.env["IMPORT_USER_ID"] ?? "IMPORT_PLACEHOLDER_FIX_ME";

// ─── Desktop status → finance-hub status mapping ──────────────────────────────
//
// Desktop RMAStatus enum values:  pending | approved | denied | completed
// (Some older rows may also carry: "Sent to Warehouse" | "Received" | "Cancelled"
//  from pre-enum free-text — handle those too.)

const STATUS_MAP: Record<string, RmaStatus> = {
  // Canonical desktop enum values
  pending: "approved",      // "Pending" in the desktop = awaiting warehouse; map to approved
  approved: "approved",
  denied: "denied",
  completed: "completed",
  // Legacy / alternate free-text values observed in older data
  draft: "draft",
  cancelled: "cancelled",
  "sent to warehouse": "sent_to_warehouse",
  received: "received",
  closed: "completed",
  rejected: "denied",
};

function mapStatus(desktopStatus: string): RmaStatus {
  const mapped = STATUS_MAP[desktopStatus.toLowerCase().trim()];
  if (!mapped) {
    console.warn(
      `  [WARN] Unknown desktop status "${desktopStatus}" — importing as "draft". Fix manually.`,
    );
    return "draft";
  }
  return mapped;
}

// ─── Desktop return_type → finance-hub return_type mapping ────────────────────

const RETURN_TYPE_MAP: Record<string, RmaReturnType> = {
  seasonal: "seasonal",
  non_seasonal: "non_seasonal",
  damage: "damage",
  // consignment is not in finance-hub's enum — import as non_seasonal with a warning
  consignment: "non_seasonal",
};

function mapReturnType(desktopType: string): RmaReturnType {
  const mapped = RETURN_TYPE_MAP[desktopType.toLowerCase().trim()];
  if (!mapped) {
    console.warn(
      `  [WARN] Unknown desktop return_type "${desktopType}" — importing as "non_seasonal". Fix manually.`,
    );
    return "non_seasonal";
  }
  if (desktopType.toLowerCase() === "consignment") {
    console.warn(
      `  [WARN] Consignment return_type has no equivalent — imported as "non_seasonal".`,
    );
  }
  return mapped;
}

// ─── Desktop SQLite row shapes ─────────────────────────────────────────────────

type DesktopRmaRow = {
  id: number;
  rma_number: string;
  season_id: number | null;
  customer_name: string;
  customer_email: string;
  customer_id: string; // QuickBooks customer ID
  status: string;
  return_type: string;
  items: string; // JSON array of ReturnItem dicts
  total_value: number;
  eligible_amount: number;
  return_percentage: number;
  eligibility_details: string;
  original_email: string;
  denial_reason: string;
  notes: string;
  resolution_type: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type DesktopItemDict = {
  sku: string;
  name: string;
  quantity: number;
  unit_price: number;
  reason: string;
  invoice_number: string;
  invoice_date: string;
};

// ─── Result tracking ──────────────────────────────────────────────────────────

type ImportResult =
  | { rmaNumber: string; outcome: "imported"; financeHubId: string }
  | { rmaNumber: string; outcome: "skipped"; reason: string }
  | { rmaNumber: string; outcome: "failed"; error: string };

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(): {
  rmaNumbers: string[] | null;
  fromDate: string | null;
  toDate: string | null;
  sqlitePath: string;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);

  let rmaNumbers: string[] | null = null;
  let fromDate: string | null = null;
  let toDate: string | null = null;
  let sqlitePath = DEFAULT_SQLITE_PATH;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--rma-numbers" && args[i + 1]) {
      rmaNumbers = args[++i]!.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--from-date" && args[i + 1]) {
      fromDate = args[++i]!;
    } else if (arg === "--to-date" && args[i + 1]) {
      toDate = args[++i]!;
    } else if (arg === "--sqlite-path" && args[i + 1]) {
      sqlitePath = args[++i]!;
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  if (!rmaNumbers && !fromDate) {
    console.error(
      "Error: Provide either --rma-numbers RMA-001,RMA-002 or --from-date YYYY-MM-DD [--to-date YYYY-MM-DD]",
    );
    process.exit(1);
  }

  return { rmaNumbers, fromDate, toDate, sqlitePath, dryRun };
}

// ─── Customer lookup ──────────────────────────────────────────────────────────

async function findCustomerByQbId(
  qbCustomerId: string,
): Promise<{ id: string } | null> {
  if (!qbCustomerId) return null;
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.qbCustomerId, qbCustomerId))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Idempotency check ────────────────────────────────────────────────────────

async function rmaExistsByNumber(rmaNumber: string): Promise<boolean> {
  const rows = await db
    .select({ id: rmas.id })
    .from(rmas)
    .where(eq(rmas.rmaNumber, rmaNumber))
    .limit(1);
  return rows.length > 0;
}

// ─── Single RMA import ────────────────────────────────────────────────────────

async function importSingleRma(
  row: DesktopRmaRow,
  dryRun: boolean,
): Promise<ImportResult> {
  const rmaNumber = row.rma_number;

  // Idempotency: skip if already present
  if (await rmaExistsByNumber(rmaNumber)) {
    return { rmaNumber, outcome: "skipped", reason: "already exists in finance-hub" };
  }

  // Customer lookup by QB customer ID
  const customer = await findCustomerByQbId(row.customer_id);
  if (!customer) {
    return {
      rmaNumber,
      outcome: "skipped",
      reason: `customer not found by qb_customer_id "${row.customer_id}" (name: "${row.customer_name}") — sync customer first`,
    };
  }

  const financeHubId = nanoid(24);
  const returnType = mapReturnType(row.return_type);
  const status = mapStatus(row.status);

  // Parse items from the desktop's JSON blob
  let desktopItems: DesktopItemDict[] = [];
  try {
    const parsed: unknown = JSON.parse(row.items || "[]");
    if (Array.isArray(parsed)) {
      desktopItems = parsed as DesktopItemDict[];
    }
  } catch {
    console.warn(`  [WARN] Could not parse items JSON for ${rmaNumber} — items will be empty`);
  }

  // Determine classification per return_type
  const itemClassification =
    returnType === "damage"
      ? "damage"
      : returnType === "non_seasonal"
        ? "non_seasonal"
        : "seasonal_current"; // default for seasonal; operator can refine

  // Map resolution_type
  const resolutionType =
    row.resolution_type === "replacement"
      ? "replacement"
      : row.resolution_type === "credit"
        ? "credit"
        : undefined;

  if (dryRun) {
    console.log(`  [DRY-RUN] Would import: ${rmaNumber} → id=${financeHubId}`);
    console.log(`    customer=${customer.id} (qb=${row.customer_id})`);
    console.log(`    type=${returnType} status=${status} items=${desktopItems.length}`);
    return { rmaNumber, outcome: "imported", financeHubId };
  }

  // Insert RMA row
  await db.insert(rmas).values({
    id: financeHubId,
    rmaNumber,
    customerId: customer.id,
    qbCustomerId: row.customer_id || null,
    returnType,
    status,
    seasonId: null, // desktop season IDs are SQLite integers, not our nanoids; operator maps manually
    totalValue: String(row.total_value.toFixed(2)),
    eligibleAmount: row.eligible_amount > 0 ? String(row.eligible_amount.toFixed(2)) : null,
    returnPercentage: row.return_percentage > 0 ? String(row.return_percentage.toFixed(2)) : null,
    eligibilityDetails: row.eligibility_details
      ? (() => {
          try {
            return JSON.parse(row.eligibility_details);
          } catch {
            return { raw: row.eligibility_details };
          }
        })()
      : null,
    denialReason: row.denial_reason || null,
    originalEmail: row.original_email || null,
    // Tag imported rows so operators can spot them in the detail view. The
    // tag is plain text; the existing notes field already shows on detail.
    notes: row.notes
      ? `[Imported from desktop]\n${row.notes}`
      : "[Imported from desktop]",
    resolutionType: resolutionType ?? null,
    thresholdOverridden: false,
    createdViaReceipt: false,
    createdByUserId: IMPORT_USER_ID,
    completedAt: row.completed_at ? new Date(row.completed_at) : null,
    createdAt: row.created_at ? new Date(row.created_at) : undefined,
  });

  // Insert items
  for (let i = 0; i < desktopItems.length; i++) {
    const item = desktopItems[i]!;
    const qty = item.quantity ?? 1;
    const price = item.unit_price ?? 0;
    const lineTotal = (qty * price).toFixed(2);

    await db.insert(rmaItems).values({
      id: nanoid(24),
      rmaId: financeHubId,
      position: i,
      // qbItemId is unknown at import time — leave it blank. Empty string is
      // the existing convention for "not picked" in the items table UI, so
      // the QboItemPicker shows up automatically pre-filled with the SKU as
      // the search hint. The operator only needs to re-resolve when they
      // actually want to take an in-flight imported RMA further (e.g. issue
      // a credit memo). For the 117 completed rows this never matters.
      qbItemId: "",
      sku: item.sku || "",
      name: item.name || "",
      quantity: String(qty),
      unitPrice: String(price),
      lineTotal,
      classification: itemClassification,
      reason: item.reason || null,
      originalInvoiceDocNumber: item.invoice_number || null,
      originalInvoiceDate: item.invoice_date
        ? (() => {
            try {
              return new Date(item.invoice_date);
            } catch {
              return null;
            }
          })()
        : null,
    });
  }

  return { rmaNumber, outcome: "imported", financeHubId };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { rmaNumbers, fromDate, toDate, sqlitePath, dryRun } = parseArgs();

  console.log("=== RMA Import from Desktop SQLite ===");
  console.log(`SQLite path : ${sqlitePath}`);
  console.log(`Mode        : ${dryRun ? "DRY-RUN (no writes)" : "LIVE"}`);
  if (rmaNumbers) console.log(`Filter      : rma_numbers = ${rmaNumbers.join(", ")}`);
  if (fromDate) console.log(`Filter      : from_date >= ${fromDate}`);
  if (toDate) console.log(`Filter      : to_date <= ${toDate}`);
  console.log("");

  // Open SQLite
  let sqlite: Database.Database;
  try {
    sqlite = new Database(sqlitePath, { readonly: true });
  } catch (err) {
    console.error(`Failed to open SQLite at "${sqlitePath}":`, err);
    process.exit(1);
  }

  // Query matching rows
  let rows: DesktopRmaRow[];
  if (rmaNumbers && rmaNumbers.length > 0) {
    const placeholders = rmaNumbers.map(() => "?").join(", ");
    const stmt = sqlite.prepare(
      `SELECT * FROM rmas WHERE rma_number IN (${placeholders}) ORDER BY created_at`,
    );
    rows = stmt.all(...rmaNumbers) as DesktopRmaRow[];
  } else {
    const conditions: string[] = [];
    const params: string[] = [];
    if (fromDate) {
      conditions.push("created_at >= ?");
      params.push(fromDate);
    }
    if (toDate) {
      // Add end-of-day to be inclusive
      const toDateEndOfDay = toDate.includes("T") ? toDate : `${toDate}T23:59:59`;
      conditions.push("created_at <= ?");
      params.push(toDateEndOfDay);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const stmt = sqlite.prepare(`SELECT * FROM rmas ${where} ORDER BY created_at`);
    rows = stmt.all(...params) as DesktopRmaRow[];
  }

  sqlite.close();

  console.log(`Found ${rows.length} RMA(s) in desktop database matching filters.\n`);

  if (rows.length === 0) {
    console.log("Nothing to import.");
    process.exit(0);
  }

  // Process each row
  const results: ImportResult[] = [];
  for (const row of rows) {
    console.log(`Processing ${row.rma_number} (desktop id=${row.id})…`);
    const result = await importSingleRma(row, dryRun);
    results.push(result);

    switch (result.outcome) {
      case "imported":
        console.log(`  ✓ ${dryRun ? "[DRY-RUN] " : ""}Imported → ${result.financeHubId}`);
        break;
      case "skipped":
        console.log(`  - Skipped: ${result.reason}`);
        break;
      case "failed":
        console.log(`  ✗ Failed: ${result.error}`);
        break;
    }
  }

  // Summary
  const imported = results.filter((r) => r.outcome === "imported").length;
  const skipped = results.filter((r) => r.outcome === "skipped").length;
  const failed = results.filter((r) => r.outcome === "failed").length;

  console.log("\n=== Summary ===");
  console.log(`  ${dryRun ? "[DRY-RUN] " : ""}Imported : ${imported}`);
  console.log(`  Skipped  : ${skipped}`);
  console.log(`  Failed   : ${failed}`);

  if (failed > 0) {
    console.log("\nFailed RMAs:");
    for (const r of results) {
      if (r.outcome === "failed") console.log(`  - ${r.rmaNumber}: ${r.error}`);
    }
  }

  if (imported > 0 && !dryRun) {
    console.log("\nPost-import checklist:");
    console.log("  1. Verify imported RMAs at /returns (filter by status/type).");
    console.log("     Imported rows are tagged '[Imported from desktop]' in notes.");
    console.log("  2. The 'completed' rows are read-only history — no further action needed.");
    console.log("  3. For 'approved' / 'denied' rows you intend to take further: open the");
    console.log("     RMA, items have empty qbItemId so the picker will appear pre-filled");
    console.log("     with the SKU; resolve each item against QBO before issuing a CM.");
    console.log("  4. Seasonal RMAs have no seasonId (the old app used different ids) —");
    console.log("     not required for completed history.");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
