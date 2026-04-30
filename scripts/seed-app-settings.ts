// Seeds default app_settings rows. Idempotent — only inserts keys that
// don't exist, never overwrites user edits. Run on first boot;
// subsequent runs are no-ops for keys the user has already touched.
//
// To add a new default key: add it here AND to APP_SETTING_KEYS in
// src/db/schema/app-settings.ts, then re-run.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { appSettings } from "../src/db/schema/app-settings.js";

type SeedRow = {
  key: string;
  value: string;
  description: string;
};

const DEFAULTS: SeedRow[] = [
  {
    key: "company_name",
    value: "Feldart LLC",
    description: "Shown top-left of every Statement PDF.",
  },
  {
    key: "company_address",
    value: "5200 15th Ave, Suite 5B\nBrooklyn, NY 11219-3932 USA",
    description:
      "Multi-line. Shown directly under company name on the Statement PDF.",
  },
  {
    key: "company_phone",
    value: "",
    description: "Optional. Shown in company info block on the PDF.",
  },
  {
    key: "company_email",
    value: "accounts@feldart.com",
    description: "Shown in company info block; also the primary alias for outbound mail.",
  },
  {
    key: "company_website",
    value: "https://feldart.com/",
    description: "Shown in company info block.",
  },
  {
    key: "company_logo_path",
    value: "",
    description:
      "Disk path of the uploaded logo (managed via /api/logo-upload). Empty = no logo rendered.",
  },
  {
    key: "payment_methods",
    value: [
      'Credit card — click "View and pay" links in the table above',
      "ACH — Routing [edit in settings] / Account [edit in settings]",
      "Zelle — info@feldart.com",
      "Email a check to accounts@feldart.com",
    ].join("\n"),
    description:
      "Multi-line block rendered in the Statement PDF footer. Customize via Settings.",
  },
  {
    key: "footer_note",
    value: "",
    description: 'Optional one-liner under payment methods (e.g. "Thank you for your business").',
  },
  {
    key: "statement_number_next",
    value: "6013",
    description:
      "Auto-incrementing counter for STATEMENT NO. on the PDF. Set high enough to clear your existing QBO range.",
  },
];

async function main() {
  let created = 0;
  let skipped = 0;
  for (const row of DEFAULTS) {
    const existing = await db
      .select({ key: appSettings.key })
      .from(appSettings)
      .where(eq(appSettings.key, row.key))
      .limit(1);
    if (existing.length > 0) {
      skipped++;
      continue;
    }
    await db.insert(appSettings).values(row);
    created++;
  }
  console.log(`Seeded app_settings: ${created} created, ${skipped} already present.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAIL:", e);
    process.exit(1);
  });
