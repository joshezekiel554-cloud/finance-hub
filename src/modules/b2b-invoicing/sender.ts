// QBO send action — translates ReconcileAction[] into a QBO Invoice sparse
// update payload, then either logs (shadow mode) or POSTs (live mode).
//
// Key shape decisions, validated against a real Feldart invoice (18294):
//   - QBO sparse update: send Id + SyncToken + sparse:true; arrays you
//     include (Line) REPLACE the existing array, not patch it. So we must
//     emit the FULL post-reconcile Line list, not just diffs.
//   - The auto-generated SubTotalLineDetail row is dropped on update — QBO
//     regenerates it from the SalesItemLineDetail rows.
//   - ShipMethod entity is not enabled on Feldart's QBO realm; the carrier
//     is stored as both value AND name on ShipMethodRef as free text.
//   - Add rows default to TaxCodeRef = {value: "NON"} (US sales-tax-exempt
//     reseller default; matches every existing line on Feldart's invoices).
//   - The Description field carries the SKU on existing lines (the 3rd-party
//     Shopify→QB sync puts it there). Add rows do the same.

import type { QboInvoice, QboInvoiceLine } from "../../integrations/qb/types.js";
import type { ReconcileAction } from "./types.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "b2b-sender" });

const NON_TAXABLE_REF = { value: "NON" } as const;

export type SendOutcome =
  | {
      status: "shadow";
      // Payload that WOULD have been sent to QBO. Useful for snapshot tests
      // and for the UI to show a preview.
      payload: QboInvoicePayload;
    }
  | {
      status: "sent";
      payload: QboInvoicePayload;
      response: QboInvoice;
      // Populated when QBO accepted the /send (email) call after the update.
      // Null when the update succeeded but the email step failed or was skipped.
      email: {
        sentTo: string | null;
        sentAt: string;
      } | null;
      // Captured if /send threw — the update is still committed.
      emailError: string | null;
    };

// Sparse update body. QBO accepts a partial Invoice with sparse:true; only
// the fields included get touched. Required: Id, SyncToken. We always send
// Line + ship metadata.
export type QboInvoicePayload = {
  Id: string;
  SyncToken: string;
  sparse: true;
  TrackingNum?: string;
  ShipDate?: string;
  ShipMethodRef?: { value: string; name: string };
  // Always sent as { value: "" } to clear the customer-facing memo (renders
  // on the invoice form's "Message displayed on invoice" field).
  CustomerMemo: { value: string };
  // The 3rd-party Shopify→QB sync writes its boilerplate ("Total Amount of
  // Invoice for Shopify 18308 -> USD1386.5") into PrivateNote, the field
  // QBO's UI labels "Memo on statement (hidden)". Always blank it on send.
  PrivateNote: string;
  // Optional payment terms reference. Provided when the user picks a term
  // override; omitted when the existing SalesTermRef should stay.
  SalesTermRef?: { value: string; name?: string };
  Line: QboInvoiceLine[];
};

export type BuildPayloadOptions = {
  // Optional invoice-level percent discount (e.g. 5 = 5% off). When > 0, a
  // DiscountLineDetail row is appended (or replaces any existing one). When
  // 0/undefined, any existing discount on the invoice is dropped — caller
  // must opt in explicitly each time. This is intentional: B2B discounts
  // vary by shipment, and silently preserving an old discount could over-
  // discount a customer who's no longer eligible.
  discountPercent?: number;
  // Optional QBO Term Id (e.g. "3" for Net 30). When set, the invoice's
  // SalesTermRef is updated. When unset, the existing SalesTermRef stays —
  // QBO sparse updates leave omitted fields untouched.
  salesTermId?: string;
  salesTermName?: string;
};

// Pure transform: invoice + actions → sparse update payload. No I/O. The send
// function below wraps this with the actual POST or shadow-mode logging.
export function buildPayload(
  invoice: QboInvoice,
  actions: ReconcileAction[],
  options: BuildPayloadOptions = {},
): QboInvoicePayload {
  if (!invoice.SyncToken) {
    throw new Error(
      `buildPayload: invoice ${invoice.Id} has no SyncToken; refetch before mutating`,
    );
  }

  // Index existing line-edit actions by Line.Id for O(1) lookup while
  // walking the original Line array. Anything not in the index is preserved
  // as-is (covers SubTotalLineDetail and any other DetailType we don't touch).
  const editsByLineId = new Map<string, ReconcileAction>();
  for (const action of actions) {
    if (action.type === "keep" || action.type === "qty_change") {
      editsByLineId.set(action.lineId, action);
    }
  }

  const sourceLines = invoice.Line ?? [];
  const updatedLines: QboInvoiceLine[] = [];

  for (const line of sourceLines) {
    // Drop auto-generated subtotal lines — QBO regenerates them.
    if (line.DetailType === "SubTotalLineDetail") continue;
    // Drop any existing DiscountLineDetail — caller's `discountPercent` is
    // the source of truth for this update. If they didn't pass one, no
    // discount is applied.
    if (line.DetailType === "DiscountLineDetail") continue;
    if (!line.Id) {
      // Unidentifiable line; pass through verbatim. Belt-and-suspenders, since
      // the reconciler shouldn't address lines without IDs.
      updatedLines.push(line);
      continue;
    }
    const action = editsByLineId.get(line.Id);
    if (!action) {
      // Line not addressed by any action → keep verbatim.
      updatedLines.push(line);
      continue;
    }
    if (action.type === "keep") {
      updatedLines.push(line);
      continue;
    }
    if (action.type === "qty_change") {
      const detail = line.SalesItemLineDetail;
      const unitPrice = detail?.UnitPrice ?? 0;
      const newQty = action.toQty;
      updatedLines.push({
        ...line,
        Amount: round2(unitPrice * newQty),
        SalesItemLineDetail: {
          ...detail,
          Qty: newQty,
        },
      });
      continue;
    }
  }

  // Append add actions as new SalesItemLineDetail rows. Adds with null
  // unitPrice are blocked here — the UI must collect a price before send.
  for (const action of actions) {
    if (action.type !== "add") continue;
    if (action.unitPrice === null) {
      throw new Error(
        `buildPayload: add action for SKU ${action.sku} has no unitPrice; UI must resolve fallback price before send`,
      );
    }
    updatedLines.push(buildAddLine(action.sku, action.qty, action.unitPrice));
  }

  // Append a percent-discount line if requested. PercentBased=true tells QBO
  // to compute Amount server-side from the subtotal × DiscountPercent. We
  // don't set DiscountAccountRef — QBO falls back to the invoice template
  // default (existing customers won't need this set explicitly).
  if (
    options.discountPercent !== undefined &&
    options.discountPercent > 0
  ) {
    if (options.discountPercent > 100) {
      throw new Error(
        `buildPayload: discountPercent ${options.discountPercent} exceeds 100`,
      );
    }
    updatedLines.push({
      DetailType: "DiscountLineDetail",
      Amount: 0,
      // QBO's Drizzle types don't include DiscountLineDetail in
      // QboInvoiceLine; cast through unknown so the runtime payload has the
      // field. (We're intentionally tolerating type drift here — full
      // typing of every QBO Line subtype is YAGNI for our surface.)
      ...{
        DiscountLineDetail: {
          PercentBased: true,
          DiscountPercent: options.discountPercent,
        },
      },
    } as unknown as QboInvoiceLine);
  }

  // Find the set_metadata action (always present, by reconciler contract).
  const meta = actions.find((a) => a.type === "set_metadata");
  const payload: QboInvoicePayload = {
    Id: invoice.Id,
    SyncToken: invoice.SyncToken,
    sparse: true,
    // Always blank both memo fields — 3rd-party sync writes sales-receipt
    // boilerplate into PrivateNote (the "Memo on statement (hidden)" field
    // in QBO's UI). CustomerMemo is cleared defensively in case some
    // invoices carry stale content there too.
    CustomerMemo: { value: "" },
    PrivateNote: "",
    Line: updatedLines,
  };
  if (meta && meta.type === "set_metadata") {
    payload.TrackingNum = meta.trackingNumber;
    payload.ShipDate = meta.shipDate;
    payload.ShipMethodRef = { value: meta.shipVia, name: meta.shipVia };
  }
  if (options.salesTermId) {
    payload.SalesTermRef = {
      value: options.salesTermId,
      ...(options.salesTermName ? { name: options.salesTermName } : {}),
    };
  }
  return payload;
}

export type SendOptions = {
  shadowMode: boolean;
  // Hook for the live POST. Caller passes a function that does the actual
  // QBO call (so the sender doesn't depend on QboClient directly — keeps it
  // testable and the surface narrow).
  postUpdate?: (payload: QboInvoicePayload) => Promise<QboInvoice>;
  // Hook for the /invoice/{id}/send call — emails the invoice to the
  // customer's BillEmail. Skipped in shadow mode and when not provided.
  postSendEmail?: (invoiceId: string) => Promise<QboInvoice>;
  // Forwarded to buildPayload — see BuildPayloadOptions.
  discountPercent?: number;
  salesTermId?: string;
  salesTermName?: string;
};

// Wraps buildPayload with side-effects: shadow-mode logging or live POST.
// In shadow mode no POST happens regardless of postUpdate being supplied.
// In live mode postUpdate is required.
export async function sendInvoiceUpdate(
  invoice: QboInvoice,
  actions: ReconcileAction[],
  opts: SendOptions,
): Promise<SendOutcome> {
  const payload = buildPayload(invoice, actions, {
    discountPercent: opts.discountPercent,
    salesTermId: opts.salesTermId,
    salesTermName: opts.salesTermName,
  });

  if (opts.shadowMode) {
    log.info(
      {
        invoiceId: payload.Id,
        docNumber: invoice.DocNumber,
        actions: actions.length,
        addCount: actions.filter((a) => a.type === "add").length,
        qtyChangeCount: actions.filter((a) => a.type === "qty_change").length,
        trackingNum: payload.TrackingNum,
        shipDate: payload.ShipDate,
        shipVia: payload.ShipMethodRef?.value,
        lineCount: payload.Line.length,
      },
      "shadow mode: invoice update prepared, NOT sent",
    );
    return { status: "shadow", payload };
  }

  if (!opts.postUpdate) {
    throw new Error(
      "sendInvoiceUpdate: live mode requires postUpdate hook — caller must wire QboClient",
    );
  }
  const response = await opts.postUpdate(payload);
  log.info(
    {
      invoiceId: response.Id,
      docNumber: response.DocNumber,
      newSyncToken: response.SyncToken,
    },
    "invoice update sent to QBO",
  );

  // Update succeeded; now email the customer if the caller wired the send
  // hook. Failures here are non-fatal — the update is committed regardless.
  let email: { sentTo: string | null; sentAt: string } | null = null;
  let emailError: string | null = null;
  if (opts.postSendEmail) {
    try {
      const sentInvoice = await opts.postSendEmail(response.Id);
      const sentTo =
        (sentInvoice as unknown as { BillEmail?: { Address?: string } })
          .BillEmail?.Address ??
        (response as unknown as { BillEmail?: { Address?: string } }).BillEmail
          ?.Address ??
        null;
      email = { sentTo, sentAt: new Date().toISOString() };
      log.info(
        { invoiceId: response.Id, sentTo },
        "invoice emailed to customer",
      );
    } catch (err) {
      emailError = (err as Error).message;
      log.error(
        { err, invoiceId: response.Id },
        "invoice update committed but email send failed",
      );
    }
  }

  return { status: "sent", payload, response, email, emailError };
}

// ---------- helpers ----------

// Build a fresh SalesItemLineDetail row for an add action. SKU goes into
// Description (matching the 3rd-party sync's convention on existing lines).
// ItemRef is omitted: we don't have the QBO Item Id for a SKU not on the
// invoice. QBO's sparse update tolerates this for new lines as long as
// SalesItemLineDetail is present; the merchant resolves it in QBO admin
// post-send. Future improvement: look up the Item by SKU and populate
// ItemRef before sending.
function buildAddLine(
  sku: string,
  qty: number,
  unitPrice: number,
): QboInvoiceLine {
  return {
    Description: sku,
    Amount: round2(unitPrice * qty),
    DetailType: "SalesItemLineDetail",
    SalesItemLineDetail: {
      Qty: qty,
      UnitPrice: unitPrice,
      TaxCodeRef: { ...NON_TAXABLE_REF },
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
