import { describe, expect, it } from "vitest";
import { pickPromiseSource, promiseEmailUrl, threadIdFromMeta } from "./promise-link.js";

describe("promiseEmailUrl", () => {
  it("builds the hub inbox deep link (one place)", () => {
    expect(promiseEmailUrl("18c2f0a9b7e")).toBe(
      "https://hub.feldart.com/inbox?p=" + encodeURIComponent("/inbox/by-gmail/18c2f0a9b7e"),
    );
    expect(promiseEmailUrl("18c2f0a9b7e")).toBe("https://hub.feldart.com/inbox?p=%2Finbox%2Fby-gmail%2F18c2f0a9b7e");
  });
});

describe("pickPromiseSource", () => {
  const scan = (activityId: string, emailAt: string, promisedDate: string | null, threadId?: string) => ({
    activityId,
    emailAt,
    promisedDate,
    meta: threadId ? { threadId, gmailMessageId: `m-${activityId}` } : {},
  });

  it("no scans (promise typed by hand in the hub) → no link", () => {
    expect(pickPromiseSource([], "2026-12-01")).toBeNull();
  });

  it("prefers the newest scan whose promised date matches the customer's promise", () => {
    const r = pickPromiseSource(
      [
        scan("a1", "2026-11-01T10:00:00Z", "2026-12-01", "t-old-match"),
        scan("a2", "2026-11-10T10:00:00Z", "2026-12-01", "t-new-match"),
        scan("a3", "2026-11-20T10:00:00Z", "2026-12-15", "t-newest-other"),
      ],
      "2026-12-01",
    );
    expect(r).toMatchObject({ activityId: "a2", threadId: "t-new-match" });
    expect(r?.url).toBe(promiseEmailUrl("t-new-match"));
  });

  it("no date match → newest promise scan", () => {
    const r = pickPromiseSource(
      [scan("a1", "2026-11-01T10:00:00Z", "2026-11-20", "t1"), scan("a2", "2026-11-10T10:00:00Z", "2026-11-25", "t2")],
      "2026-12-01",
    );
    expect(r?.threadId).toBe("t2");
  });

  it("chosen scan has no Gmail thread id → no link", () => {
    expect(pickPromiseSource([scan("a1", "2026-11-01T10:00:00Z", "2026-12-01")], "2026-12-01")).toBeNull();
  });

  it("threadIdFromMeta ignores non-strings / blanks", () => {
    expect(threadIdFromMeta({ threadId: 5 })).toBeNull();
    expect(threadIdFromMeta({ threadId: "  " })).toBeNull();
    expect(threadIdFromMeta(null)).toBeNull();
    expect(threadIdFromMeta({ threadId: " t " })).toBe("t");
  });
});
