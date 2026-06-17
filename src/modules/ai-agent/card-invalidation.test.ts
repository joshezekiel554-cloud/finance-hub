import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./customer-card.js", () => ({
  invalidateCustomerCard: vi.fn(() => Promise.resolve()),
}));

import { invalidateCustomerCard } from "./customer-card.js";
import { events } from "../../lib/events.js";
import { registerCardInvalidation } from "./card-invalidation.js";

describe("registerCardInvalidation", () => {
  beforeEach(() => {
    vi.mocked(invalidateCustomerCard).mockClear();
  });

  it("invalidates the customer's card on activity.created (email/note/payment)", () => {
    const off = registerCardInvalidation();
    events.emit("activity.created", {
      activityId: "a1",
      customerId: "cust-1",
      kind: "email_in",
    });
    expect(invalidateCustomerCard).toHaveBeenCalledWith("cust-1");
    off();
  });

  it("invalidates on a phone-communication.received event", () => {
    const off = registerCardInvalidation();
    events.emit("phone-communication.received", {
      customerId: "cust-2",
      communicationId: "comm-1",
      kind: "call_in",
    });
    expect(invalidateCustomerCard).toHaveBeenCalledWith("cust-2");
    off();
  });

  it("stops invalidating after unsubscribe", () => {
    const off = registerCardInvalidation();
    off();
    events.emit("activity.created", {
      activityId: "a2",
      customerId: "cust-3",
      kind: "manual_note",
    });
    expect(invalidateCustomerCard).not.toHaveBeenCalled();
  });
});
