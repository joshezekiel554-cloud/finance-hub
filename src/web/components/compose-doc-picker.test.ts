import { describe, expect, it } from "vitest";
import {
  docRowFilename,
  docRowKey,
  docRowLabel,
  mapWithConcurrency,
  partitionBatch,
  remainingAttachmentSlots,
  MAX_ATTACHMENTS,
  type CustomerDocRow,
} from "./compose-doc-picker.js";

const row = (
  over: Partial<CustomerDocRow> & Pick<CustomerDocRow, "qbId">,
): CustomerDocRow => ({
  docType: "invoice",
  docNumber: null,
  issueDate: "2026-07-01",
  total: "100.00",
  balance: "100.00",
  ...over,
});

describe("docRowFilename", () => {
  it("names invoices and credit memos distinctly", () => {
    expect(docRowFilename(row({ qbId: "1", docNumber: "18843" }))).toBe(
      "Invoice-18843.pdf",
    );
    expect(
      docRowFilename(
        row({ qbId: "2", docNumber: "CM-9", docType: "credit_memo" }),
      ),
    ).toBe("CreditMemo-CM-9.pdf");
  });

  it("falls back to the QB id when the doc number is missing", () => {
    expect(docRowFilename(row({ qbId: "77" }))).toBe("Invoice-77.pdf");
  });
});

describe("docRowKey / docRowLabel", () => {
  it("keys by type + qb id so an invoice and CM sharing an id don't collide", () => {
    expect(docRowKey(row({ qbId: "5" }))).toBe("invoice:5");
    expect(docRowKey(row({ qbId: "5", docType: "credit_memo" }))).toBe(
      "credit_memo:5",
    );
  });

  it("labels rows for the failure message", () => {
    expect(docRowLabel(row({ qbId: "5", docNumber: "18843" }))).toBe(
      "Inv 18843",
    );
    expect(
      docRowLabel(row({ qbId: "5", docNumber: "9", docType: "credit_memo" })),
    ).toBe("CM 9");
  });
});

describe("mapWithConcurrency", () => {
  it("returns results in input order", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 12 }, (_, i) => i),
      3,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return n;
      },
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("handles an empty list without spawning runners", async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });

  it("visits every item exactly once", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 4, async (n) => {
      seen.push(n);
      return n;
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("remainingAttachmentSlots", () => {
  it("counts down from the server's cap", () => {
    expect(remainingAttachmentSlots(0)).toBe(MAX_ATTACHMENTS);
    expect(remainingAttachmentSlots(18)).toBe(2);
    expect(remainingAttachmentSlots(MAX_ATTACHMENTS)).toBe(0);
  });

  it("never goes negative when the draft is already over cap", () => {
    expect(remainingAttachmentSlots(MAX_ATTACHMENTS + 5)).toBe(0);
  });
});

describe("partitionBatch", () => {
  const ok = row({ qbId: "1", docNumber: "100" });
  const bad = row({ qbId: "2", docNumber: "200" });

  it("keeps successes and names failures", () => {
    const out = partitionBatch([
      { row: ok, file: "FILE-A", error: null },
      { row: bad, file: null, error: "HTTP 502" },
    ]);
    expect(out.files).toEqual(["FILE-A"]);
    expect(out.attachedKeys).toEqual(["invoice:1"]);
    expect(out.failedLabels).toEqual(["Inv 200"]);
    expect(out.errorMessage).toBe("Couldn't fetch 1 of 2: Inv 200");
  });

  it("reports no error when everything lands", () => {
    const out = partitionBatch([{ row: ok, file: "FILE-A", error: null }]);
    expect(out.errorMessage).toBeNull();
    expect(out.failedLabels).toEqual([]);
  });

  it("attaches nothing and un-ticks nothing when every fetch fails", () => {
    const out = partitionBatch<string>([
      { row: ok, file: null, error: "boom" },
      { row: bad, file: null, error: "boom" },
    ]);
    expect(out.files).toEqual([]);
    expect(out.attachedKeys).toEqual([]);
    expect(out.errorMessage).toBe("Couldn't fetch 2 of 2: Inv 100, Inv 200");
  });
});
