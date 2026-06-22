import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InboxMember } from "../../integrations/inbox/members.js";

// Mock the members module so the cache-backed wrappers don't hit the network.
const listMembersMock = vi.hoisted(() => vi.fn());
vi.mock("../../integrations/inbox/members.js", () => ({
  listMembers: listMembersMock,
}));

import {
  financeUserToMemberFrom,
  findMemberForActorEmailFrom,
  financeUserToMember,
  findMemberForActorEmail,
  requireMemberForUser,
  NoInboxAccountError,
} from "./identity.js";

function member(p: Partial<InboxMember> & { teamMemberId: string }): InboxMember {
  return {
    teamMemberId: p.teamMemberId,
    name: p.name ?? "Test Member",
    email: p.email ?? "",
    googleEmail: p.googleEmail ?? "",
    role: p.role ?? "member",
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
});
