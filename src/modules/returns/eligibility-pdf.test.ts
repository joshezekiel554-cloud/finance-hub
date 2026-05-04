// Minimal smoke tests for the eligibility PDF generator.
// We verify that the function returns a non-empty Buffer that starts with
// the PDF magic bytes "%PDF" — content layout is eyeball-tested via the
// preview route, not here.

import { describe, expect, it } from "vitest";
import { generateEligibilityPdf } from "./eligibility-pdf.js";
import type { EligibilityPdfInput } from "./eligibility-pdf.js";

const FROZEN_BREAKDOWN = {
  customerSeasonalPurchases: "1000.00",
  alreadyReturnedThisSeason: "0.00",
  proposedCurrentSeason: "400.00",
  proposedPriorSeason: "0.00",
  proposedNonSeasonal: "0.00",
  proposedSubtotalCountingTowardThreshold: "400.00",
  totalReturnsThisSeason: "400.00",
  cumulativeReturnPct: "40.00",
  thresholdPct: "50.00",
  passesThreshold: true,
  perInvoice: [
    {
      invoiceDocNumber: "18001",
      invoiceDate: "2026-03-15",
      amount: "1000.00",
    },
  ],
};

function makeInput(overrides: Partial<EligibilityPdfInput> = {}): EligibilityPdfInput {
  return {
    rma: { id: "rma-1", rmaNumber: "RMA-2026-001" },
    customer: { name: "Acme Judaica Ltd" },
    season: { name: "Pesach 2026" },
    breakdown: FROZEN_BREAKDOWN,
    items: [
      {
        sku: "MUG-GOLD",
        name: "Gold Passover Mug",
        quantity: "2",
        unitPrice: "100.00",
        lineTotal: "200.00",
        classification: "seasonal_current",
      },
      {
        sku: "PLATE-SED",
        name: "Seder Plate",
        quantity: "1",
        unitPrice: "200.00",
        lineTotal: "200.00",
        classification: "seasonal_current",
      },
    ],
    ...overrides,
  };
}

describe("generateEligibilityPdf", () => {
  it("returns a non-empty Buffer starting with PDF magic bytes for a passing RMA", async () => {
    const buf = await generateEligibilityPdf(makeInput());
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBeGreaterThan(1000);
    expect(buf.slice(0, 4).toString("utf-8")).toBe("%PDF");
  });

  it("renders correctly for a failing (over-threshold) RMA", async () => {
    const buf = await generateEligibilityPdf(
      makeInput({
        breakdown: {
          ...FROZEN_BREAKDOWN,
          proposedCurrentSeason: "600.00",
          proposedSubtotalCountingTowardThreshold: "600.00",
          totalReturnsThisSeason: "600.00",
          cumulativeReturnPct: "60.00",
          passesThreshold: false,
        },
      }),
    );
    expect(buf.slice(0, 4).toString("utf-8")).toBe("%PDF");
  });

  it("renders with a draft RMA (no rmaNumber)", async () => {
    const buf = await generateEligibilityPdf(
      makeInput({
        rma: { id: "rma-draft", rmaNumber: null },
      }),
    );
    expect(buf.slice(0, 4).toString("utf-8")).toBe("%PDF");
  });

  it("renders with prior-season and non-seasonal items", async () => {
    const buf = await generateEligibilityPdf(
      makeInput({
        breakdown: {
          ...FROZEN_BREAKDOWN,
          proposedCurrentSeason: "200.00",
          proposedPriorSeason: "100.00",
          proposedNonSeasonal: "150.00",
          proposedSubtotalCountingTowardThreshold: "300.00",
          totalReturnsThisSeason: "300.00",
          cumulativeReturnPct: "30.00",
          passesThreshold: true,
        },
        items: [
          {
            sku: "MUG-GOLD",
            name: "Gold Passover Mug",
            quantity: "2",
            unitPrice: "100.00",
            lineTotal: "200.00",
            classification: "seasonal_current",
          },
          {
            sku: "OLD-PLATE",
            name: "Prior Seder Plate",
            quantity: "1",
            unitPrice: "100.00",
            lineTotal: "100.00",
            classification: "seasonal_prior",
          },
          {
            sku: "NONSEASON",
            name: "Regular Candle",
            quantity: "3",
            unitPrice: "50.00",
            lineTotal: "150.00",
            classification: "non_seasonal",
          },
        ],
      }),
    );
    expect(buf.slice(0, 4).toString("utf-8")).toBe("%PDF");
  });

  it("renders with no perInvoice entries (empty purchases)", async () => {
    const buf = await generateEligibilityPdf(
      makeInput({
        breakdown: {
          ...FROZEN_BREAKDOWN,
          customerSeasonalPurchases: "0.00",
          cumulativeReturnPct: "0.00",
          passesThreshold: true,
          perInvoice: [],
        },
      }),
    );
    expect(buf.slice(0, 4).toString("utf-8")).toBe("%PDF");
  });
});
