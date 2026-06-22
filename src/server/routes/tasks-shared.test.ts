// Shared-task CREATE tests (M2). The route handlers 400 on safeParse failure,
// so the zod schema IS the rejection contract; and the create helper is pure of
// HTTP framing, so we mock the identity bridge + inbox client to assert it
// resolves the creator → member and forwards `actingMemberId`. Error mapping
// (no-account → 409, unreachable → 503, api → 502) is exercised against the
// helper's thrown errors, which the route maps 1:1.

import { beforeEach, describe, expect, it, vi } from "vitest";

const requireMemberForUser = vi.hoisted(() => vi.fn());
const inboxFetch = vi.hoisted(() => vi.fn());

vi.mock("../../modules/tasks-shared/identity.js", async () => {
  // Keep the real error class so `instanceof` checks in the route match.
  const actual = await vi.importActual<
    typeof import("../../modules/tasks-shared/identity.js")
  >("../../modules/tasks-shared/identity.js");
  return { ...actual, requireMemberForUser };
});

vi.mock("../../integrations/inbox/client.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../integrations/inbox/client.js")
  >("../../integrations/inbox/client.js");
  return { ...actual, inboxFetch };
});

// listMembers is unused by the helper but imported by the route module; stub it
// so the module loads without touching the network.
vi.mock("../../integrations/inbox/members.js", () => ({
  listMembers: vi.fn(async () => []),
}));

import {
  sharedCreateBodySchema,
  createSharedTaskForUser,
} from "./tasks.js";
import { NoInboxAccountError } from "../../modules/tasks-shared/identity.js";
import {
  InboxUnreachableError,
  InboxApiError,
} from "../../integrations/inbox/client.js";

beforeEach(() => {
  vi.clearAllMocks();
  requireMemberForUser.mockResolvedValue({
    teamMemberId: "tm-boss",
    name: "Boss",
    email: "boss@feldart.com",
    googleEmail: "",
    role: "admin",
    active: true,
  });
  inboxFetch.mockResolvedValue({
    task: {
      id: "task-1",
      title: "Chase Acme",
      status: "open",
      priority: "normal",
      dueAt: null,
      financeCustomerId: null,
      ownerId: null,
    },
  });
});

describe("sharedCreateBodySchema", () => {
  it("requires a non-empty title", () => {
    expect(sharedCreateBodySchema.safeParse({}).success).toBe(false);
    expect(sharedCreateBodySchema.safeParse({ title: "" }).success).toBe(false);
    expect(sharedCreateBodySchema.safeParse({ title: "   " }).success).toBe(false);
  });

  it("accepts a minimal body (title only)", () => {
    const r = sharedCreateBodySchema.safeParse({ title: "Do the thing" });
    expect(r.success).toBe(true);
  });

  it("rejects a non-ISO dueAt", () => {
    const r = sharedCreateBodySchema.safeParse({
      title: "x",
      dueAt: "next tuesday",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-ISO reminderAt", () => {
    const r = sharedCreateBodySchema.safeParse({
      title: "x",
      reminderAt: "2026-13-40",
    });
    expect(r.success).toBe(false);
  });

  it("accepts ISO dueAt/reminderAt + nullable owner/customer", () => {
    const r = sharedCreateBodySchema.safeParse({
      title: "x",
      ownerId: null,
      financeCustomerId: null,
      dueAt: "2026-07-01T09:00:00.000Z",
      reminderAt: "2026-06-30T09:00:00.000Z",
      priority: "high",
    });
    expect(r.success).toBe(true);
  });

  it("rejects an unknown priority", () => {
    const r = sharedCreateBodySchema.safeParse({
      title: "x",
      priority: "super-urgent",
    });
    expect(r.success).toBe(false);
  });
});

describe("createSharedTaskForUser", () => {
  it("resolves the creator → member and forwards actingMemberId", async () => {
    await createSharedTaskForUser(
      { email: "boss@feldart.com" },
      { title: "Chase Acme", ownerId: "tm-staff", financeCustomerId: "cust_9" },
    );

    expect(requireMemberForUser).toHaveBeenCalledWith({
      email: "boss@feldart.com",
    });
    expect(inboxFetch).toHaveBeenCalledTimes(1);
    const [path, init] = inboxFetch.mock.calls[0]!;
    expect(path).toBe("/api/svc/tasks");
    expect(init.method).toBe("POST");
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({
      actingMemberId: "tm-boss",
      title: "Chase Acme",
      ownerId: "tm-staff",
      financeCustomerId: "cust_9",
    });
  });

  it("reconciles field names to the inbox model (body→notes, reminderAt→remindAt, priority enum)", async () => {
    await createSharedTaskForUser(
      { email: "boss@feldart.com" },
      {
        title: "x",
        body: "the description",
        reminderAt: "2026-06-30T09:00:00.000Z",
        priority: "high",
      },
    );
    const sent = JSON.parse(inboxFetch.mock.calls[0]![1].body as string);
    expect(sent.notes).toBe("the description");
    expect(sent.remindAt).toBe("2026-06-30T09:00:00.000Z");
    expect(sent.priority).toBe("IMPORTANT"); // finance "high" → inbox "IMPORTANT"
    // the finance-side field names must NOT leak to inbox
    expect("body" in sent).toBe(false);
    expect("reminderAt" in sent).toBe(false);
  });

  it("omits optional fields the caller didn't set", async () => {
    await createSharedTaskForUser(
      { email: "boss@feldart.com" },
      { title: "Just a title" },
    );
    const sent = JSON.parse(inboxFetch.mock.calls[0]![1].body as string);
    expect(sent).toEqual({ actingMemberId: "tm-boss", title: "Just a title" });
    expect("ownerId" in sent).toBe(false);
    expect("dueAt" in sent).toBe(false);
  });

  it("forwards an explicit null ownerId (unassign) when set", async () => {
    await createSharedTaskForUser(
      { email: "boss@feldart.com" },
      { title: "x", ownerId: null },
    );
    const sent = JSON.parse(inboxFetch.mock.calls[0]![1].body as string);
    expect(sent.ownerId).toBeNull();
  });

  it("returns the created task from inbox", async () => {
    const task = await createSharedTaskForUser(
      { email: "boss@feldart.com" },
      { title: "x" },
    );
    expect(task).toMatchObject({ id: "task-1", title: "Chase Acme" });
  });

  it("propagates NoInboxAccountError (route → 409)", async () => {
    requireMemberForUser.mockRejectedValue(
      new NoInboxAccountError("nobody@x.com"),
    );
    await expect(
      createSharedTaskForUser({ email: "nobody@x.com" }, { title: "x" }),
    ).rejects.toBeInstanceOf(NoInboxAccountError);
    expect(inboxFetch).not.toHaveBeenCalled();
  });

  it("propagates InboxUnreachableError (route → 503)", async () => {
    inboxFetch.mockRejectedValue(new InboxUnreachableError("down"));
    await expect(
      createSharedTaskForUser({ email: "boss@feldart.com" }, { title: "x" }),
    ).rejects.toBeInstanceOf(InboxUnreachableError);
  });

  it("propagates InboxApiError (route → 502)", async () => {
    inboxFetch.mockRejectedValue(new InboxApiError("bad", 500, ""));
    await expect(
      createSharedTaskForUser({ email: "boss@feldart.com" }, { title: "x" }),
    ).rejects.toBeInstanceOf(InboxApiError);
  });
});
