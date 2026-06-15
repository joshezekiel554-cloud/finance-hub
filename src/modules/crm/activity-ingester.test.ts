import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted to the top of the file, so any references it makes need
// to live in vi.hoisted() to also be hoisted. The recorded inserts list and
// mock db go in there together so they're available when the mock factory
// runs.
const { mockDb, insertCalls, updateCalls, deleteCalls } = vi.hoisted(() => {
  type InsertCall = { table: unknown; values: unknown };
  const insertCalls: InsertCall[] = [];
  const updateCalls: { table: unknown; set: unknown }[] = [];
  const deleteCalls: { table: unknown }[] = [];

  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      insertCalls.push({ table, values });
      return Promise.resolve();
    },
  });

  const update = (table: unknown) => ({
    set: (set: unknown) => {
      updateCalls.push({ table, set });
      return { where: () => Promise.resolve() };
    },
  });

  const del = (table: unknown) => {
    deleteCalls.push({ table });
    return { where: () => Promise.resolve() };
  };

  // The transaction body receives a tx object that exposes the same write
  // surface as the parent db. We wire the same recording functions to both so
  // the test can assert on writes whether they happened in or out of a tx.
  const tx = { insert, update, delete: del };

  const transaction = vi.fn(
    async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  );
  const select = vi.fn();

  return {
    insertCalls,
    updateCalls,
    deleteCalls,
    mockDb: { insert, update, delete: del, transaction, select },
  };
});

vi.mock("../../db/index.js", () => ({
  db: mockDb,
}));

import {
  recordActivity,
  updateManualNote,
  deleteManualNote,
} from "./activity-ingester.js";
import { activities } from "../../db/schema/crm.js";
import { auditLog } from "../../db/schema/audit.js";
import {
  __resetCustomerResolverCache,
  resolveCustomerByEmail,
} from "./customer-resolver.js";
import { customers } from "../../db/schema/customers.js";

beforeEach(() => {
  insertCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  mockDb.transaction.mockClear();
  mockDb.select.mockReset();
  __resetCustomerResolverCache();
});

// db.select().from().where().limit() resolves to `rows` — the lookup both
// manual-note mutators run before touching the row.
function noteLookupReturns(rows: unknown[]) {
  mockDb.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  });
}

const SAMPLE_NOTE = {
  id: "act-1",
  customerId: "cust-1",
  userId: "author-1",
  kind: "manual_note",
  occurredAt: new Date("2026-05-01T09:00:00.000Z"),
  subject: null,
  body: "old body",
  bodyHtml: null,
  source: "user_action",
  refType: null,
  refId: null,
  meta: null,
  aiProposalId: null,
  createdAt: new Date("2026-05-01T09:00:00.000Z"),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("recordActivity", () => {
  it("inserts the activity row with the expected fields and returns its id", async () => {
    const occurredAt = new Date("2026-04-23T10:30:00.000Z");

    const id = await recordActivity({
      customerId: "cust-abc-123",
      kind: "email_in",
      source: "gmail_poll",
      subject: "Re: invoice",
      body: "thanks for the reminder",
      refType: "email_log",
      refId: "email-log-id-1",
      occurredAt,
      meta: { gmailMessageId: "msg-1" },
    });

    expect(id).toBeTruthy();
    expect(typeof id).toBe("string");

    const activityInsert = insertCalls.find((c) => c.table === activities);
    expect(activityInsert).toBeDefined();

    const row = activityInsert!.values as Record<string, unknown>;
    expect(row.id).toBe(id);
    expect(row.customerId).toBe("cust-abc-123");
    expect(row.kind).toBe("email_in");
    expect(row.source).toBe("gmail_poll");
    expect(row.subject).toBe("Re: invoice");
    expect(row.body).toBe("thanks for the reminder");
    expect(row.refType).toBe("email_log");
    expect(row.refId).toBe("email-log-id-1");
    expect(row.occurredAt).toBe(occurredAt);
    expect(row.userId).toBeNull();
    expect(row.bodyHtml).toBeNull();
    expect(row.meta).toEqual({ gmailMessageId: "msg-1" });
  });

  it("writes an audit_log row in the same transaction as the activity", async () => {
    const id = await recordActivity({
      customerId: "cust-1",
      kind: "qbo_invoice_sent",
      source: "qbo_sync",
      meta: { invoice_id: "inv-1", doc_number: "INV-100", total: 250.5 },
    });

    expect(mockDb.transaction).toHaveBeenCalledTimes(1);

    const activityInsert = insertCalls.find((c) => c.table === activities);
    const auditInsert = insertCalls.find((c) => c.table === auditLog);

    expect(activityInsert).toBeDefined();
    expect(auditInsert).toBeDefined();

    const auditRow = auditInsert!.values as Record<string, unknown>;
    expect(auditRow.action).toBe("activity_created");
    expect(auditRow.entityType).toBe("activity");
    expect(auditRow.entityId).toBe(id);
    expect(auditRow.before).toBeNull();

    const after = auditRow.after as Record<string, unknown>;
    expect(after.id).toBe(id);
    expect(after.kind).toBe("qbo_invoice_sent");
    expect(after.customerId).toBe("cust-1");
    expect(after.meta).toEqual({
      invoice_id: "inv-1",
      doc_number: "INV-100",
      total: 250.5,
    });
  });

  it("returns null and writes nothing when customerId is null", async () => {
    const id = await recordActivity({
      customerId: null,
      kind: "email_in",
      source: "gmail_poll",
    });

    expect(id).toBeNull();
    expect(insertCalls).toHaveLength(0);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it("propagates userId to both the activity row and the audit_log row", async () => {
    await recordActivity({
      customerId: "cust-1",
      kind: "manual_note",
      source: "user_action",
      userId: "user-42",
      body: "left voicemail, will follow up Friday",
    });

    const activityInsert = insertCalls.find((c) => c.table === activities);
    const auditInsert = insertCalls.find((c) => c.table === auditLog);
    expect((activityInsert!.values as Record<string, unknown>).userId).toBe(
      "user-42",
    );
    expect((auditInsert!.values as Record<string, unknown>).userId).toBe(
      "user-42",
    );
  });

  it("defaults occurredAt to now when not provided", async () => {
    const before = Date.now();
    await recordActivity({
      customerId: "cust-1",
      kind: "balance_change",
      source: "qbo_sync",
      meta: { from: 100, to: 250, delta: 150 },
    });
    const after = Date.now();

    const activityInsert = insertCalls.find((c) => c.table === activities);
    const occurredAt = (activityInsert!.values as Record<string, unknown>)
      .occurredAt as Date;
    expect(occurredAt).toBeInstanceOf(Date);
    expect(occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(occurredAt.getTime()).toBeLessThanOrEqual(after);
  });
});

describe("updateManualNote", () => {
  it("updates body+subject and writes a before/after audit row in one tx", async () => {
    noteLookupReturns([SAMPLE_NOTE]);

    const res = await updateManualNote({
      activityId: "act-1",
      customerId: "cust-1",
      userId: "editor-9",
      body: "new body",
      subject: "Follow-up",
    });

    expect(res).toBe("ok");
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);

    expect(updateCalls).toHaveLength(1);
    const set = updateCalls[0]!.set as Record<string, unknown>;
    expect(set.body).toBe("new body");
    expect(set.subject).toBe("Follow-up");

    const auditInsert = insertCalls.find((c) => c.table === auditLog);
    const auditRow = auditInsert!.values as Record<string, unknown>;
    expect(auditRow.action).toBe("activity_updated");
    expect(auditRow.entityId).toBe("act-1");
    expect(auditRow.userId).toBe("editor-9");
    expect((auditRow.before as Record<string, unknown>).body).toBe("old body");
    expect((auditRow.after as Record<string, unknown>).body).toBe("new body");
  });

  it("returns not_found and writes nothing when no matching manual_note exists", async () => {
    noteLookupReturns([]);

    const res = await updateManualNote({
      activityId: "nope",
      customerId: "cust-1",
      body: "x",
    });

    expect(res).toBe("not_found");
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });
});

describe("deleteManualNote", () => {
  it("deletes the row and writes an audit row capturing it in `before`", async () => {
    noteLookupReturns([SAMPLE_NOTE]);

    const res = await deleteManualNote({
      activityId: "act-1",
      customerId: "cust-1",
      userId: "editor-9",
    });

    expect(res).toBe("ok");
    expect(deleteCalls).toHaveLength(1);

    const auditInsert = insertCalls.find((c) => c.table === auditLog);
    const auditRow = auditInsert!.values as Record<string, unknown>;
    expect(auditRow.action).toBe("activity_deleted");
    expect(auditRow.entityId).toBe("act-1");
    expect((auditRow.before as Record<string, unknown>).body).toBe("old body");
    expect(auditRow.after).toBeNull();
  });

  it("returns not_found and writes nothing when the note is missing", async () => {
    noteLookupReturns([]);

    const res = await deleteManualNote({ activityId: "nope", customerId: "c" });

    expect(res).toBe("not_found");
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(deleteCalls).toHaveLength(0);
  });
});

describe("resolveCustomerByEmail", () => {
  function customerRows(rows: Array<{
    id: string;
    primaryEmail: string | null;
    billingEmails: string[] | null;
  }>) {
    // db.select(...).from(...) returns a thenable that resolves to rows.
    // We model that minimally so the resolver's lookup call works.
    const fromChain = {
      then: (
        resolve: (
          v: Array<{
            id: string;
            primaryEmail: string | null;
            billingEmails: string[] | null;
          }>,
        ) => unknown,
      ) => resolve(rows),
    };
    mockDb.select.mockReturnValue({ from: () => fromChain });
  }

  it("returns the customer id for a primary_email match (case insensitive)", async () => {
    customerRows([
      {
        id: "cust-1",
        primaryEmail: "Joshua@feldart.com",
        billingEmails: null,
      },
      {
        id: "cust-2",
        primaryEmail: "another@example.com",
        billingEmails: null,
      },
    ]);

    expect(mockDb.select).not.toHaveBeenCalled();

    const result = await resolveCustomerByEmail("JOSHUA@feldart.com");
    expect(result).toBe("cust-1");
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(mockDb.select).toHaveBeenCalledWith({
      id: customers.id,
      primaryEmail: customers.primaryEmail,
      billingEmails: customers.billingEmails,
    });
  });

  it("returns the customer id for an entry inside billing_emails JSON array", async () => {
    customerRows([
      {
        id: "cust-1",
        primaryEmail: "primary@feldart.com",
        billingEmails: ["alt@feldart.com", "billing@feldart.com"],
      },
    ]);

    const result = await resolveCustomerByEmail("billing@feldart.com");
    expect(result).toBe("cust-1");
  });

  it("returns null when no customer matches", async () => {
    customerRows([
      {
        id: "cust-1",
        primaryEmail: "primary@feldart.com",
        billingEmails: null,
      },
    ]);

    const result = await resolveCustomerByEmail("stranger@nowhere.com");
    expect(result).toBeNull();
  });

  it("returns null for falsy / malformed email input without hitting the DB", async () => {
    customerRows([]);

    expect(await resolveCustomerByEmail(null)).toBeNull();
    expect(await resolveCustomerByEmail(undefined)).toBeNull();
    expect(await resolveCustomerByEmail("")).toBeNull();
    expect(await resolveCustomerByEmail("not-an-email")).toBeNull();

    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("caches the lookup index across calls within TTL", async () => {
    customerRows([
      {
        id: "cust-1",
        primaryEmail: "first@feldart.com",
        billingEmails: ["alt@feldart.com"],
      },
    ]);

    await resolveCustomerByEmail("first@feldart.com");
    await resolveCustomerByEmail("alt@feldart.com");
    await resolveCustomerByEmail("nope@example.com");

    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});
