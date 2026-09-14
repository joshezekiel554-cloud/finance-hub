import { describe, expect, it } from "vitest";
import {
  awaitingArrivalRmas,
  groupHolds,
  unsentTodayRows,
} from "./dashboard-derive.js";

// Pure derivations for the dashboard cards (no DOM test env in this repo,
// so the list logic lives here and the components stay thin).

describe("awaitingArrivalRmas", () => {
  it("keeps only RMAs that are approved / awaiting a number / at the warehouse, oldest-updated first", () => {
    const rows = [
      { id: "a", status: "draft", updatedAt: "2026-09-14T10:00:00Z" },
      { id: "b", status: "sent_to_warehouse", updatedAt: "2026-09-08T10:00:00Z" },
      { id: "c", status: "received", updatedAt: "2026-09-13T10:00:00Z" },
      { id: "d", status: "approved", updatedAt: "2026-09-12T10:00:00Z" },
      { id: "e", status: "awaiting_warehouse_number", updatedAt: "2026-09-01T10:00:00Z" },
    ];
    expect(awaitingArrivalRmas(rows).map((r) => r.id)).toEqual(["e", "b", "d"]);
  });
});

describe("groupHolds", () => {
  it("splits customers into on-hold and payment-upfront, each by overdue desc", () => {
    const rows = [
      { id: "1", holdStatus: "hold" as const, overdueBalance: "10.00" },
      { id: "2", holdStatus: "payment_upfront" as const, overdueBalance: "0.00" },
      { id: "3", holdStatus: "hold" as const, overdueBalance: "500.00" },
    ];
    const g = groupHolds(rows);
    expect(g.onHold.map((r) => r.id)).toEqual(["3", "1"]);
    expect(g.paymentUpfront.map((r) => r.id)).toEqual(["2"]);
  });
});

describe("unsentTodayRows", () => {
  it("keeps today's (London) rows that aren't dismissed and haven't been emailed", () => {
    const rows = [
      { gmailId: "g1", receivedAt: "2026-09-14T08:00:00Z", qbInvoice: { emailStatus: null } },
      { gmailId: "g2", receivedAt: "2026-09-14T09:00:00Z", qbInvoice: { emailStatus: "EmailSent" } },
      { gmailId: "g3", receivedAt: "2026-09-13T22:00:00Z", qbInvoice: null },
      { gmailId: "g4", receivedAt: "2026-09-14T11:00:00Z", qbInvoice: null },
      { gmailId: "g5", receivedAt: null, qbInvoice: null },
    ];
    const out = unsentTodayRows(rows, { g4: { reason: "x" } }, "2026-09-14");
    expect(out.map((r) => r.gmailId)).toEqual(["g1"]);
  });

  it("drops rows the server auto-hid (B2C paid-upfront sales receipts)", () => {
    const rows = [
      { gmailId: "g1", receivedAt: "2026-09-14T08:00:00Z", qbInvoice: null, autoHidden: "b2c_paid_upfront" },
      { gmailId: "g2", receivedAt: "2026-09-14T08:00:00Z", qbInvoice: null, autoHidden: null },
    ];
    expect(unsentTodayRows(rows, {}, "2026-09-14").map((r) => r.gmailId)).toEqual(["g2"]);
  });
});
