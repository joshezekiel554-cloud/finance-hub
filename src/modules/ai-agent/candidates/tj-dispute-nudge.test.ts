import { beforeEach, describe, expect, it, vi } from "vitest";

// Default loaders hit the DB (invoices join, email_log, app_settings) — mock
// the pool; behavioural tests inject deps (winddown-style DI seams).
vi.mock("../../../db/index.js", () => ({ db: { select: vi.fn() } }));

import { db } from "../../../db/index.js";
import {
  findCandidates,
  isStillEligible,
  NUDGE_SILENCE_DAYS,
  summarizeDisputePipeline,
  type VerifyingInvoiceRow,
} from "./tj-dispute-nudge.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-10T12:00:00.000Z");

function daysBeforeNow(n: number): Date {
  return new Date(NOW.getTime() - n * DAY_MS);
}

function makeRow(overrides: Partial<VerifyingInvoiceRow> = {}): VerifyingInvoiceRow {
  return {
    invoiceId: "inv-tj-1",
    docNumber: "20455",
    customerId: "cust-1",
    customerName: "Claims Paid Co",
    balance: "850.00",
    disputeClaimedAt: daysBeforeNow(12),
    disputeNote: "Says cheque #1042 cleared in March",
    bookkeeperThreadId: null,
    ...overrides,
  };
}

const noThreads = async () => new Map<string, Date>();
const noBookkeeper = async () => ({ email: null, name: null });
const bookkeeper = async () => ({
  email: "books@torahjudaica.example",
  name: "Rivka",
});

beforeEach(() => {
  vi.mocked(db.select).mockReset();
});

// ── findCandidates ───────────────────────────────────────────────────────────

describe("tj-dispute-nudge findCandidates", () => {
  it("linked thread silent 8 days → follow-up nudge with daysSilent", async () => {
    const lastEmail = daysBeforeNow(8);
    const results = await findCandidates({
      loadVerifyingInvoices: async () => [
        makeRow({ bookkeeperThreadId: "thread-1" }),
      ],
      loadLatestThreadEmailDates: async () =>
        new Map([["thread-1", lastEmail]]),
      loadBookkeeperContact: bookkeeper,
      now: NOW,
    });

    expect(results).toHaveLength(1);
    const c = results[0]!;
    expect(c.entityType).toBe("invoice");
    expect(c.entityId).toBe("inv-tj-1");
    expect(c.origin).toBe("tj");
    expect(c.summary).toMatchObject({
      invoiceId: "inv-tj-1",
      docNumber: "20455",
      customerId: "cust-1",
      customerName: "Claims Paid Co",
      balance: 850,
      claimedAt: daysBeforeNow(12).toISOString(),
      disputeNote: "Says cheque #1042 cleared in March",
      hasBookkeeperThread: true,
      needsFirstEmail: false,
      daysSilent: 8,
      lastThreadEmailAt: lastEmail.toISOString(),
      recipient: "bookkeeper",
      bookkeeperEmail: "books@torahjudaica.example",
      bookkeeperName: "Rivka",
    });
  });

  it("silence boundary: exactly 7 days → nudge (silent ≥ 7d)", async () => {
    const results = await findCandidates({
      loadVerifyingInvoices: async () => [
        makeRow({ bookkeeperThreadId: "thread-1" }),
      ],
      loadLatestThreadEmailDates: async () =>
        new Map([["thread-1", daysBeforeNow(NUDGE_SILENCE_DAYS)]]),
      loadBookkeeperContact: noBookkeeper,
      now: NOW,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.summary.daysSilent).toBe(7);
  });

  it("thread active (under 7 days) → no candidate", async () => {
    const results = await findCandidates({
      loadVerifyingInvoices: async () => [
        makeRow({ bookkeeperThreadId: "thread-1" }),
      ],
      loadLatestThreadEmailDates: async () =>
        new Map([["thread-1", new Date(NOW.getTime() - (7 * DAY_MS - 60_000))]]),
      loadBookkeeperContact: noBookkeeper,
      now: NOW,
    });
    expect(results).toHaveLength(0);
  });

  it("no bookkeeper thread → 'needs first bookkeeper email' candidate", async () => {
    const results = await findCandidates({
      loadVerifyingInvoices: async () => [makeRow({ bookkeeperThreadId: null })],
      loadLatestThreadEmailDates: noThreads,
      loadBookkeeperContact: noBookkeeper,
      now: NOW,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.summary).toMatchObject({
      hasBookkeeperThread: false,
      needsFirstEmail: true,
      daysSilent: null,
      lastThreadEmailAt: null,
      bookkeeperEmail: null,
      bookkeeperName: null,
    });
  });

  it("linked thread with NO email_log rows → no candidate (cannot prove silence)", async () => {
    // The just-sent bookkeeper email may not have been ingested by the
    // gmail poller yet — absence of rows is not evidence of silence.
    const results = await findCandidates({
      loadVerifyingInvoices: async () => [
        makeRow({ bookkeeperThreadId: "thread-unpolled" }),
      ],
      loadLatestThreadEmailDates: noThreads,
      loadBookkeeperContact: noBookkeeper,
      now: NOW,
    });
    expect(results).toHaveLength(0);
  });

  it("zero-balance rows are filtered defensively", async () => {
    const results = await findCandidates({
      loadVerifyingInvoices: async () => [makeRow({ balance: "0.00" })],
      loadLatestThreadEmailDates: noThreads,
      loadBookkeeperContact: noBookkeeper,
      now: NOW,
    });
    expect(results).toHaveLength(0);
  });

  it("one candidate per INVOICE — two verifying invoices for one customer → two candidates", async () => {
    const results = await findCandidates({
      loadVerifyingInvoices: async () => [
        makeRow({ invoiceId: "inv-a", docNumber: "20001" }),
        makeRow({ invoiceId: "inv-b", docNumber: "20002" }),
      ],
      loadLatestThreadEmailDates: noThreads,
      loadBookkeeperContact: noBookkeeper,
      now: NOW,
    });
    expect(results.map((r) => r.entityId)).toEqual(["inv-a", "inv-b"]);
  });

  it("thread lookup only queries linked threads", async () => {
    const loadLatest = vi.fn(noThreads);
    await findCandidates({
      loadVerifyingInvoices: async () => [
        makeRow({ invoiceId: "inv-a", bookkeeperThreadId: "t-1" }),
        makeRow({ invoiceId: "inv-b", bookkeeperThreadId: null }),
      ],
      loadLatestThreadEmailDates: loadLatest,
      loadBookkeeperContact: noBookkeeper,
      now: NOW,
    });
    expect(loadLatest).toHaveBeenCalledWith(["t-1"]);
  });
});

// ── summarizeDisputePipeline (chase digest TJ wind-down line, W2 T6) ─────────

describe("tj-dispute-nudge summarizeDisputePipeline", () => {
  it("empty pipeline → all zeros (no thread lookup)", async () => {
    const loadLatest = vi.fn(noThreads);
    const summary = await summarizeDisputePipeline({
      loadVerifyingInvoices: async () => [],
      loadLatestThreadEmailDates: loadLatest,
      now: NOW,
    });
    expect(summary).toEqual({
      verifying: 0,
      awaitingFirstEmail: 0,
      silentThreads: 0,
    });
    expect(loadLatest).not.toHaveBeenCalled();
  });

  it("counts verifying / awaiting-first-email / silent with the finder's semantics", async () => {
    // 5 verifying invoices: 2 with no thread (awaiting first email), 1 silent
    // 8d, 1 active 2d, 1 linked but unpolled (no email_log rows → neither).
    const summary = await summarizeDisputePipeline({
      loadVerifyingInvoices: async () => [
        makeRow({ invoiceId: "inv-a", bookkeeperThreadId: null }),
        makeRow({ invoiceId: "inv-b", bookkeeperThreadId: null }),
        makeRow({ invoiceId: "inv-c", bookkeeperThreadId: "t-silent" }),
        makeRow({ invoiceId: "inv-d", bookkeeperThreadId: "t-active" }),
        makeRow({ invoiceId: "inv-e", bookkeeperThreadId: "t-unpolled" }),
      ],
      loadLatestThreadEmailDates: async () =>
        new Map([
          ["t-silent", daysBeforeNow(8)],
          ["t-active", daysBeforeNow(2)],
        ]),
      now: NOW,
    });
    expect(summary).toEqual({
      verifying: 5,
      awaitingFirstEmail: 2,
      silentThreads: 1,
    });
  });

  it("silence boundary: exactly 7 days counts as silent (≥)", async () => {
    const summary = await summarizeDisputePipeline({
      loadVerifyingInvoices: async () => [
        makeRow({ bookkeeperThreadId: "t-1" }),
      ],
      loadLatestThreadEmailDates: async () =>
        new Map([["t-1", daysBeforeNow(NUDGE_SILENCE_DAYS)]]),
      now: NOW,
    });
    expect(summary.silentThreads).toBe(1);
  });

  it("zero-balance rows are excluded from every count", async () => {
    const summary = await summarizeDisputePipeline({
      loadVerifyingInvoices: async () => [
        makeRow({ invoiceId: "inv-a", balance: "0.00", bookkeeperThreadId: null }),
        makeRow({ invoiceId: "inv-b" }),
      ],
      loadLatestThreadEmailDates: noThreads,
      now: NOW,
    });
    expect(summary).toEqual({
      verifying: 1,
      awaitingFirstEmail: 1,
      silentThreads: 0,
    });
  });
});

// ── isStillEligible ──────────────────────────────────────────────────────────

describe("tj-dispute-nudge isStillEligible", () => {
  const base = {
    id: "inv-tj-1",
    origin: "tj" as const,
    disputeState: "verifying" as const,
    balance: "850.00",
  };

  it("true while the invoice is still verifying with balance", async () => {
    expect(
      await isStillEligible("inv-tj-1", { loadInvoice: async () => base }),
    ).toBe(true);
  });

  it("false when the dispute moved on (confirmed_unpaid)", async () => {
    expect(
      await isStillEligible("inv-tj-1", {
        loadInvoice: async () => ({ ...base, disputeState: "confirmed_unpaid" }),
      }),
    ).toBe(false);
  });

  it("false when the balance reached zero", async () => {
    expect(
      await isStillEligible("inv-tj-1", {
        loadInvoice: async () => ({ ...base, balance: "0.00" }),
      }),
    ).toBe(false);
  });

  it("false when the invoice is gone", async () => {
    expect(
      await isStillEligible("ghost", { loadInvoice: async () => null }),
    ).toBe(false);
  });

  it("false for a non-TJ invoice", async () => {
    expect(
      await isStillEligible("inv-f", {
        loadInvoice: async () => ({ ...base, origin: "feldart" }),
      }),
    ).toBe(false);
  });
});
