// prior-invoice-check — for a given customer, returns the set of qbItemIds
// that have appeared on any of their prior invoices. Drives the "not found
// on prior invoices" warning in the damage wizard so the operator can spot
// items the customer is claiming damage on but never actually purchased.
//
// We pull the customer's invoices once (QBO supports up to PAGE_SIZE=1000
// per query and the per-customer count is typically low hundreds), then
// flatten the SalesItemLineDetail.ItemRef values across all line items.
// Result is returned as a string array to keep the JSON serialisation simple
// — callers convert to a Set if they need O(1) membership.

import { QboClient } from "../../integrations/qb/client.js";

export type PriorInvoiceItemsResult = {
  qbItemIds: string[];
};

export async function getPriorInvoiceItems(
  qbCustomerId: string,
  qbo: QboClient = new QboClient(),
): Promise<PriorInvoiceItemsResult> {
  const invoices = await qbo.findInvoicesForCustomer(qbCustomerId);
  const ids = new Set<string>();
  for (const inv of invoices) {
    for (const line of inv.Line ?? []) {
      const id = line.SalesItemLineDetail?.ItemRef?.value;
      if (id) ids.add(id);
    }
  }
  return { qbItemIds: Array.from(ids) };
}
