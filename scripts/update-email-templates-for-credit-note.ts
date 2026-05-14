// One-shot script to update the four seeded email templates in a live
// DB (dev / prod) with the new {{overdue_credit_note}} placeholder.
// The seed runner is idempotent on slug — it skips existing rows — so
// this script does the in-place UPDATE instead. Run once per environment
// after deploying the unapplied-credit-balance feature.
//
// Usage: `npx tsx scripts/update-email-templates-for-credit-note.ts`
//
// Behavior: for each of the four target slugs, fetch the current body,
// run a deterministic search-and-replace, write back if changed. Safe
// to run multiple times — the second run is a no-op.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { emailTemplates } from "../src/db/schema/email-templates.js";

type Replacement = {
  slug: string;
  find: string;
  replaceWith: string;
};

const REPLACEMENTS: Replacement[] = [
  {
    slug: "chase_l1",
    find: "{{overdue_balance}} is past due.",
    replaceWith: "{{overdue_balance}} is past due{{overdue_credit_note}}.",
  },
  {
    slug: "chase_l2",
    find: "is now {{overdue_balance}} (",
    replaceWith: "is now {{overdue_balance}}{{overdue_credit_note}} (",
  },
  {
    slug: "chase_l3",
    find: "outstanding at {{overdue_balance}} (oldest invoice",
    replaceWith:
      "outstanding at {{overdue_balance}}{{overdue_credit_note}} (oldest invoice",
  },
  {
    slug: "statement_open_items",
    find: "<strong>{{overdue_balance}}</strong> is past due.",
    replaceWith:
      "<strong>{{overdue_balance}}</strong> is past due{{overdue_credit_note}}.",
  },
];

async function main(): Promise<void> {
  for (const r of REPLACEMENTS) {
    const rows = await db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.slug, r.slug));
    const row = rows[0];
    if (!row) {
      console.log(`[skip] template '${r.slug}' not in DB`);
      continue;
    }
    if (row.body.includes("{{overdue_credit_note}}")) {
      console.log(
        `[skip] template '${r.slug}' already has the note placeholder`,
      );
      continue;
    }
    if (!row.body.includes(r.find)) {
      console.log(
        `[warn] template '${r.slug}' body does not contain expected substring: ${JSON.stringify(
          r.find,
        )}. Manual edit needed.`,
      );
      continue;
    }
    const newBody = row.body.replace(r.find, r.replaceWith);
    await db
      .update(emailTemplates)
      .set({ body: newBody })
      .where(eq(emailTemplates.slug, r.slug));
    console.log(`[update] template '${r.slug}' body updated`);
  }
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
