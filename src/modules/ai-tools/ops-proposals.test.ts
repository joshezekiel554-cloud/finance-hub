import { describe, expect, it } from "vitest";
import { decideSettle, type ProposalView } from "./ops-proposals.js";
import { HUB_WRITE_TOOLS, OPS_FINANCE_WRITES } from "./ops-finance-writes.js";
import { getToolByName } from "../ai-agent/tools.js";

const NOW = new Date("2026-11-04T12:00:00Z");
const JOSH = "joshezekiel554@gmail.com";

const row = (over: Partial<ProposalView> = {}): ProposalView => ({
  status: "drafted",
  createdAt: new Date(NOW.getTime() - 60_000),
  candidateSummary: { via: "hub", hubActor: JOSH, summary: "set hold status · targetState=hold" },
  draftedAction: { tool: "set_hold_status", args: { customerId: "c1", targetState: "hold" } },
  executionError: null,
  ...over,
});

const reply = (d: ReturnType<typeof decideSettle>) => (d.kind === "reply" ? { http: d.reply.http, ...d.reply.body } : d.kind);

describe("hub proposal settle rules", () => {
  it("lets the creator confirm or cancel a fresh drafted proposal", () => {
    expect(decideSettle(row(), "confirm", JOSH, NOW)).toEqual({ kind: "proceed" });
    expect(decideSettle(row(), "cancel", " JoshEzekiel554@gmail.com ", NOW)).toEqual({ kind: "proceed" });
  });

  it("refuses anyone else, unknown or non-hub rows, and stale cards", () => {
    expect(reply(decideSettle(row(), "confirm", "leibel@feldartcollection.co.uk", NOW))).toMatchObject({ http: 403, code: "forbidden" });
    expect(reply(decideSettle(null, "confirm", JOSH, NOW))).toMatchObject({ http: 410, code: "expired" });
    expect(reply(decideSettle(row({ candidateSummary: { hubActor: JOSH } }), "confirm", JOSH, NOW))).toMatchObject({ http: 410 });
    expect(reply(decideSettle(row({ createdAt: new Date(NOW.getTime() - 16 * 60_000) }), "confirm", JOSH, NOW))).toMatchObject({ http: 410, code: "expired" });
    expect(reply(decideSettle(row({ status: "expired" }), "confirm", JOSH, NOW))).toMatchObject({ http: 410 });
  });

  it("is idempotent and honest after the fact", () => {
    expect(reply(decideSettle(row({ status: "executed" }), "confirm", JOSH, NOW))).toMatchObject({ http: 200, status: "applied" });
    expect(reply(decideSettle(row({ status: "executed" }), "cancel", JOSH, NOW))).toMatchObject({ http: 409, code: "stale" });
    expect(reply(decideSettle(row({ status: "rejected" }), "cancel", JOSH, NOW))).toMatchObject({ http: 200, status: "cancelled" });
    expect(reply(decideSettle(row({ status: "rejected" }), "confirm", JOSH, NOW))).toMatchObject({ http: 409, code: "stale" });
    expect(reply(decideSettle(row({ status: "execution_failed", executionError: "gmail 500" }), "confirm", JOSH, NOW))).toMatchObject({ http: 502, code: "failed" });
    expect(decideSettle(row({ status: "approved" }), "confirm", JOSH, NOW)).toEqual({ kind: "wait" });
    expect(reply(decideSettle(row({ status: "approved" }), "cancel", JOSH, NOW))).toMatchObject({ http: 409 });
  });

  it("never confirms a dangerous action (QBO void) from the hub", () => {
    const voidRow = row({ draftedAction: { tool: "dispute_transition", args: { invoiceId: "i1", action: "paid_void" } } });
    expect(reply(decideSettle(voidRow, "confirm", JOSH, NOW))).toMatchObject({ http: 403, code: "forbidden" });
    expect(decideSettle(voidRow, "cancel", JOSH, NOW)).toEqual({ kind: "proceed" });
  });
});

describe("hub write tools", () => {
  it("every one is ops + write, has an executor, and says nothing happens until Confirm", () => {
    expect(OPS_FINANCE_WRITES.map((t) => t.name)).toEqual([...HUB_WRITE_TOOLS, "update_customer_emails", "send_invoice_qbo", "dismiss_email_review", "save_rma_tracking"]);
    for (const t of OPS_FINANCE_WRITES) {
      expect(t.ops && t.write).toBe(true);
      expect(getToolByName(t.name)).not.toBeNull();
      expect(t.description).toMatch(/until the user presses Confirm/);
      expect(t.input_schema.additionalProperties).toBe(false);
    }
  });

  it("doesn't offer QBO voids or the inbox's create_task", () => {
    const names = OPS_FINANCE_WRITES.map((t) => t.name);
    expect(names).not.toContain("create_task");
    const dispute = OPS_FINANCE_WRITES.find((t) => t.name === "dispute_transition")!;
    const action = (dispute.input_schema.properties as Record<string, { enum: string[] }>).action;
    expect(action?.enum).toEqual(["claims_paid", "not_paid"]);
  });

  it("refuses a void even if the model sends one anyway", async () => {
    const dispute = OPS_FINANCE_WRITES.find((t) => t.name === "dispute_transition")!;
    await expect(
      dispute.run({ invoiceId: "i1", action: "paid_void" }, { now: NOW, baseUrl: "https://f", actorEmail: JOSH }),
    ).rejects.toThrow(/can't be done from chat/);
  });

  it("refuses without a hub member", async () => {
    await expect(OPS_FINANCE_WRITES[0]!.run({}, { now: NOW, baseUrl: "https://f" })).rejects.toThrow(/signed-in member/);
  });
});

describe("hub-only guard + stale check", () => {
  it("recognises hub proposals and nothing else", async () => {
    const { isHubProposal } = await import("./hub-proposal-guard.js");
    expect(isHubProposal({ candidateSummary: { via: "hub" } })).toBe(true);
    expect(isHubProposal({ candidateSummary: { via: "scan" } })).toBe(false);
    expect(isHubProposal({ candidateSummary: {} })).toBe(false);
    expect(isHubProposal(null)).toBe(false);
  });

  it("names the first field that moved since the card was shown", async () => {
    const { previewDrift } = await import("./ops-finance-writes.js");
    const shown = [
      { field: "Customer", value: "Acme" },
      { field: "Overdue now", value: "Feldart $500.00 · Torah Judaica $0.00" },
    ];
    expect(previewDrift(shown, shown)).toBeNull();
    expect(previewDrift(shown, [shown[0]!, { field: "Overdue now", value: "Feldart $0.00 · Torah Judaica $0.00" }])).toBe(
      'Overdue now: "Feldart $500.00 · Torah Judaica $0.00" → "Feldart $0.00 · Torah Judaica $0.00"',
    );
    expect(previewDrift(shown, [shown[0]!])).toMatch(/^Overdue now: .* → "—"$/);
  });
});

describe("customer email changes", () => {
  it("flags domains the customer has never used (invoice-redirect guard)", async () => {
    const { newDomains } = await import("./ops-finance-writes.js");
    expect(newDomains(["a@keterjudaica.com", "b@yefenofbooks.com"], ["c@keterjudaica.com"])).toEqual([]);
    expect(newDomains(["a@keterjudaica.com"], ["x@gmail.com", "y@Gmail.com", "z@keterjudaica.com"])).toEqual(["gmail.com"]);
    expect(newDomains([], ["x@new.com"])).toEqual(["new.com"]);
  });

  it("validates addresses and needs at least one list", async () => {
    const { UpdateCustomerEmailsArgs } = await import("../ai-agent/tools.js");
    expect(UpdateCustomerEmailsArgs.safeParse({ customerId: "c1" }).success).toBe(false);
    expect(UpdateCustomerEmailsArgs.safeParse({ customerId: "c1", invoiceTo: ["not-an-email"] }).success).toBe(false);
    const ok = UpdateCustomerEmailsArgs.safeParse({ customerId: "c1", invoiceTo: [" A@Keter.com "], statementCc: [] });
    expect(ok.success && ok.data.invoiceTo).toEqual(["a@keter.com"]);
  });
});

describe("invoice-redirect (BEC) guard", () => {
  it("a new-domain address change needs a finance admin; same-domain fixes don't", async () => {
    const { needsAdmin, isFinanceAdmin, NEW_DOMAIN_ROW } = await import("./ops-finance-writes.js");
    const newDomainCard = [{ field: NEW_DOMAIN_ROW, value: "gmail.com — …" }, { field: "Invoice To", value: "a@keter.com  →  x@gmail.com" }];
    const sameDomainCard = [{ field: "Invoice To", value: "a@keter.com  →  b@keter.com" }];
    expect(needsAdmin("update_customer_emails", newDomainCard)).toBe(true);
    expect(needsAdmin("update_customer_emails", sameDomainCard)).toBe(false);
    expect(needsAdmin("send_statement", newDomainCard)).toBe(false);
    const admins = "joshezekiel554@gmail.com,shaya@feldart.com";
    expect(isFinanceAdmin("JoshEzekiel554@gmail.com", admins)).toBe(true);
    expect(isFinanceAdmin("customprints@feldartcollection.co.uk", admins)).toBe(false);
    expect(isFinanceAdmin(undefined, admins)).toBe(false);
  });
});
