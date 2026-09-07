import { describe, expect, it } from "vitest";
import {
  classifyForEmailReview,
  EMAIL_REVIEW_GRACE_HOURS,
  EMAIL_REVIEW_WINDOW_DAYS,
  type EmailReviewCandidate,
} from "./select.js";

const NOW = new Date("2026-09-07T14:00:00Z");

function candidate(overrides: Partial<EmailReviewCandidate> = {}): EmailReviewCandidate {
  return {
    emailStatus: "NotSet",
    deliveryError: null,
    status: "sent",
    total: "195.00",
    balance: "195.00",
    issueDate: "2026-09-02",
    createdAt: new Date("2026-09-02T23:41:34Z"),
    dismissed: false,
    ...overrides,
  };
}

describe("classifyForEmailReview", () => {
  it("exports the documented constants", () => {
    expect(EMAIL_REVIEW_WINDOW_DAYS).toBe(90);
    expect(EMAIL_REVIEW_GRACE_HOURS).toBe(24);
  });

  it("NotSet + open + old enough → never_emailed", () => {
    expect(classifyForEmailReview(candidate(), NOW)).toBe("never_emailed");
  });

  it("NeedToSend counts the same as NotSet", () => {
    expect(classifyForEmailReview(candidate({ emailStatus: "NeedToSend" }), NOW)).toBe("never_emailed");
  });

  it("EmailSent with no error → null", () => {
    expect(classifyForEmailReview(candidate({ emailStatus: "EmailSent" }), NOW)).toBeNull();
  });

  it("NULL email_status (not yet synced) → null", () => {
    expect(classifyForEmailReview(candidate({ emailStatus: null }), NOW)).toBeNull();
  });

  it("voided → null even with an error", () => {
    expect(
      classifyForEmailReview(candidate({ status: "void", deliveryError: "Bounced Email" }), NOW),
    ).toBeNull();
  });

  it("zero total → null", () => {
    expect(classifyForEmailReview(candidate({ total: "0.00", balance: "0.00" }), NOW)).toBeNull();
  });

  it("paid (balance 0) never-emailed → null", () => {
    expect(classifyForEmailReview(candidate({ balance: "0.00" }), NOW)).toBeNull();
  });

  it("future issue date (2030 placeholder) → null", () => {
    expect(classifyForEmailReview(candidate({ issueDate: "2030-01-01" }), NOW)).toBeNull();
  });

  it("older than the window → null", () => {
    expect(classifyForEmailReview(candidate({ issueDate: "2026-06-01" }), NOW)).toBeNull();
  });

  it("issued exactly on the window edge is included", () => {
    // NOW is 2026-09-07; 90 days earlier is 2026-06-09.
    expect(classifyForEmailReview(candidate({ issueDate: "2026-06-09" }), NOW)).toBe("never_emailed");
  });

  it("created within the grace period → null (still in today's queue)", () => {
    expect(
      classifyForEmailReview(
        candidate({ issueDate: "2026-09-07", createdAt: new Date("2026-09-07T09:00:00Z") }),
        NOW,
      ),
    ).toBeNull();
  });

  it("accepts a Date for issueDate", () => {
    expect(classifyForEmailReview(candidate({ issueDate: new Date("2026-09-02T00:00:00Z") }), NOW)).toBe("never_emailed");
  });

  it("missing issueDate → null", () => {
    expect(classifyForEmailReview(candidate({ issueDate: null }), NOW)).toBeNull();
  });

  it("delivery error → delivery_failed even when paid", () => {
    expect(
      classifyForEmailReview(
        candidate({ emailStatus: "EmailSent", deliveryError: "Undeliverable", balance: "0.00" }),
        NOW,
      ),
    ).toBe("delivery_failed");
  });

  it("delivery error wins over NotSet", () => {
    expect(classifyForEmailReview(candidate({ deliveryError: "Bounced Email" }), NOW)).toBe("delivery_failed");
  });

  it("dismissed → null in either bucket", () => {
    expect(classifyForEmailReview(candidate({ dismissed: true }), NOW)).toBeNull();
    expect(
      classifyForEmailReview(candidate({ dismissed: true, deliveryError: "Bounced Email" }), NOW),
    ).toBeNull();
  });
});
