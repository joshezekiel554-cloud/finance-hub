// planInvoiceUpdate must treat QBO's email/delivery fields as sync-owned:
// drift on any of them produces an update set that carries all three, and
// sent_at / sent_via stay out of the set (they are local-only).
import { describe, expect, it } from "vitest";
import { clampQboString, parseQboDateTime, planInvoiceUpdate } from "./sync.js";

type Before = Parameters<typeof planInvoiceUpdate>[0];
type Desired = Parameters<typeof planInvoiceUpdate>[1];

const synced = new Date("2026-09-07T10:00:00Z");

function before(overrides: Partial<Before> = {}): Before {
  return {
    customerId: "cust-1",
    docNumber: "19562",
    issueDate: new Date("2026-09-02T00:00:00Z"),
    dueDate: new Date("2026-10-02T00:00:00Z"),
    total: "195.00",
    balance: "195.00",
    status: "sent",
    customerMemo: null,
    syncToken: "0",
    originSource: "prefix",
    emailStatus: "NotSet",
    deliveryTime: null,
    deliveryError: null,
    ...overrides,
  };
}

function desired(overrides: Partial<Desired> = {}): Desired {
  return {
    customerId: "cust-1",
    docNumber: "19562",
    issueDate: new Date("2026-09-02T00:00:00Z"),
    dueDate: new Date("2026-10-02T00:00:00Z"),
    total: "195.00",
    balance: "195.00",
    status: "sent",
    customerMemo: null,
    syncToken: "0",
    origin: "feldart",
    emailStatus: "NotSet",
    deliveryTime: null,
    deliveryError: null,
    lastSyncedAt: synced,
    ...overrides,
  };
}

describe("planInvoiceUpdate — email/delivery fields", () => {
  it("returns null when nothing (including email fields) drifted", () => {
    expect(planInvoiceUpdate(before(), desired())).toBeNull();
  });

  it("detects EmailStatus flipping NotSet → EmailSent", () => {
    const set = planInvoiceUpdate(
      before(),
      desired({
        emailStatus: "EmailSent",
        deliveryTime: new Date("2026-09-07T12:34:52Z"),
      }),
    );
    expect(set).not.toBeNull();
    expect(set?.emailStatus).toBe("EmailSent");
    expect(set?.deliveryTime?.toISOString()).toBe("2026-09-07T12:34:52.000Z");
    expect(set?.deliveryError).toBeNull();
  });

  it("detects a DeliveryErrorType appearing after the fact", () => {
    const set = planInvoiceUpdate(
      before({
        emailStatus: "EmailSent",
        deliveryTime: new Date("2026-09-02T13:36:04Z"),
      }),
      desired({
        emailStatus: "EmailSent",
        deliveryTime: new Date("2026-09-02T13:36:04Z"),
        deliveryError: "Bounced Email",
      }),
    );
    expect(set?.deliveryError).toBe("Bounced Email");
  });

  it("detects a re-send clearing the error and moving DeliveryTime", () => {
    const set = planInvoiceUpdate(
      before({
        emailStatus: "EmailSent",
        deliveryTime: new Date("2026-09-02T13:36:04Z"),
        deliveryError: "Bounced Email",
      }),
      desired({
        emailStatus: "EmailSent",
        deliveryTime: new Date("2026-09-06T21:43:23Z"),
        deliveryError: null,
      }),
    );
    expect(set?.deliveryError).toBeNull();
    expect(set?.deliveryTime?.toISOString()).toBe("2026-09-06T21:43:23.000Z");
  });

  it("update set is exactly the sync-owned fields — never sent_at / sent_via", () => {
    const set = planInvoiceUpdate(before(), desired({ emailStatus: "EmailSent" }));
    expect(set).not.toBeNull();
    expect(Object.keys(set ?? {}).sort()).toEqual(
      [
        "balance",
        "customerId",
        "customerMemo",
        "deliveryError",
        "deliveryTime",
        "docNumber",
        "dueDate",
        "emailStatus",
        "issueDate",
        "lastSyncedAt",
        "origin",
        "status",
        "syncToken",
        "total",
      ].sort(),
    );
  });
});

describe("parseQboDateTime", () => {
  it("parses an offset ISO datetime to the right instant with ms zeroed", () => {
    expect(parseQboDateTime("2026-09-06T14:43:23-07:00")?.toISOString()).toBe("2026-09-06T21:43:23.000Z");
    expect(parseQboDateTime("2026-09-06T14:43:23.500-07:00")?.toISOString()).toBe("2026-09-06T21:43:23.000Z");
  });
  it("returns null on empty or non-ISO input", () => {
    expect(parseQboDateTime(undefined)).toBeNull();
    expect(parseQboDateTime("")).toBeNull();
    expect(parseQboDateTime("2026")).toBeNull();
    expect(parseQboDateTime("not a date")).toBeNull();
  });
});

describe("clampQboString", () => {
  it("passes short values through and nulls empties", () => {
    expect(clampQboString("Bounced Email", 64)).toBe("Bounced Email");
    expect(clampQboString(undefined, 64)).toBeNull();
    expect(clampQboString("", 64)).toBeNull();
  });
  it("truncates over-long values to the column width", () => {
    expect(clampQboString("x".repeat(70), 64)).toBe("x".repeat(64));
  });
});
