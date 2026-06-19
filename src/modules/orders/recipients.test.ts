import { beforeEach, describe, expect, it, vi } from "vitest";

// resolveHoldCustomerRecipients delegates the per-channel arrays to the shared
// customer-emails resolver; mock it so the Yiddy-CC + null-TO logic is
// assertable without a DB.
vi.mock("../customer-emails/recipients.js", () => ({
  resolveRecipients: vi.fn(),
}));

import { resolveRecipients } from "../customer-emails/recipients.js";
import {
  loadInternalHoldRecipients,
  resolveHoldCustomerRecipients,
  YIDDY_SALES_CC,
} from "./recipients.js";

const baseCustomer = {
  primaryEmail: null,
  billingEmails: null,
  invoiceToEmails: null,
  invoiceCcEmails: null,
  invoiceBccEmails: null,
  statementToEmails: null,
  statementCcEmails: null,
  statementBccEmails: null,
  tags: null,
};

describe("loadInternalHoldRecipients (warehouse + team merge)", () => {
  it("merges both lists, deduping addresses case-insensitively", () => {
    const out = loadInternalHoldRecipients({
      order_hold_warehouse_recipients: "warehouse@x.com, shared@x.com",
      order_hold_team_recipients: "team@x.com, SHARED@x.com",
    });
    expect(out).toBe("warehouse@x.com,shared@x.com,team@x.com");
  });

  it("handles an empty group on either side", () => {
    expect(
      loadInternalHoldRecipients({
        order_hold_warehouse_recipients: "",
        order_hold_team_recipients: "team@x.com",
      }),
    ).toBe("team@x.com");
    expect(
      loadInternalHoldRecipients({
        order_hold_warehouse_recipients: "wh@x.com",
        order_hold_team_recipients: "",
      }),
    ).toBe("wh@x.com");
  });

  it("returns empty string when both are empty", () => {
    expect(
      loadInternalHoldRecipients({
        order_hold_warehouse_recipients: "  ",
        order_hold_team_recipients: "",
      }),
    ).toBe("");
  });
});

describe("resolveHoldCustomerRecipients", () => {
  beforeEach(() => {
    vi.mocked(resolveRecipients).mockReset();
  });

  it("returns null when there is no usable TO address", async () => {
    vi.mocked(resolveRecipients).mockResolvedValueOnce({
      to: [],
      cc: [],
      bcc: [],
      bccReasons: [],
    });
    const out = await resolveHoldCustomerRecipients({ ...baseCustomer });
    expect(out).toBeNull();
  });

  it("falls back to primaryEmail when the resolver yields no TO", async () => {
    vi.mocked(resolveRecipients).mockResolvedValueOnce({
      to: [],
      cc: [],
      bcc: [],
      bccReasons: [],
    });
    const out = await resolveHoldCustomerRecipients({
      ...baseCustomer,
      primaryEmail: "fallback@x.com",
    });
    expect(out).toEqual({ to: "fallback@x.com", cc: "", bcc: "" });
  });

  it("adds the Yiddy sales CC exactly once", async () => {
    vi.mocked(resolveRecipients).mockResolvedValueOnce({
      to: ["cust@x.com"],
      cc: [],
      bcc: [],
      bccReasons: [],
    });
    const out = await resolveHoldCustomerRecipients({
      ...baseCustomer,
      tags: ["Yiddy"],
    });
    expect(out?.cc).toBe(YIDDY_SALES_CC);
  });

  it("does not duplicate the Yiddy CC if already present", async () => {
    vi.mocked(resolveRecipients).mockResolvedValueOnce({
      to: ["cust@x.com"],
      cc: [YIDDY_SALES_CC],
      bcc: [],
      bccReasons: [],
    });
    const out = await resolveHoldCustomerRecipients({
      ...baseCustomer,
      tags: ["yiddy"],
    });
    // CC stays a single entry — no second sales@ appended.
    expect(out?.cc).toBe(YIDDY_SALES_CC);
  });

  it("does not add the Yiddy CC for non-Yiddy customers", async () => {
    vi.mocked(resolveRecipients).mockResolvedValueOnce({
      to: ["cust@x.com"],
      cc: ["accounts@x.com"],
      bcc: [],
      bccReasons: [],
    });
    const out = await resolveHoldCustomerRecipients({
      ...baseCustomer,
      tags: ["vip"],
    });
    expect(out?.cc).toBe("accounts@x.com");
  });
});
