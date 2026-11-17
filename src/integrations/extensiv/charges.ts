// Turn an Extensiv order's billing charges into the "what did this shipment
// cost us" summary shown on Invoicing Today. Pure, so it can be unit tested.
//
// Extensiv groups charges by chargeType. On Blue Chip's account:
//   3 = Freight      ("Small Parcel Ship": the shipping cost they bill us)
//   1 = Handling     ("Order Fee - Ecom", "Picks")
//   6 = Materials    (boxes)
// Anything else is passed through under its own labels.

import type { ExtensivOrder } from "./client.js";

export type ShipmentCharges = {
  transactionNumber: string;
  reference: string | null;
  // Blue Chip's shipping charge (sum of freight charges). Null when the
  // order hasn't been billed yet.
  shipping: number | null;
  // Every billed line, for the hover breakdown.
  lines: Array<{ label: string; amount: number }>;
  // Sum of all billed warehouse charges for the order.
  totalCharges: number | null;
  // The carrier's own rate from the rate-shopping step, before markup.
  carrierService: string | null;
  carrierRate: number | null;
};

const FREIGHT = 3;

const round2 = (n: number) => Math.round(n * 100) / 100;

type ChosenRate = {
  serviceName?: string;
  amounts?: { total?: number };
};

function parseChosenRate(raw: string | null | undefined): ChosenRate | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as ChosenRate) : null;
  } catch {
    return null;
  }
}

export function summarizeCharges(order: ExtensivOrder): ShipmentCharges | null {
  const id = order.readOnly?.orderId;
  if (id === undefined || id === null) return null;

  const charges = order.billing?.billingCharges ?? [];
  const lines: ShipmentCharges["lines"] = [];
  let shipping: number | null = null;
  let total = 0;
  for (const ch of charges) {
    const subtotal = Number(ch.subtotal ?? 0);
    if (!Number.isFinite(subtotal)) continue;
    total += subtotal;
    if (ch.chargeType === FREIGHT) shipping = (shipping ?? 0) + subtotal;
    for (const d of ch.details ?? []) {
      const amount = Number(d.numUnits ?? 0) * Number(d.chargePerUnit ?? 0);
      if (!Number.isFinite(amount) || amount === 0) continue;
      lines.push({ label: d.chargeLabel?.trim() || `Charge type ${ch.chargeType ?? "?"}`, amount: round2(amount) });
    }
  }

  const rate = parseChosenRate(order.parcelOption?.chosenRate);
  const carrierRate =
    rate?.amounts?.total !== undefined && Number.isFinite(Number(rate.amounts.total))
      ? round2(Number(rate.amounts.total))
      : null;

  return {
    transactionNumber: String(id),
    reference: order.referenceNum ?? null,
    shipping: shipping === null ? null : round2(shipping),
    lines,
    totalCharges: charges.length > 0 ? round2(total) : null,
    carrierService: rate?.serviceName ?? null,
    carrierRate,
  };
}
