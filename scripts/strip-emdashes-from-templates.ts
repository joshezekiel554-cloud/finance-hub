// One-shot — replace U+2014 em-dashes with plain hyphens across
// every email_templates row's name / description / subject / body.
// The seed file's been updated too (see scripts/seed-email-templates.ts),
// so fresh installs land without em-dashes; this script catches the
// already-seeded copies the user has in their DB today.
//
// Idempotent — running it twice is a no-op for the second run because
// the first replaces all em-dashes with hyphens.
//
// Run:   npx tsx scripts/strip-emdashes-from-templates.ts

import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { emailTemplates } from "../src/db/schema/email-templates.js";

const EM_DASH = "—";

async function main(): Promise<void> {
  const rows = await db.select().from(emailTemplates);
  let touched = 0;
  for (const row of rows) {
    const name = row.name?.replace(/—/g, "-") ?? row.name;
    const description =
      row.description?.replace(/—/g, "-") ?? row.description;
    const subject = row.subject?.replace(/—/g, "-") ?? row.subject;
    const body = row.body?.replace(/—/g, "-") ?? row.body;

    if (
      name === row.name &&
      description === row.description &&
      subject === row.subject &&
      body === row.body
    ) {
      continue;
    }
    await db
      .update(emailTemplates)
      .set({ name, description, subject, body })
      .where(eq(emailTemplates.id, row.id));
    touched++;
    console.log(`  - ${row.slug}`);
  }
  console.log(
    `\nDone — ${touched}/${rows.length} template${rows.length === 1 ? "" : "s"} touched.`,
  );
  // Confirm there's nothing left.
  const recheck = await db.select().from(emailTemplates);
  const leftovers = recheck.filter(
    (r) =>
      (r.name ?? "").includes(EM_DASH) ||
      (r.description ?? "").includes(EM_DASH) ||
      (r.subject ?? "").includes(EM_DASH) ||
      (r.body ?? "").includes(EM_DASH),
  );
  if (leftovers.length > 0) {
    console.log(
      `\nWARNING: ${leftovers.length} row(s) still have em-dashes (expected 0).`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
