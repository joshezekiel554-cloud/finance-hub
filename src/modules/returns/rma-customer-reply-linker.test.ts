import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted db mock — must live before any import that loads the db module.
// ---------------------------------------------------------------------------
const { mockSelect, mockInsert, resetMocks, setSelectResponses } = vi.hoisted(() => {
  let selectResponseQueue: unknown[][] = [];

  const setSelectResponses = (responses: unknown[][]) => {
    selectResponseQueue = responses.slice();
  };

  const resetMocks = () => {
    selectResponseQueue = [];
  };

  type LazyNode = {
    then: (resolve: (v: unknown[]) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
    catch: (reject: (e: unknown) => unknown) => Promise<unknown>;
    where: (...args: unknown[]) => LazyNode;
    and: (...args: unknown[]) => LazyNode;
    orderBy: (...args: unknown[]) => LazyNode;
    limit: (...args: unknown[]) => LazyNode;
    from: (...args: unknown[]) => LazyNode;
    innerJoin: (...args: unknown[]) => LazyNode;
  };

  const makeNode = (): LazyNode => ({
    then(resolve, reject) {
      return Promise.resolve(selectResponseQueue.shift() ?? []).then(resolve, reject);
    },
    catch(reject) {
      return Promise.resolve(selectResponseQueue.shift() ?? []).catch(reject);
    },
    where: () => makeNode(),
    and: () => makeNode(),
    orderBy: () => makeNode(),
    limit: () => makeNode(),
    from: () => makeNode(),
    innerJoin: () => makeNode(),
  });

  const mockSelect = vi.fn(() => makeNode());
  const mockInsert = vi.fn(() => ({
    values: vi.fn().mockResolvedValue(undefined),
  }));

  return { mockSelect, mockInsert, resetMocks, setSelectResponses };
});

vi.mock("~/db/index.js", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
    })),
  },
}));

vi.mock("~/db/schema/crm.js", () => ({
  emailLog: {
    id: "id",
    gmailMessageId: "gmail_message_id",
    threadId: "thread_id",
    direction: "direction",
    customerId: "customer_id",
  },
  activities: {
    refType: "ref_type",
    refId: "ref_id",
    customerId: "customer_id",
    meta: "meta",
    kind: "kind",
    source: "source",
    occurredAt: "occurred_at",
    id: "id",
  },
}));

vi.mock("~/db/schema/returns.js", () => ({
  rmas: {
    id: "id",
    customerId: "customer_id",
  },
}));

vi.mock("~/modules/crm/activity-ingester.js", () => ({
  recordActivity: vi.fn().mockResolvedValue("activity-id-1"),
}));

// Import after mocks are set up
import { linkCustomerReplyIfRmaThread } from "./rma-customer-reply-linker.js";
import { recordActivity } from "../crm/activity-ingester.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("linkCustomerReplyIfRmaThread", () => {
  beforeEach(() => {
    resetMocks();
    vi.clearAllMocks();
    (recordActivity as ReturnType<typeof vi.fn>).mockResolvedValue("activity-id-1");
  });

  const baseInput = {
    gmailMessageId: "gmail-msg-999",
    threadId: "thread-abc-123",
    inReplyTo: "original-msg-id",
    from: "customer@example.com",
    subject: "Re: Your RMA Request",
    bodySnippet: "Thank you, the package is on its way.",
  };

  describe("matched thread — activity has meta.threadId", () => {
    it("returns linked: true with rmaId when a matching RMA activity is found", async () => {
      setSelectResponses([
        // Query 1: outbound email_log rows in thread
        [{ id: "email-log-1" }],
        // Query 2: activities with ref_type='rma' and meta.threadId = threadId
        [{ refId: "rma-id-abc", customerId: "customer-id-xyz" }],
      ]);

      const result = await linkCustomerReplyIfRmaThread(baseInput);

      expect(result).toEqual({ linked: true, rmaId: "rma-id-abc" });
      expect(recordActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "customer-id-xyz",
          kind: "rma_customer_reply",
          source: "gmail_poll",
          refType: "rma",
          refId: "rma-id-abc",
          subject: baseInput.subject,
          body: baseInput.bodySnippet,
        }),
      );
    });
  });

  describe("no match — no outbound rows in thread", () => {
    it("returns linked: false when no outbound emails are in this thread", async () => {
      setSelectResponses([
        // Query 1: outbound email_log rows — none found
        [],
      ]);

      const result = await linkCustomerReplyIfRmaThread(baseInput);

      expect(result).toEqual({ linked: false });
      expect(recordActivity).not.toHaveBeenCalled();
    });
  });

  describe("no match — outbound rows exist but no RMA activity", () => {
    it("returns linked: false when outbound emails exist but no RMA is linked to this thread", async () => {
      setSelectResponses([
        // Query 1: outbound email_log rows found
        [{ id: "email-log-2" }],
        // Query 2: activities with ref_type='rma' and meta.threadId — none found
        [],
        // Query 3: outbound with customerId
        [{ id: "email-log-2", customerId: "customer-id-abc" }],
        // Query 4: rma activities for customer in this thread — none
        [],
      ]);

      const result = await linkCustomerReplyIfRmaThread(baseInput);

      expect(result).toEqual({ linked: false });
      expect(recordActivity).not.toHaveBeenCalled();
    });
  });

  describe("missing inReplyTo header", () => {
    it("still links using threadId alone when inReplyTo is absent", async () => {
      const inputWithoutInReplyTo = {
        gmailMessageId: "gmail-msg-888",
        threadId: "thread-def-456",
        from: "buyer@store.com",
        subject: "Re: Return Approval",
        bodySnippet: "Got it, returning today.",
      };

      setSelectResponses([
        // Query 1: outbound email_log rows in thread (no inReplyTo condition)
        [{ id: "email-log-3" }],
        // Query 2: activities with ref_type='rma' and meta.threadId
        [{ refId: "rma-id-def", customerId: "cust-def" }],
      ]);

      const result = await linkCustomerReplyIfRmaThread(inputWithoutInReplyTo);

      expect(result).toEqual({ linked: true, rmaId: "rma-id-def" });
      expect(recordActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          refId: "rma-id-def",
          kind: "rma_customer_reply",
        }),
      );
    });
  });

  describe("fallback path — uses customerId from email_log when meta.threadId lookup fails", () => {
    it("links via customer+thread fallback when first meta query returns nothing", async () => {
      setSelectResponses([
        // Query 1: outbound email_log rows in thread
        [{ id: "email-log-4" }],
        // Query 2: activities with meta.threadId — not found (first path)
        [],
        // Query 3: outbound with customerId (fallback path)
        [{ id: "email-log-4", customerId: "cust-ghi" }],
        // Query 4: rma activities for customer in this thread — found
        [{ refId: "rma-id-ghi" }],
      ]);

      const result = await linkCustomerReplyIfRmaThread(baseInput);

      expect(result).toEqual({ linked: true, rmaId: "rma-id-ghi" });
      expect(recordActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          customerId: "cust-ghi",
          refId: "rma-id-ghi",
          kind: "rma_customer_reply",
        }),
      );
    });
  });

  describe("error handling", () => {
    it("returns linked: false and does not throw when db throws", async () => {
      mockSelect.mockImplementationOnce(() => {
        throw new Error("DB connection lost");
      });

      const result = await linkCustomerReplyIfRmaThread(baseInput);

      expect(result).toEqual({ linked: false });
      expect(recordActivity).not.toHaveBeenCalled();
    });
  });
});
