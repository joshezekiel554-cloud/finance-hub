import { describe, expect, it } from "vitest";
import { bridgeContentNewlines } from "./send.js";

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
