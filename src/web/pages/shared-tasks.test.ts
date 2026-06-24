// Security-boundary tests for the M6 token-refresh handshake gate. The
// responder mints a fresh edit token on a `need-token` postMessage — so the gate
// that decides whether to trust an incoming message is security-critical. We
// assert it accepts ONLY a message that is (a) from the exact inbox embed origin,
// (b) sourced from our own iframe window, and (c) the exact message type.

import { describe, expect, it } from "vitest";
import { isTokenRefreshRequest } from "./shared-tasks.js";

const INBOX_ORIGIN = "https://inbox.feldart.com";
// Stand-ins for window references — identity is all that matters to the gate.
const FRAME_WIN = { name: "ourFrame" } as unknown as Window;
const OTHER_WIN = { name: "evil" } as unknown as Window;

function evt(over: Partial<{ origin: string; source: unknown; data: unknown }>) {
  return {
    origin: INBOX_ORIGIN,
    source: FRAME_WIN,
    data: { type: "feldart-tasks:need-token" },
    ...over,
  } as Pick<MessageEvent, "origin" | "source" | "data">;
}

describe("isTokenRefreshRequest", () => {
  it("accepts a genuine need-token from our iframe at the inbox origin", () => {
    expect(isTokenRefreshRequest(evt({}), INBOX_ORIGIN, FRAME_WIN)).toBe(true);
  });

  it("rejects a message from a DIFFERENT origin (spoofed sender)", () => {
    expect(
      isTokenRefreshRequest(
        evt({ origin: "https://evil.example.com" }),
        INBOX_ORIGIN,
        FRAME_WIN,
      ),
    ).toBe(false);
  });

  it("rejects a message whose source is NOT our iframe window", () => {
    expect(
      isTokenRefreshRequest(evt({ source: OTHER_WIN }), INBOX_ORIGIN, FRAME_WIN),
    ).toBe(false);
  });

  it("rejects when our iframe window is not mounted yet", () => {
    expect(isTokenRefreshRequest(evt({}), INBOX_ORIGIN, null)).toBe(false);
    expect(isTokenRefreshRequest(evt({}), INBOX_ORIGIN, undefined)).toBe(false);
  });

  it("rejects when the embed origin is unknown (null)", () => {
    expect(isTokenRefreshRequest(evt({}), null, FRAME_WIN)).toBe(false);
  });

  it("rejects an unexpected / missing message type", () => {
    expect(
      isTokenRefreshRequest(evt({ data: { type: "feldart-tasks:token" } }), INBOX_ORIGIN, FRAME_WIN),
    ).toBe(false);
    expect(
      isTokenRefreshRequest(evt({ data: { type: "something-else" } }), INBOX_ORIGIN, FRAME_WIN),
    ).toBe(false);
    expect(isTokenRefreshRequest(evt({ data: null }), INBOX_ORIGIN, FRAME_WIN)).toBe(false);
    expect(isTokenRefreshRequest(evt({ data: "raw-string" }), INBOX_ORIGIN, FRAME_WIN)).toBe(false);
  });

  it("rejects when origin matches but is the FINANCE parent (not the embed)", () => {
    // A message from our own parent origin must not be treated as the embed's.
    expect(
      isTokenRefreshRequest(
        evt({ origin: "https://finance.feldart.com" }),
        INBOX_ORIGIN,
        FRAME_WIN,
      ),
    ).toBe(false);
  });
});
