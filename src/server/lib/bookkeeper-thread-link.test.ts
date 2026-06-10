import { describe, expect, it, vi } from "vitest";
import {
  guardDisputeInvoice,
  linkBookkeeperThread,
  type DisputeInvoiceForLink,
} from "./bookkeeper-thread-link.js";

// Logic-level tests for the dispute bookkeeper-thread linkage (no Fastify
// harness in repo — the route delegates to these two functions, so they
// ARE the guard/update contract; same pattern as routes/statements.test.ts).

const tjInvoice: DisputeInvoiceForLink = {
  id: "inv_tj_1",
  origin: "tj",
  bookkeeperThreadId: null,
};

const feldartInvoice: DisputeInvoiceForLink = {
  id: "inv_f_1",
  origin: "feldart",
  bookkeeperThreadId: null,
};

describe("guardDisputeInvoice (pre-send)", () => {
  it("rejects when the invoice does not exist", async () => {
    const load = vi.fn().mockResolvedValue(null);
    const r = await guardDisputeInvoice(load, "missing_id");
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") {
      expect(r.message).toMatch(/not found/);
    }
    expect(load).toHaveBeenCalledWith("missing_id");
  });

  it("rejects a feldart invoice (linkage is TJ-only)", async () => {
    const load = vi.fn().mockResolvedValue(feldartInvoice);
    const r = await guardDisputeInvoice(load, feldartInvoice.id);
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") {
      expect(r.message).toMatch(/TJ-only/);
    }
  });

  it("accepts a tj invoice and returns it for the post-send link", async () => {
    const load = vi.fn().mockResolvedValue(tjInvoice);
    const r = await guardDisputeInvoice(load, tjInvoice.id);
    expect(r).toEqual({ kind: "ok", invoice: tjInvoice });
  });

  it("skips without any invoice lookup when no disputeInvoiceId", async () => {
    const load = vi.fn();
    const r = await guardDisputeInvoice(load, undefined);
    expect(r).toEqual({ kind: "skip" });
    expect(load).not.toHaveBeenCalled();
  });
});

describe("linkBookkeeperThread (post-send)", () => {
  it("updates the invoice threadId and writes the audit row", async () => {
    const updateThreadId = vi.fn().mockResolvedValue(undefined);
    const insertAudit = vi.fn().mockResolvedValue(undefined);
    await linkBookkeeperThread(
      { updateThreadId, insertAudit },
      { invoice: tjInvoice, threadId: "thread_abc", userId: "user_1" },
    );
    expect(updateThreadId).toHaveBeenCalledWith("inv_tj_1", "thread_abc");
    expect(insertAudit).toHaveBeenCalledTimes(1);
    const row = insertAudit.mock.calls[0]![0];
    expect(row).toMatchObject({
      userId: "user_1",
      action: "dispute.bookkeeper_thread_linked",
      entityType: "invoice",
      entityId: "inv_tj_1",
      before: { bookkeeperThreadId: null },
      after: { bookkeeperThreadId: "thread_abc" },
    });
    expect(typeof row.id).toBe("string");
    expect(row.id.length).toBe(24);
  });

  it("overwrites an existing threadId (re-link: latest thread wins) and audits the superseded id", async () => {
    const updateThreadId = vi.fn().mockResolvedValue(undefined);
    const insertAudit = vi.fn().mockResolvedValue(undefined);
    await linkBookkeeperThread(
      { updateThreadId, insertAudit },
      {
        invoice: { ...tjInvoice, bookkeeperThreadId: "thread_old" },
        threadId: "thread_new",
        userId: "user_1",
      },
    );
    expect(updateThreadId).toHaveBeenCalledWith("inv_tj_1", "thread_new");
    expect(insertAudit.mock.calls[0]![0]).toMatchObject({
      before: { bookkeeperThreadId: "thread_old" },
      after: { bookkeeperThreadId: "thread_new" },
    });
  });
});
