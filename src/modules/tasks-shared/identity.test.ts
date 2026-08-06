import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InboxMember } from "../../integrations/inbox/members.js";

// Mock only the network-touching roster fetch; keep the REAL staff predicate so
// the gate below is tested against actual role semantics, not a stub of them.
const listMembersMock = vi.hoisted(() => vi.fn());
vi.mock("../../integrations/inbox/members.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../integrations/inbox/members.js")>();
  return { ...actual, listMembers: listMembersMock };
});

import {
  financeUserToMemberFrom,
  findMemberForActorEmailFrom,
  financeUserToMember,
  findMemberForActorEmail,
  requireMemberForUser,
  NoInboxAccountError,
  NonStaffMemberError,
} from "./identity.js";

function member(p: Partial<InboxMember> & { teamMemberId: string }): InboxMember {
  return {
    teamMemberId: p.teamMemberId,
    name: p.name ?? "Test Member",
    email: p.email ?? "",
    googleEmail: p.googleEmail ?? "",
    role: p.role ?? "member",
    staff: p.staff,
    active: p.active ?? true,
  };
}

const HILLEL = member({
  teamMemberId: "tm-hillel",
  name: "Hillel",
  email: "hillel@feldart.com",
  googleEmail: "", // blank googleEmail — login == email
});

const YINON = member({
  teamMemberId: "tm-yinon",
  name: "Yinon",
  email: "yinon@feldart.com",
  googleEmail: "yinon.personal@gmail.com", // login differs from primary email
});

const ROSTER = [HILLEL, YINON];

describe("financeUserToMemberFrom (pure)", () => {
  it("matches on email case-insensitively", () => {
    expect(
      financeUserToMemberFrom(ROSTER, { email: "HILLEL@Feldart.com" }),
    ).toBe(HILLEL);
  });

  it("matches on googleEmail when it differs from the primary email", () => {
    expect(
      financeUserToMemberFrom(ROSTER, { email: "Yinon.Personal@GMAIL.com" }),
    ).toBe(YINON);
  });

  it("still matches a member whose googleEmail is blank (via email)", () => {
    expect(
      financeUserToMemberFrom(ROSTER, { email: "hillel@feldart.com" }),
    ).toBe(HILLEL);
  });

  it("does NOT match a blank email against a member's blank googleEmail", () => {
    expect(financeUserToMemberFrom(ROSTER, { email: "" })).toBeNull();
    expect(financeUserToMemberFrom(ROSTER, { email: "   " })).toBeNull();
  });

  it("returns null on no match", () => {
    expect(
      financeUserToMemberFrom(ROSTER, { email: "stranger@example.com" }),
    ).toBeNull();
  });
});

describe("findMemberForActorEmailFrom (pure, reverse)", () => {
  it("resolves an actor email against email or googleEmail", () => {
    expect(findMemberForActorEmailFrom(ROSTER, "yinon.personal@gmail.com")).toBe(
      YINON,
    );
    expect(findMemberForActorEmailFrom(ROSTER, "HILLEL@FELDART.COM")).toBe(
      HILLEL,
    );
  });

  it("returns null when the actor email is unknown", () => {
    expect(findMemberForActorEmailFrom(ROSTER, "nobody@x.com")).toBeNull();
  });
});

describe("cache-backed wrappers", () => {
  beforeEach(() => {
    listMembersMock.mockReset();
    listMembersMock.mockResolvedValue(ROSTER);
  });

  it("financeUserToMember pulls the roster and resolves", async () => {
    await expect(
      financeUserToMember({ email: "hillel@feldart.com" }),
    ).resolves.toBe(HILLEL);
    expect(listMembersMock).toHaveBeenCalledOnce();
  });

  it("findMemberForActorEmail pulls the roster and resolves", async () => {
    await expect(
      findMemberForActorEmail("yinon.personal@gmail.com"),
    ).resolves.toBe(YINON);
  });

  it("requireMemberForUser returns the member when matched", async () => {
    await expect(
      requireMemberForUser({ email: "yinon@feldart.com" }),
    ).resolves.toBe(YINON);
  });

  it("requireMemberForUser throws NoInboxAccountError on no match", async () => {
    await expect(
      requireMemberForUser({ email: "stranger@example.com" }),
    ).rejects.toBeInstanceOf(NoInboxAccountError);
  });

  // The roster stays unfiltered on purpose (a guest owns tasks, so the
  // id→person join needs everyone) — the staff check lives at the gate. Today
  // only convention keeps an external address out of finance's ALLOWED_EMAILS;
  // this makes it a check, so a mistaken allow-list edit can't hand an outside
  // collaborator finance task-create in two hops.
  describe("guest gate", () => {
    const GUEST = member({
      teamMemberId: "tm-guest",
      name: "Alexander",
      email: "abocenuk@gmail.com",
      googleEmail: "abocenuk@gmail.com",
      role: "GUEST",
    });

    beforeEach(() => {
      listMembersMock.mockResolvedValue([...ROSTER, GUEST]);
    });

    it("refuses a guest even when the roster resolves them", async () => {
      await expect(
        requireMemberForUser({ email: "abocenuk@gmail.com" }),
      ).rejects.toBeInstanceOf(NonStaffMemberError);
    });

    it("is caught by existing NoInboxAccountError handlers (fails closed)", async () => {
      await expect(
        requireMemberForUser({ email: "abocenuk@gmail.com" }),
      ).rejects.toBeInstanceOf(NoInboxAccountError);
    });

    it("trusts inbox's staff flag over the role string when present", async () => {
      // Inbox is the authority on its own role semantics: a role we'd read as
      // staff but inbox marks staff:false must still be refused.
      listMembersMock.mockResolvedValue([
        member({
          teamMemberId: "tm-odd",
          email: "odd@feldart.com",
          role: "MEMBER",
          staff: false,
        }),
      ]);
      await expect(
        requireMemberForUser({ email: "odd@feldart.com" }),
      ).rejects.toBeInstanceOf(NonStaffMemberError);
    });

    it("falls back to the role when an older inbox omits the flag", async () => {
      await expect(
        requireMemberForUser({ email: "yinon@feldart.com" }),
      ).resolves.toBe(YINON);
    });

    it("still resolves a guest for audit attribution", async () => {
      await expect(
        findMemberForActorEmail("abocenuk@gmail.com"),
      ).resolves.toBe(GUEST);
    });
  });
});
