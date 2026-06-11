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
vi.mock("../statements/send.js", () => ({
  sendStatement: vi.fn(),
  buildStatementPdfAttachment: vi.fn(),
  recordAttachedStatement: vi.fn(async () => undefined),
}));
const { getPdfMock } = vi.hoisted(() => ({ getPdfMock: vi.fn() }));
vi.mock("../../integrations/qb/client.js", () => ({
  QboClient: class {
    getPdf = getPdfMock;
  },
}));
vi.mock("../statements/settings.js", () => ({ loadAppSettings: vi.fn() }));
vi.mock("../crm/auto-action-emails.js", () => ({
  autoActionPriorInbounds: vi.fn(async () => undefined),
}));
vi.mock("../../server/lib/bookkeeper-thread-link.js", () => ({
  linkBookkeeperThread: vi.fn(async () => undefined),
}));

import { db } from "../../db/index.js";
import { sendEmail } from "../../integrations/gmail/send.js";
import {
  buildStatementPdfAttachment,
  recordAttachedStatement,
} from "../statements/send.js";
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

describe("send_chase_email recipient resolution + attachments", () => {
  const baseArgs = {
    customerId: "cust-1",
    tier: "HIGH",
    origin: "feldart",
    subject: "Overdue balance",
    body: "<p>Please pay.</p>",
  };
  const sendOk = { messageId: "m-9", threadId: "t-9", from: "accounts@feldart.com" };
  const insertOk = { values: vi.fn().mockResolvedValue(undefined) };

  it("uses the per-channel statement recipients (not legacy primaryEmail)", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([
        {
          id: "cust-1",
          primaryEmail: "legacy@example.com",
          statementToEmails: ["books@example.com", "owner@example.com"],
          statementCcEmails: ["cc@example.com"],
          tags: [],
        },
      ]),
    );
    vi.mocked(sendEmail).mockResolvedValueOnce(sendOk as never);
    vi.mocked(db.insert).mockReturnValue(insertOk as never);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    } as never);

    const tool = getToolByName("send_chase_email")!;
    const result = await tool.execute(baseArgs, ctx);

    expect(result.ok).toBe(true);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "books@example.com, owner@example.com",
        cc: "cc@example.com",
      }),
    );
  });

  it("falls back to primaryEmail when no per-channel lists exist", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([{ id: "cust-1", primaryEmail: "only@example.com", tags: [] }]),
    );
    vi.mocked(sendEmail).mockResolvedValueOnce(sendOk as never);
    vi.mocked(db.insert).mockReturnValue(insertOk as never);

    const tool = getToolByName("send_chase_email")!;
    const result = await tool.execute(baseArgs, ctx);
    expect(result.ok).toBe(true);
    expect(vi.mocked(sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({ to: "only@example.com" }),
    );
  });

  it("fails clearly when the customer has no recipients at all", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([{ id: "cust-1", primaryEmail: null, tags: [] }]),
    );
    const tool = getToolByName("send_chase_email")!;
    const result = await tool.execute(baseArgs, ctx);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("no statement/chase recipients");
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });

  it("distinguishes a missing customer (invented id) from a missing email", async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([]));
    const tool = getToolByName("send_chase_email")!;
    const result = await tool.execute(
      { ...baseArgs, customerId: "gifts-by-gilda" },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("not found");
    expect(!result.ok && result.error).toContain("search_customers");
  });

  it("attaches invoice PDFs by docNumber and the statement when asked", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(
        selectChain([{ id: "cust-1", primaryEmail: "c@example.com", tags: [] }]),
      )
      // invoice docNumber lookup — no .limit() in this query, the chain
      // must resolve at .where()
      .mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi
          .fn()
          .mockResolvedValue([
            { docNumber: "18312", qbInvoiceId: "qb-77", status: "open" },
          ]),
      } as never);
    getPdfMock.mockResolvedValueOnce(Buffer.from("PDFBYTES"));
    // attachStatement triggers the global-BCC layer, which reads settings
    vi.mocked(loadAppSettings).mockResolvedValueOnce({} as never);
    vi.mocked(buildStatementPdfAttachment).mockResolvedValueOnce({
      buffer: Buffer.from("STMT"),
      filename: "Statement_Acme_42.pdf",
      statementNumber: 42,
    } as never);
    vi.mocked(sendEmail).mockResolvedValueOnce(sendOk as never);
    vi.mocked(db.insert).mockReturnValue(insertOk as never);

    const tool = getToolByName("send_chase_email")!;
    const result = await tool.execute(
      { ...baseArgs, attachInvoiceDocNumbers: ["18312"], attachStatement: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    const call = vi.mocked(sendEmail).mock.calls[0]![0] as {
      attachments?: Array<{ filename: string }>;
    };
    expect(call.attachments?.map((a) => a.filename)).toEqual([
      "Invoice-18312.pdf",
      "Statement_Acme_42.pdf",
    ]);
    expect(vi.mocked(recordAttachedStatement)).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: "cust-1",
        statementNumber: 42,
        messageId: "m-9",
      }),
    );
  });

  it("aborts BEFORE sending when a requested invoice is not the customer's", async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(
        selectChain([{ id: "cust-1", primaryEmail: "c@example.com", tags: [] }]),
      )
      .mockReturnValueOnce({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([]),
      } as never);

    const tool = getToolByName("send_chase_email")!;
    const result = await tool.execute(
      { ...baseArgs, attachInvoiceDocNumbers: ["99999"] },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("invoice 99999 not found");
    expect(vi.mocked(sendEmail)).not.toHaveBeenCalled();
  });
});

describe("statement-carrying emails layer the global statement BCC", () => {
  const args = {
    customerId: "cust-1",
    tier: "HIGH",
    origin: "feldart",
    subject: "Overdue",
    body: "<p>Pay.</p>",
    attachStatement: true,
  };

  it("adds statement_bcc_email to BCC when a statement is attached", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([
        {
          id: "cust-1",
          primaryEmail: "c@example.com",
          statementBccEmails: ["existing@example.com"],
          statementToEmails: ["c@example.com"],
          tags: [],
        },
      ]),
    );
    vi.mocked(loadAppSettings).mockResolvedValueOnce({
      statement_bcc_email: "books@feldart.com",
    } as never);
    vi.mocked(buildStatementPdfAttachment).mockResolvedValueOnce({
      buffer: Buffer.from("STMT"),
      filename: "Statement_Acme_43.pdf",
      statementNumber: 43,
    } as never);
    vi.mocked(sendEmail).mockResolvedValueOnce({
      messageId: "m-1",
      threadId: "t-1",
      from: "accounts@feldart.com",
    } as never);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as never);

    const tool = getToolByName("send_chase_email")!;
    const result = await tool.execute(args, ctx);
    expect(result.ok).toBe(true);
    const call = vi.mocked(sendEmail).mock.calls[0]![0] as { bcc?: string };
    expect(call.bcc).toContain("existing@example.com");
    expect(call.bcc).toContain("books@feldart.com");
  });

  it("does NOT add the global BCC to a plain chase (no statement attached)", async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      selectChain([{ id: "cust-1", primaryEmail: "c@example.com", tags: [] }]),
    );
    vi.mocked(sendEmail).mockResolvedValueOnce({
      messageId: "m-2",
      threadId: "t-2",
      from: "accounts@feldart.com",
    } as never);
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as never);

    const tool = getToolByName("send_chase_email")!;
    const result = await tool.execute({ ...args, attachStatement: undefined }, ctx);
    expect(result.ok).toBe(true);
    expect(vi.mocked(loadAppSettings)).not.toHaveBeenCalled();
    const call = vi.mocked(sendEmail).mock.calls[0]![0] as { bcc?: string };
    expect(call.bcc ?? "").not.toContain("books@feldart.com");
  });
});
