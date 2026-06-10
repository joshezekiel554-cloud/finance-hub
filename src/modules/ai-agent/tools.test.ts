import { beforeEach, describe, expect, it, vi } from "vitest";

// At-most-once send guarantee (osplit2 W2 T3 review): the autopilot execute
// queue retries failed jobs (attempts: 3 in jobs/queues.ts). If a tool threw
// AFTER sendEmail succeeded, the retry would re-send the email — so once a
// messageId exists, post-send bookkeeping failures must be logged and
// swallowed (ok:true + note), never returned as ok:false.

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({
    error: logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("../../db/index.js", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));
vi.mock("../../integrations/gmail/send.js", () => ({ sendEmail: vi.fn() }));
vi.mock("../email-compose/signatures.js", () => ({
  appendSignatures: vi.fn(async () => "<p>body</p>"),
}));
vi.mock("../statements/send.js", () => ({ sendStatement: vi.fn() }));
vi.mock("../statements/settings.js", () => ({ loadAppSettings: vi.fn() }));
vi.mock("../crm/auto-action-emails.js", () => ({
  autoActionPriorInbounds: vi.fn(async () => undefined),
}));
vi.mock("../../server/lib/bookkeeper-thread-link.js", () => ({
  linkBookkeeperThread: vi.fn(async () => undefined),
}));

import { db } from "../../db/index.js";
import { sendEmail } from "../../integrations/gmail/send.js";
import { loadAppSettings } from "../statements/settings.js";
import { getToolByName } from "./tools.js";

type Mock = ReturnType<typeof vi.fn>;

function selectChain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "innerJoin"]) {
    c[m] = vi.fn(() => c);
  }
  c["limit"] = vi.fn(() => Promise.resolve(rows));
  return c as unknown as ReturnType<typeof db.select>;
}

const ctx = { userId: "user-1", proposalId: "prop-1" };

beforeEach(() => {
  vi.mocked(db.select).mockReset();
  vi.mocked(db.insert).mockReset();
  vi.mocked(sendEmail).mockReset();
  vi.mocked(loadAppSettings).mockReset();
  logError.mockReset();
});

describe("send_chase_email at-most-once send", () => {
  const args = {
    customerId: "cust-1",
    tier: "HIGH",
    origin: "feldart",
    subject: "Overdue balance",
    body: "<p>Please pay.</p>",
  };

  it("post-send write failure ⇒ ok:true + note, failure logged (no retry re-send)", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([{ id: "cust-1", primaryEmail: "c@example.com" }]),
    );
    vi.mocked(sendEmail).mockResolvedValueOnce({
      messageId: "m-1",
      threadId: "t-1",
      from: "accounts@feldart.com",
    } as never);
    // email_log insert throws AFTER the email went out.
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error("db down")),
    } as never);

    const tool = getToolByName("send_chase_email")!;
    const result = await tool.execute(args, ctx);

    expect(result.ok).toBe(true);
    expect(result.ok && result.note).toContain("email_log insert");
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "prop-1",
        messageId: "m-1",
        failedWrite: "email_log insert",
      }),
      expect.stringContaining("post-send bookkeeping failed"),
    );
  });

  it("pre-send failure stays fatal (ok:false) so the retry CAN re-attempt", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([{ id: "cust-1", primaryEmail: "c@example.com" }]),
    );
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("gmail 502"));

    const tool = getToolByName("send_chase_email")!;
    const result = await tool.execute(args, ctx);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("gmail 502");
  });
});

describe("send_bookkeeper_email at-most-once send", () => {
  const args = {
    invoiceId: "inv-1",
    subject: "Invoice 20455 — paid?",
    body: "<p>Can you check?</p>",
  };

  it("post-send write failure ⇒ ok:true + note, failure logged (no retry re-send)", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([
        {
          id: "inv-1",
          origin: "tj",
          customerId: "cust-1",
          bookkeeperThreadId: null,
        },
      ]),
    );
    vi.mocked(loadAppSettings).mockResolvedValueOnce({
      tj_bookkeeper_email: "books@torahjudaica.example",
    } as never);
    vi.mocked(sendEmail).mockResolvedValueOnce({
      messageId: "m-2",
      threadId: "t-2",
      from: "accounts@feldart.com",
    } as never);
    // email_log insert throws AFTER the email went out.
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockRejectedValue(new Error("db down")),
    } as never);

    const tool = getToolByName("send_bookkeeper_email")!;
    const result = await tool.execute(args, ctx);

    expect(result.ok).toBe(true);
    expect(result.ok && result.note).toContain("email_log insert");
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "prop-1",
        messageId: "m-2",
        invoiceId: "inv-1",
        failedWrite: "email_log insert",
      }),
      expect.stringContaining("post-send bookkeeping failed"),
    );
  });

  it("unconfigured bookkeeper address stays fatal (nothing was sent)", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([
        { id: "inv-1", origin: "tj", customerId: "cust-1", bookkeeperThreadId: null },
      ]),
    );
    vi.mocked(loadAppSettings).mockResolvedValueOnce({
      tj_bookkeeper_email: "",
    } as never);

    const tool = getToolByName("send_bookkeeper_email")!;
    const result = await tool.execute(args, ctx);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("tj_bookkeeper_email");
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
