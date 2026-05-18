// One-shot: walk Gmail's sendAs aliases and pre-populate alias_signatures
// rows from each alias's existing `signature` field. Skips aliases that
// already have a row. Re-run is a no-op.
//
// IMPORTANT: this is NOT a sync. After seeding, alias signatures live in
// our DB and edits in our Settings page do NOT propagate back to Gmail.

import { db } from "../src/db/index.js";
import { aliasSignatures } from "../src/db/schema/alias-signatures.js";
import { eq } from "drizzle-orm";
import { listAliases } from "../src/integrations/gmail/aliases.js";
import {
  sanitizeSignatureHtml,
  MAX_SIGNATURE_BYTES,
} from "../src/modules/email-compose/signatures.js";
import { getInternalGmailClient, withRetry } from "../src/integrations/gmail/client.js";

async function main() {
  const aliases = await listAliases();
  const gmail = await getInternalGmailClient();

  let seeded = 0;
  let skipped = 0;
  let empty = 0;

  for (const alias of aliases) {
    const email = alias.sendAsEmail.toLowerCase();
    if (!email) continue;

    const existing = await db
      .select({ aliasEmail: aliasSignatures.aliasEmail })
      .from(aliasSignatures)
      .where(eq(aliasSignatures.aliasEmail, email))
      .limit(1);
    if (existing[0]) {
      skipped++;
      console.log(`SKIP ${email} — already in DB`);
      continue;
    }

    const res = await withRetry(
      () =>
        gmail.users.settings.sendAs.get({
          userId: "me",
          sendAsEmail: alias.sendAsEmail,
        }),
      `settings.sendAs.get(${alias.sendAsEmail})`,
    );
    const raw = res.data.signature ?? "";
    if (!raw.trim()) {
      empty++;
      console.log(`EMPTY ${email} — no signature in Gmail`);
      continue;
    }
    if (raw.length > MAX_SIGNATURE_BYTES) {
      console.warn(
        `OVERSIZED ${email} — ${raw.length} bytes; truncate or edit manually`,
      );
      continue;
    }

    const sanitized = sanitizeSignatureHtml(raw);
    await db.insert(aliasSignatures).values({
      aliasEmail: email,
      html: sanitized,
      updatedByUserId: null,
    });
    seeded++;
    console.log(`SEEDED ${email} (${sanitized.length} bytes after sanitisation)`);
  }

  console.log(
    `\nPre-populated ${seeded} alias(es) from Gmail. Skipped ${skipped} (already present), ${empty} empty.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
