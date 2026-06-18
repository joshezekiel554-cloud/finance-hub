import { describe, expect, it } from "vitest";
import { bridgeContentNewlines, buildRawMessage } from "./send.js";

describe("buildRawMessage finance headers", () => {
  const base = {
    from: "a@feldart.com",
    to: "warehouse@bluechipfulfillment.com",
    subject: "HOLD ORDER 18672",
    text: "hold it",
  };

  // buildRawMessage returns the base64url-encoded MIME message; decode to
  // inspect the headers.
  const decode = (raw: string) =>
    Buffer.from(raw, "base64url").toString("utf8");

  it("emits the finance-send + customer-id headers when provided", () => {
    const msg = decode(
      buildRawMessage({
        ...base,
        financeSendType: "hold-alert",
        financeCustomerId: "f-uzwGCGbcE9sc8zVV0xUYUB",
      }),
    );
    expect(msg).toContain("X-Feldart-Finance-Send: hold-alert");
    expect(msg).toContain(
      "X-Feldart-Finance-Customer-Id: f-uzwGCGbcE9sc8zVV0xUYUB",
    );
  });

  it("omits the customer-id header when not provided", () => {
    const msg = decode(
      buildRawMessage({ ...base, financeSendType: "hold-alert" }),
    );
    expect(msg).not.toContain("X-Feldart-Finance-Customer-Id");
  });
});

// bridgeContentNewlines runs at the send chokepoint, so it protects EVERY
// finance email (statement, chase, compose, RMA, …) from collapsing bare
// newlines in an otherwise-HTML body (e.g. an operator-pasted invoice list).
describe("bridgeContentNewlines", () => {
  it("bridges single newlines between content (a run-on invoice list)", () => {
    const body =
      "Invoice #17426 $602.50 View and pay\nInvoice #17447 $240.00 View and pay\nInvoice #17481 $688.75 View and pay";
    const out = bridgeContentNewlines(body);
    // Both row boundaries become <br/> (consecutive rows, not every other one).
    expect(out.match(/<br\/>/g)?.length).toBe(2);
    expect(out).toContain("View and pay<br/>");
  });

  it("leaves tag-adjacent newlines alone (no double gaps in well-formed HTML)", () => {
    const html = "<p>Hi Mendy,</p>\n<p>Please find your statement.</p>";
    expect(bridgeContentNewlines(html)).toBe(html);
  });

  it("leaves blank-line paragraph breaks alone", () => {
    const text = "First line.\n\nSecond block.";
    expect(bridgeContentNewlines(text)).toBe(text);
  });

  it("does not bridge a newline immediately before a tag", () => {
    const html = "Total open balance is\n<strong>$21,114.24</strong>";
    expect(bridgeContentNewlines(html)).toBe(html);
  });
});
