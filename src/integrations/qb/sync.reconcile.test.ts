// Unit tests for selectInvoicesToVoid — the pure decision function behind
// the invoice-deletion reconciliation step in syncInvoices / syncOneCustomer.
//
// Backstory: the QB→DB sync was upsert-only. An invoice DELETED in QBO
// disappears from `SELECT * FROM Invoice`, so its local row was never
// touched again and lingered at its last-synced balance — still showing in
// the invoices list, the open-invoice count, and (via balance > 0) on
// statements. This function decides which local rows have gone missing from
// QBO and should be soft-voided.

import { describe, expect, it } from "vitest";
import { selectInvoicesToVoid } from "./sync.js";

type Row = Parameters<typeof selectInvoicesToVoid>[0][number];

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "inv-1",
    qbInvoiceId: "qb-1",
    status: "sent",
    balance: "59.00",
    ...overrides,
  };
}

describe("selectInvoicesToVoid", () => {
  it("returns local invoices whose qbInvoiceId is absent from the QBO set", () => {
    const local = [
      row({ id: "a", qbInvoiceId: "qb-a" }),
      row({ id: "b", qbInvoiceId: "qb-b" }), // deleted in QBO
    ];
    const present = new Set(["qb-a"]);
    const result = selectInvoicesToVoid(local, present);
    expect(result.map((r) => r.id)).toEqual(["b"]);
  });

  it("returns nothing when every local invoice is still present in QBO", () => {
    const local = [row({ id: "a", qbInvoiceId: "qb-a" })];
    const present = new Set(["qb-a", "qb-extra"]);
    expect(selectInvoicesToVoid(local, present)).toEqual([]);
  });

  it("ignores invoices already marked void (idempotent — no re-void churn)", () => {
    const local = [
      row({ id: "a", qbInvoiceId: "qb-a", status: "void", balance: "0.00" }),
    ];
    const present = new Set<string>(); // a is absent, but already void
    expect(selectInvoicesToVoid(local, present)).toEqual([]);
  });

  it("voids every non-void local invoice when the QBO set is empty (per-customer all-deleted case)", () => {
    const local = [
      row({ id: "a", qbInvoiceId: "qb-a", status: "sent" }),
      row({ id: "b", qbInvoiceId: "qb-b", status: "void" }),
    ];
    const result = selectInvoicesToVoid(local, new Set());
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });
});
