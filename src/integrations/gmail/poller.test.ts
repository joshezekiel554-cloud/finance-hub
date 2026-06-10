import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ParsedEmail } from "./types.js";
import type { GmailAlias } from "./aliases.js";

// --- Hoisted mocks -------------------------------------------------------

const { state, mockDb, searchEmailsMock, listAliasesMock, loggerStub } =
  vi.hoisted(() => {
    type InsertCall = { table: unknown; values: Record<string, unknown> };
    type UpdateCall = { table: unknown; set: Record<string, unknown> };

    const state = {
      // table object → rows to return from any select(...).from(table) chain
      selectResults: new Map<unknown, unknown[]>(),
      insertCalls: [] as InsertCall[],
      updateCalls: [] as UpdateCall[],
    };

    // Minimal thenable select-chain: .from() picks rows by table identity,
    // .where()/.limit() are pass-through, awaiting resolves the rows.
    const select = (): {
      from: (table: unknown) => unknown;
    } => {
      const chain = {
        rows: [] as unknown[],
        from(table: unknown) {
          chain.rows = state.selectResults.get(table) ?? [];
          return chain;
        },
        where() {
          return chain;
        },
        limit() {
          return chain;
        },
        then(
          resolve: (rows: unknown[]) => unknown,
          reject?: (err: unknown) => unknown,
        ) {
          return Promise.resolve(chain.rows).then(resolve, reject);
        },
      };
      return chain;
    };

    const insert = (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        state.insertCalls.push({ table, values });
        return Promise.resolve();
      },
    });

    const update = (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          state.updateCalls.push({ table, set });
          return Promise.resolve();
        },
      }),
    });

    const loggerStub = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
    };

    return {
      state,
      mockDb: { select, insert, update },
      searchEmailsMock: vi.fn(),
      listAliasesMock: vi.fn(),
      loggerStub,
    };
  });

vi.mock("~/db/index.js", () => ({ db: mockDb }));
vi.mock("~/lib/logger.js", () => ({ createLogger: () => loggerStub }));
vi.mock("./client.js", () => ({ searchEmails: searchEmailsMock }));
vi.mock("./aliases.js", () => ({ listAliases: listAliasesMock }));
vi.mock("~/modules/crm/index.js", () => ({
  recordActivity: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("~/modules/crm/auto-action-emails.js", () => ({
  autoActionPriorInbounds: vi.fn(() => Promise.resolve(0)),
}));
vi.mock("~/modules/returns/extensiv-receipt-classifier.js", () => ({
  classifyExtensivEmail: vi.fn(),
}));
vi.mock("~/modules/returns/rma-matcher.js", () => ({
  matchReceiptToRma: vi.fn(),
}));
vi.mock("~/modules/returns/rma-customer-reply-linker.js", () => ({
  linkCustomerReplyIfRmaThread: vi.fn(() => Promise.resolve()),
}));
vi.mock("~/server/modules/rma/email-linker.js", () => ({
  linkEmailToRmas: vi.fn(() => Promise.resolve()),
}));

import {
  classifyDirection,
  getOutboundAddressSet,
  pollNewEmails,
  syncEmailsForCustomer,
} from "./poller.js";
import { emailLog } from "~/db/schema/crm.js";
import { customers } from "~/db/schema/customers.js";
import { oauthTokens } from "~/db/schema/oauth.js";

// --- Fixtures -------------------------------------------------------------

function makeEmail(overrides: Partial<ParsedEmail> & { id: string }): ParsedEmail {
  return {
    threadId: `thread_${overrides.id}`,
    messageIdHeader: `<${overrides.id}@mail.example.com>`,
    from: overrides.fromEmail ?? "",
    to: overrides.toEmail ?? "",
    fromEmail: "",
    toEmail: "",
    subject: "Test subject",
    date: "",
    emailDate: new Date("2026-06-10T09:00:00.000Z"),
    body: "Test body",
    htmlBody: "",
    snippet: "Test snippet",
    labelIds: [],
    ...overrides,
  };
}

function makeAlias(sendAsEmail: string): GmailAlias {
  return {
    sendAsEmail,
    displayName: null,
    isPrimary: false,
    isDefault: false,
    treatAsAlias: true,
    verificationStatus: "accepted",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.selectResults.clear();
  state.insertCalls.length = 0;
  state.updateCalls.length = 0;
});

// --- getOutboundAddressSet + classifyDirection ----------------------------

describe("getOutboundAddressSet / classifyDirection", () => {
  it("classifies mail FROM a live sendAs alias (not in BUSINESS_EMAILS) as outbound", async () => {
    listAliasesMock.mockResolvedValue([makeAlias("Returns@Feldart.com")]);

    const outbound = await getOutboundAddressSet();

    const fromAlias = makeEmail({
      id: "m1",
      fromEmail: "returns@feldart.com",
      toEmail: "buyer@example.com",
    });
    expect(classifyDirection(fromAlias, outbound)).toBe("outbound");

    // Defensive case-insensitivity on the email side too.
    const fromAliasUpper = makeEmail({
      id: "m2",
      fromEmail: "RETURNS@FELDART.COM",
      toEmail: "buyer@example.com",
    });
    expect(classifyDirection(fromAliasUpper, outbound)).toBe("outbound");

    // A genuine customer sender is still inbound.
    const fromCustomer = makeEmail({
      id: "m3",
      fromEmail: "buyer@example.com",
      toEmail: "returns@feldart.com",
    });
    expect(classifyDirection(fromCustomer, outbound)).toBe("inbound");
  });

  it("falls back to BUSINESS_EMAILS (with a warn) when listAliases throws", async () => {
    listAliasesMock.mockRejectedValue(new Error("gmail unavailable"));

    const outbound = await getOutboundAddressSet();

    expect(loggerStub.warn).toHaveBeenCalledTimes(1);

    // Hardcoded fallback addresses still classify outbound.
    const fromBusiness = makeEmail({
      id: "m1",
      fromEmail: "info@feldart.com",
      toEmail: "buyer@example.com",
    });
    expect(classifyDirection(fromBusiness, outbound)).toBe("outbound");

    // Unlisted alias is (regrettably) inbound while Gmail is down — but
    // classification itself keeps working.
    const fromUnknownAlias = makeEmail({
      id: "m2",
      fromEmail: "returns@feldart.com",
      toEmail: "buyer@example.com",
    });
    expect(classifyDirection(fromUnknownAlias, outbound)).toBe("inbound");
  });

  it("always includes BUSINESS_EMAILS even when aliases load fine", async () => {
    listAliasesMock.mockResolvedValue([makeAlias("returns@feldart.com")]);

    const outbound = await getOutboundAddressSet();

    const fromBusiness = makeEmail({
      id: "m1",
      fromEmail: "accounts@feldart.com",
      toEmail: "buyer@example.com",
    });
    expect(classifyDirection(fromBusiness, outbound)).toBe("outbound");
  });
});

// --- pollNewEmails integration: set built once, threaded to call sites -----

describe("pollNewEmails direction classification", () => {
  function seedPollDb(): void {
    state.selectResults.set(oauthTokens, [
      {
        id: "tok_1",
        externalAccountId: "shared@feldart.com",
        meta: null,
        revokedAt: null,
      },
    ]);
    state.selectResults.set(emailLog, []); // nothing already logged
    state.selectResults.set(customers, [
      { id: "cust_1", primaryEmail: "buyer@example.com", billingEmails: null },
    ]);
  }

  it("fetches aliases once per cycle and classifies alias-sent mail outbound", async () => {
    seedPollDb();
    listAliasesMock.mockResolvedValue([makeAlias("returns@feldart.com")]);
    searchEmailsMock.mockResolvedValue([
      makeEmail({
        id: "m1",
        fromEmail: "returns@feldart.com",
        toEmail: "buyer@example.com",
      }),
      makeEmail({
        id: "m2",
        fromEmail: "buyer@example.com",
        toEmail: "info@feldart.com",
      }),
      makeEmail({
        id: "m3",
        fromEmail: "info@feldart.com",
        toEmail: "buyer@example.com",
      }),
    ]);

    const result = await pollNewEmails();

    expect(result.inserted).toBe(3);
    // One alias-list fetch per poll cycle, not per email — and it targets
    // the same Gmail account the poller is reading.
    expect(listAliasesMock).toHaveBeenCalledTimes(1);
    expect(listAliasesMock).toHaveBeenCalledWith("shared@feldart.com");

    const inserts = state.insertCalls.filter((c) => c.table === emailLog);
    expect(inserts.map((c) => c.values["direction"])).toEqual([
      "outbound", // sendAs alias not in BUSINESS_EMAILS
      "inbound", // customer sender
      "outbound", // hardcoded business address
    ]);
    // Outbound mail matches the customer on the recipient.
    expect(inserts[0]!.values["customerId"]).toBe("cust_1");
  });

  it("still classifies via hardcoded fallback when listAliases throws mid-poll", async () => {
    seedPollDb();
    listAliasesMock.mockRejectedValue(new Error("gmail unavailable"));
    searchEmailsMock.mockResolvedValue([
      makeEmail({
        id: "m1",
        fromEmail: "info@feldart.com",
        toEmail: "buyer@example.com",
      }),
    ]);

    const result = await pollNewEmails();

    expect(result.inserted).toBe(1);
    expect(loggerStub.warn).toHaveBeenCalled();
    const inserts = state.insertCalls.filter((c) => c.table === emailLog);
    expect(inserts[0]!.values["direction"]).toBe("outbound");
  });
});

// --- syncEmailsForCustomer: second call site threaded ----------------------

describe("syncEmailsForCustomer direction classification", () => {
  it("builds the outbound set once and classifies alias-sent mail outbound", async () => {
    state.selectResults.set(customers, [
      { primaryEmail: "buyer@example.com", billingEmails: null },
    ]);
    state.selectResults.set(emailLog, []);
    listAliasesMock.mockResolvedValue([makeAlias("returns@feldart.com")]);
    searchEmailsMock.mockResolvedValue([
      makeEmail({
        id: "m1",
        fromEmail: "returns@feldart.com",
        toEmail: "buyer@example.com",
      }),
      makeEmail({
        id: "m2",
        fromEmail: "buyer@example.com",
        toEmail: "returns@feldart.com",
      }),
    ]);

    const result = await syncEmailsForCustomer("cust_1", {
      externalAccountId: "shared@feldart.com",
    });

    expect(result.inserted).toBe(2);
    expect(listAliasesMock).toHaveBeenCalledTimes(1);
    expect(listAliasesMock).toHaveBeenCalledWith("shared@feldart.com");

    const inserts = state.insertCalls.filter((c) => c.table === emailLog);
    expect(inserts.map((c) => c.values["direction"])).toEqual([
      "outbound",
      "inbound",
    ]);
  });
});
