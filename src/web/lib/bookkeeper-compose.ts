// Shared "Email TJ bookkeeper" compose prefill for the dispute loop
// (origin-split-2). Used by the /chase TJ wind-down panel and the customer
// detail invoices tab so the bookkeeper email reads identically from either
// surface. Callers resolve the doc label (docNumber ?? id/qbId fallback)
// before calling and open the compose modal with the returned prefill +
// app_settings.tj_bookkeeper_email as the recipient.

// Minimal HTML escape for strings injected into a compose prefill body
// (customer name, doc number). Keeps the bookkeeper email well-formed
// even if a name carries &, < or >.
export function escapeComposeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildBookkeeperCompose({
  customerName,
  docNumber,
  balance,
}: {
  customerName: string;
  // The resolved invoice label (docNumber with the caller's id fallback
  // already applied).
  docNumber: string;
  balance: string | number;
}): { subject: string; bodyHtml: string } {
  const amount = Number(balance).toFixed(2);
  const subject = `Payment check: invoice ${docNumber} (${customerName})`;
  const bodyHtml = [
    `<p>Hi,</p>`,
    `<p>${escapeComposeHtml(customerName)} says they have already paid invoice <strong>${escapeComposeHtml(docNumber)}</strong> (open balance $${amount}).</p>`,
    `<p>Could you confirm whether this was settled with Torah Judaica? If it was paid to TJ, let me know and we will void it on our side. If not, we will resume chasing it.</p>`,
    `<p>Thanks.</p>`,
  ].join("");
  return { subject, bodyHtml };
}
