// The send route refuses any email whose subject or body still contains an
// unfilled {{placeholder}} — five RMA approval emails reached real customers
// reading "{{total_value}}" before this existed.
//
// These tests pin the two things that keep the guard honest: the detector
// itself, and the fact that its opt-out is off unless a caller asks for it.

import { describe, expect, it } from "vitest";
import { sendBodySchema } from "./email-send.js";
import { findUnresolvedPlaceholders } from "../../modules/email-compose/index.js";

const minimalSend = {
  to: "customer@example.com",
  subject: "Credit memo DC38800",
  body: "Total credit: $39.79",
};

describe("send placeholder guard — opt-out default", () => {
  it("is off when the caller says nothing", () => {
    const parsed = sendBodySchema.parse(minimalSend);
    expect(parsed.allowUnrenderedPlaceholders).toBe(false);
  });

  it("is off when other optional fields are present", () => {
    const parsed = sendBodySchema.parse({
      ...minimalSend,
      cc: "boss@example.com",
      isHtml: true,
      customerId: "cus_1",
    });
    expect(parsed.allowUnrenderedPlaceholders).toBe(false);
  });

  it("turns on only when explicitly passed", () => {
    const parsed = sendBodySchema.parse({
      ...minimalSend,
      allowUnrenderedPlaceholders: true,
    });
    expect(parsed.allowUnrenderedPlaceholders).toBe(true);
  });
});

describe("send placeholder guard — what it catches", () => {
  it("catches the token that actually shipped to customers", () => {
    const body = "Total: {{total_value}}\n\nThanks,\nFeldart";
    expect(findUnresolvedPlaceholders("Your return request", body)).toEqual([
      "total_value",
    ]);
  });

  it("passes a fully rendered email", () => {
    expect(
      findUnresolvedPlaceholders(minimalSend.subject, minimalSend.body),
    ).toEqual([]);
  });

  it("catches a placeholder hiding in the subject alone", () => {
    expect(
      findUnresolvedPlaceholders("Credit memo {{credit_memo_doc_number}}", "ok"),
    ).toEqual(["credit_memo_doc_number"]);
  });
});
