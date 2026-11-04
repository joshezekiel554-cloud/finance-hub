// Add/remove changes to a customer's six recipient lists, shared by the
// Feldart AI update_customer_emails card (preview) and its executor, so the
// card and the write compute exactly the same result. Pure.
//
// Add/remove (not "replace the whole list") so that only the ADDED addresses
// are marked x-feldart-typed: the person must type a new address themselves,
// but never has to retype the ones already on file.

export const EMAIL_LISTS = ["invoiceTo", "invoiceCc", "invoiceBcc", "statementTo", "statementCc", "statementBcc"] as const;
export type EmailListKey = (typeof EMAIL_LISTS)[number];

export const EMAIL_LIST_COLUMNS: Record<EmailListKey, "invoiceToEmails" | "invoiceCcEmails" | "invoiceBccEmails" | "statementToEmails" | "statementCcEmails" | "statementBccEmails"> = {
  invoiceTo: "invoiceToEmails",
  invoiceCc: "invoiceCcEmails",
  invoiceBcc: "invoiceBccEmails",
  statementTo: "statementToEmails",
  statementCc: "statementCcEmails",
  statementBcc: "statementBccEmails",
};

export type EmailListChanges = Partial<Record<`${EmailListKey}Add` | `${EmailListKey}Remove`, string[]>>;

const norm = (e: string) => e.trim().toLowerCase();

/** The lists this change touches, as { before, after }. Untouched lists are absent. */
export function applyEmailListChanges(
  current: Partial<Record<EmailListKey, readonly string[] | null | undefined>>,
  changes: EmailListChanges,
): Partial<Record<EmailListKey, { before: string[]; after: string[]; added: string[] }>> {
  const out: Partial<Record<EmailListKey, { before: string[]; after: string[]; added: string[] }>> = {};
  for (const key of EMAIL_LISTS) {
    const add = (changes[`${key}Add`] ?? []).map(norm).filter(Boolean);
    const remove = new Set((changes[`${key}Remove`] ?? []).map(norm).filter(Boolean));
    if (add.length === 0 && remove.size === 0) continue;
    const before = (current[key] ?? []).map(norm);
    const kept = before.filter((e) => !remove.has(e));
    const added = add.filter((e) => !kept.includes(e));
    out[key] = { before, after: [...new Set([...kept, ...added])], added: [...new Set(added)] };
  }
  return out;
}
