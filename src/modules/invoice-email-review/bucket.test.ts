// Bucketing is the half of the email-review contract the route used to hold
// inline: which of the three lists a candidate row lands in, and what the
// wire row looks like. Extracted so it is testable without a DB or a Fastify
// harness — classification itself is covered in select.test.ts.
import { describe, expect, it } from "vitest";
import { bucketEmailReviewRows, type EmailReviewSourceRow } from "./bucket.js";

const NOW = new Date("2026-09-07T14:00:00Z");

// Sane default: NotSet, open, issued 5 days ago, created 4 days ago (past
// the 24h grace), no dismissal — i.e. a plain "never emailed" row.
function row(over: Partial<EmailReviewSourceRow> = {}): EmailReviewSourceRow {
  return {
    invoiceId: "inv_1",
    qbInvoiceId: "1001",
    docNumber: "10042",
    customerId: "cus_1",
    customerName: "Acme Judaica",
    origin: "feldart",
    issueDate: "2026-09-02",
    createdAt: new Date("2026-09-03T14:00:00Z"),
    total: "250.00",
    balance: "250.00",
    status: "open",
    emailStatus: "NotSet",
    deliveryTime: null,
    deliveryError: null,
    invoiceToEmails: ["ap@acme.test"],
    invoiceCcEmails: null,
    dismissReason: null,
    dismissNote: null,
    dismissedAt: null,
    dismissedBy: null,
    ...over,
  };
}

describe("bucketEmailReviewRows", () => {
  it("puts a plain NotSet invoice in neverEmailed and parses recipients", () => {
    const out = bucketEmailReviewRows(
      [
        row({
          // JSON columns are `unknown` at the boundary — non-strings dropped,
          // null becomes an empty array so the UI can always .join().
          invoiceToEmails: ["ap@acme.test", 42, null, "second@acme.test"],
          invoiceCcEmails: null,
        }),
      ],
      NOW,
    );
    expect(out.neverEmailed).toHaveLength(1);
    expect(out.deliveryFailed).toHaveLength(0);
    expect(out.dismissed).toHaveLength(0);
    expect(out.neverEmailed[0]?.recipients).toEqual({
      to: ["ap@acme.test", "second@acme.test"],
      cc: [],
    });
    expect(out.neverEmailed[0]?.dismissal).toBeNull();
  });

  it("puts a bounce in deliveryFailed even when the balance is zero", () => {
    const out = bucketEmailReviewRows(
      [
        row({
          emailStatus: "EmailSent",
          deliveryError: "Bounced Email",
          deliveryTime: new Date("2026-09-04T09:00:00Z"),
          balance: "0.00",
        }),
      ],
      NOW,
    );
    expect(out.deliveryFailed).toHaveLength(1);
    expect(out.neverEmailed).toHaveLength(0);
    expect(out.deliveryFailed[0]?.deliveryError).toBe("Bounced Email");
  });

  it("hides an actively dismissed row in dismissed[] with its dismissal", () => {
    const out = bucketEmailReviewRows(
      [
        row({
          dismissReason: "sent_elsewhere",
          dismissNote: null,
          dismissedAt: new Date("2026-09-05T10:00:00Z"),
          dismissedBy: "Joshua Ezekiel",
        }),
        row({
          invoiceId: "inv_2",
          emailStatus: "EmailSent",
          deliveryError: "Bounced Email",
          deliveryTime: new Date("2026-09-04T09:00:00Z"),
          dismissReason: "other",
          dismissNote: "posted it",
          dismissedAt: new Date("2026-09-05T10:00:00Z"),
          dismissedBy: "Joshua Ezekiel",
        }),
      ],
      NOW,
    );
    expect(out.dismissed.map((r) => r.invoiceId)).toEqual(["inv_1", "inv_2"]);
    expect(out.neverEmailed).toHaveLength(0);
    expect(out.deliveryFailed).toHaveLength(0);
    expect(out.dismissed[0]?.dismissal).toEqual({
      reason: "sent_elsewhere",
      reasonNote: null,
      dismissedAt: "2026-09-05T10:00:00.000Z",
      dismissedBy: "Joshua Ezekiel",
    });
    expect(out.dismissed[1]?.dismissal?.reasonNote).toBe("posted it");
  });

  it("re-surfaces a stale dismissal but keeps the dismissal on the row", () => {
    const out = bucketEmailReviewRows(
      [
        row({
          emailStatus: "EmailSent",
          deliveryError: "Undeliverable",
          // QBO recorded a NEWER send than the dismissal — the operator's
          // hide is spent.
          deliveryTime: new Date("2026-09-05T09:00:00Z"),
          dismissReason: "sent_elsewhere",
          dismissedAt: new Date("2026-09-03T10:00:00Z"),
          dismissedBy: "Joshua Ezekiel",
        }),
      ],
      NOW,
    );
    expect(out.deliveryFailed).toHaveLength(1);
    expect(out.dismissed).toHaveLength(0);
    expect(out.deliveryFailed[0]?.dismissal?.reason).toBe("sent_elsewhere");
  });

  it("never hides an undated bounce, dismissal or not", () => {
    const out = bucketEmailReviewRows(
      [
        row({
          emailStatus: "EmailSent",
          deliveryError: "Bounced Email",
          deliveryTime: null,
          dismissReason: "no_invoice_needed",
          dismissedAt: new Date("2026-09-06T10:00:00Z"),
          dismissedBy: "Joshua Ezekiel",
        }),
      ],
      NOW,
    );
    expect(out.deliveryFailed).toHaveLength(1);
    expect(out.dismissed).toHaveLength(0);
  });

  it("drops void, future-dated and still-in-grace rows from every bucket", () => {
    const out = bucketEmailReviewRows(
      [
        row({ invoiceId: "inv_void", status: "void" }),
        row({ invoiceId: "inv_future", issueDate: "2030-01-01" }),
        row({
          invoiceId: "inv_fresh",
          createdAt: new Date("2026-09-07T09:00:00Z"),
        }),
      ],
      NOW,
    );
    expect(out.neverEmailed).toHaveLength(0);
    expect(out.deliveryFailed).toHaveLength(0);
    expect(out.dismissed).toHaveLength(0);
  });

  it("serialises timestamps as ISO strings and passes issueDate through", () => {
    const out = bucketEmailReviewRows(
      [
        row({
          emailStatus: "EmailSent",
          deliveryError: "Bounced Email",
          // mysql2 hands back Date objects; the string form is what a driver
          // in string mode would give — both must come out as ISO.
          deliveryTime: "2026-09-04T09:00:00Z",
          createdAt: "2026-09-03T14:00:00Z",
          dismissReason: "other",
          dismissNote: "n",
          dismissedAt: "2026-09-03T08:00:00Z",
          dismissedBy: null,
        }),
      ],
      NOW,
    );
    const r = out.deliveryFailed[0];
    expect(r?.createdAt).toBe("2026-09-03T14:00:00.000Z");
    expect(r?.deliveryTime).toBe("2026-09-04T09:00:00.000Z");
    expect(r?.dismissal?.dismissedAt).toBe("2026-09-03T08:00:00.000Z");
    expect(r?.dismissal?.dismissedBy).toBeNull();
    // issue_date is a plain day string end to end — never re-parsed.
    expect(r?.issueDate).toBe("2026-09-02");
  });
});
