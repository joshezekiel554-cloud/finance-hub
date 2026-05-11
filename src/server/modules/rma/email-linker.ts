// src/server/modules/rma/email-linker.ts
//
// Scans inbound emails for RMA number references and persists the
// email→RMA association in email_rma_links. Two entry points:
//   - linkEmailToRmas(messageId, subject, body): called per-email at Gmail poll time
//   - backfillLinksForRma(rmaId): called when an RMA gets a number,
//     and on-demand from the "Check for emails" button on the RMA page

import { eq, inArray } from "drizzle-orm";
import { db } from "~/db/index.js";
import { emailRmaLinks, rmas } from "~/db/schema/returns.js";
import { searchEmails } from "~/integrations/gmail/client.js";
import { createLogger } from "~/lib/logger.js";
import { extractRmaNumbers } from "./rma-number-format.js";

const log = createLogger({ module: "rma.email-linker" });

// Called when a new email is classified by the Gmail poller. Scans the
// (subject + body) for RMA number patterns and inserts link rows for
// any matching RMAs. Idempotent — duplicate inserts are no-ops via
// onDuplicateKeyUpdate on the composite PK (gmail_message_id, rma_id).
export async function linkEmailToRmas(
  gmailMessageId: string,
  subject: string,
  body: string,
): Promise<{ linked: string[] }> {
  const refs = extractRmaNumbers(`${subject}\n${body}`);
  if (refs.length === 0) return { linked: [] };

  const numbers = refs.map((r) => r.number);
  const matchingRmas = await db
    .select({ id: rmas.id })
    .from(rmas)
    .where(inArray(rmas.rmaNumber, numbers));

  if (matchingRmas.length === 0) return { linked: [] };

  const linked: string[] = [];
  for (const rma of matchingRmas) {
    try {
      await db
        .insert(emailRmaLinks)
        .values({
          gmailMessageId,
          rmaId: rma.id,
          source: "auto",
        })
        .onDuplicateKeyUpdate({ set: { source: "auto" } }); // no-op on dup
      linked.push(rma.id);
    } catch (err) {
      log.warn({ err, gmailMessageId, rmaId: rma.id }, "link insert failed");
    }
  }

  log.debug(
    { gmailMessageId, linked: linked.length, candidates: numbers.length },
    "linkEmailToRmas complete",
  );
  return { linked };
}

// Backfill: search Gmail for the RMA number across the last 90 days,
// link any matches not already linked. Used at RMA-number-assigned
// time and on-demand from the UI "Check for emails" button.
//
// Gmail search failure propagates to the caller — let them retry.
// Per-message errors are caught and logged; one bad message never
// aborts the whole backfill.
export async function backfillLinksForRma(rmaId: string): Promise<{
  scanned: number;
  newLinks: number;
}> {
  const rmaRow = await db
    .select({ rmaNumber: rmas.rmaNumber })
    .from(rmas)
    .where(eq(rmas.id, rmaId))
    .limit(1);

  if (!rmaRow.length || !rmaRow[0]!.rmaNumber) {
    return { scanned: 0, newLinks: 0 };
  }
  const rmaNumber = rmaRow[0]!.rmaNumber;

  // searchEmails returns full ParsedEmail objects (subject + body already
  // decoded), so no separate body-fetch step is needed.
  const messages = await searchEmails(
    `"${rmaNumber}" newer_than:90d`,
    100,
  );

  let newLinks = 0;
  for (const m of messages) {
    let result: { linked: string[] };
    try {
      result = await linkEmailToRmas(m.id, m.subject ?? "", m.body ?? "");
    } catch (err) {
      log.warn({ err, messageId: m.id }, "linkEmailToRmas failed during backfill; skipping");
      continue;
    }
    if (result.linked.includes(rmaId)) {
      newLinks++;
    }
  }

  log.info(
    { rmaId, rmaNumber, scanned: messages.length, newLinks },
    "backfillLinksForRma complete",
  );
  return { scanned: messages.length, newLinks };
}
