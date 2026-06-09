// Invoice/credit-memo origin classification.
//
// Invoices: docNumber begins '1' (Feldart — we supplied it) or '2' (Torah
// Judaica legacy hand-over). The prefix is reliable for invoices.
//
// Credit memos: the prefix is NOT reliable (TJ and Feldart memos can both begin
// '2'), so we lean on stronger signals first — Feldart-generated memos (the
// in-app DC#### damage counter, or memos created by the returns flow) — then
// fall back to the prefix, then flag anything ambiguous for a one-time human
// sweep. (QBO's credit-memo fetch doesn't include LinkedTxn yet, so we can't
// inherit origin from the invoice a memo is applied against — future work.)

export type InvoiceOrigin = "feldart" | "tj";

export function originFromDocNumber(
  docNumber: string | null | undefined,
): InvoiceOrigin {
  return (docNumber ?? "").trim().startsWith("2") ? "tj" : "feldart";
}

export function classifyCreditMemoOrigin(
  cm: { qbCreditMemoId: string; docNumber: string | null | undefined },
  feldartCreditMemoIds: ReadonlySet<string>,
): { origin: InvoiceOrigin; originSource: "auto" | "needs_review" } {
  const doc = (cm.docNumber ?? "").trim();
  // Strong signals: known Feldart-generated memo, or the DC#### damage prefix.
  if (
    feldartCreditMemoIds.has(cm.qbCreditMemoId) ||
    doc.toUpperCase().startsWith("DC")
  ) {
    return { origin: "feldart", originSource: "auto" };
  }
  // Fall back to the numeric prefix.
  if (doc.startsWith("2")) return { origin: "tj", originSource: "auto" };
  if (doc.startsWith("1")) return { origin: "feldart", originSource: "auto" };
  // Ambiguous — surface in the origin-review sweep; best-guess feldart.
  return { origin: "feldart", originSource: "needs_review" };
}
