import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the client's fetch wrapper so the cache logic is tested with no network.
const inboxFetchMock = vi.hoisted(() => vi.fn());
vi.mock("./client.js", () => ({
  inboxFetch: inboxFetchMock,
}));

vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  listMembers,
  resolveMemberByEmail,
  resolveMemberById,
  clearMembersCache,
} from "./members.js";

const RAW = {
  members: [
    {
      teamMemberId: "tm-1",
      name: "Hillel",
      email: "hillel@feldart.com",
      googleEmail: null, // wire can send null → normalized to ""
      role: "admin",
      active: true,
    },
    {
      teamMemberId: "tm-2",
      name: "Yinon",
      email: "yinon@feldart.com",
      googleEmail: "yinon.personal@gmail.com",
      role: "member",
      active: true,
    },
  ],
};

describe("members cache", () => {
  beforeEach(() => {
    clearMembersCache();
    inboxFetchMock.mockReset();
    inboxFetchMock.mockResolvedValue(RAW);
    vi.useRealTimers();
  });

  it("normalizes null/undefined googleEmail to empty string", async () => {
    const members = await listMembers();
    expect(members[0]?.googleEmail).toBe("");
    expect(members[1]?.googleEmail).toBe("yinon.personal@gmail.com");
  });

  it("returns cached members within the TTL (single fetch)", async () => {
    await listMembers();
    await listMembers();
    await listMembers();
    expect(inboxFetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    vi.useFakeTimers();
    inboxFetchMock.mockResolvedValue(RAW);

    await listMembers();
    expect(inboxFetchMock).toHaveBeenCalledTimes(1);

    // Advance past the 5-min TTL.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await listMembers();
    expect(inboxFetchMock).toHaveBeenCalledTimes(2);
  });

  it("force=true bypasses the cache", async () => {
    await listMembers();
    await listMembers(true);
    expect(inboxFetchMock).toHaveBeenCalledTimes(2);
  });

  it("tolerates a missing members array", async () => {
    inboxFetchMock.mockResolvedValueOnce({});
    await expect(listMembers()).resolves.toEqual([]);
  });
});

describe("resolveMemberByEmail", () => {
  beforeEach(() => {
    clearMembersCache();
    inboxFetchMock.mockReset();
    inboxFetchMock.mockResolvedValue(RAW);
  });

  it("matches on email case-insensitively", async () => {
    const m = await resolveMemberByEmail("HILLEL@feldart.com");
    expect(m?.teamMemberId).toBe("tm-1");
  });

  it("matches on googleEmail", async () => {
    const m = await resolveMemberByEmail("yinon.personal@gmail.com");
    expect(m?.teamMemberId).toBe("tm-2");
  });

  it("returns null on no match and on blank input", async () => {
    expect(await resolveMemberByEmail("nobody@x.com")).toBeNull();
    expect(await resolveMemberByEmail("")).toBeNull();
  });
});

describe("resolveMemberById", () => {
  beforeEach(() => {
    clearMembersCache();
    inboxFetchMock.mockReset();
    inboxFetchMock.mockResolvedValue(RAW);
  });

  it("resolves a known id and returns null for unknown", async () => {
    expect((await resolveMemberById("tm-2"))?.name).toBe("Yinon");
    expect(await resolveMemberById("tm-nope")).toBeNull();
  });
});
