import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The token module reads env.TASKS_EMBED_SIGNING_SECRET. Mock the env module so
// the secret is deterministic (and so the test doesn't depend on the full env
// schema validating in CI). We mutate `secret` per-test to cover the unset case.
const state = vi.hoisted(() => ({
  secret: undefined as string | undefined,
}));
vi.mock("../../lib/env.js", () => ({
  env: new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === "TASKS_EMBED_SIGNING_SECRET") return state.secret;
        return undefined;
      },
    },
  ),
}));

import {
  mintViewerToken,
  verifyViewerToken,
  VIEWER_TOKEN_TTL_SECONDS,
  TasksEmbedSecretMissingError,
} from "./tasks-embed-token.js";

const SECRET = "test-secret-test-secret-test-secret-32";

beforeEach(() => {
  state.secret = SECRET;
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("tasks-embed-token", () => {
  it("round-trips mint → verify", () => {
    const token = mintViewerToken("alice@feldart.com");
    const result = verifyViewerToken(token);
    expect(result).toEqual({ email: "alice@feldart.com" });
  });

  it("produces NO base64 padding in either segment", () => {
    const token = mintViewerToken("someone.with.a.longish+alias@feldart.com");
    expect(token).not.toContain("=");
    const [seg1, sig] = token.split(".");
    expect(seg1).toBeTruthy();
    expect(sig).toBeTruthy();
    // URL-safe alphabet only (no '+' or '/').
    expect(token).not.toMatch(/[+/]/);
  });

  it("sets exp = now + TTL seconds (unix SECONDS)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T12:00:00.000Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const token = mintViewerToken("bob@feldart.com");
    // Decode seg1 to read exp.
    const seg1 = token.split(".")[0]!;
    const b64 = seg1.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      email: string;
      exp: number;
    };
    expect(payload.exp).toBe(nowSec + VIEWER_TOKEN_TTL_SECONDS);
  });

  it("returns null for a tampered signature", () => {
    const token = mintViewerToken("alice@feldart.com");
    const [seg1, sig] = token.split(".");
    // Flip the last char of the signature (stay in the base64url alphabet).
    const lastChar = sig!.slice(-1);
    const swapped = lastChar === "A" ? "B" : "A";
    const tampered = `${seg1}.${sig!.slice(0, -1)}${swapped}`;
    expect(verifyViewerToken(tampered)).toBeNull();
  });

  it("returns null for an expired token", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-22T12:00:00.000Z"));
    const token = mintViewerToken("alice@feldart.com");
    // Advance past the 5-min TTL.
    vi.setSystemTime(Date.now() + (VIEWER_TOKEN_TTL_SECONDS + 1) * 1000);
    expect(verifyViewerToken(token)).toBeNull();
  });

  it("returns null for a malformed token (no dot)", () => {
    expect(verifyViewerToken("not-a-token")).toBeNull();
    expect(verifyViewerToken("")).toBeNull();
    expect(verifyViewerToken(".sigonly")).toBeNull();
    expect(verifyViewerToken("seg1only.")).toBeNull();
  });

  it("throws TasksEmbedSecretMissingError when the secret is unset", () => {
    state.secret = undefined;
    expect(() => mintViewerToken("alice@feldart.com")).toThrow(
      TasksEmbedSecretMissingError,
    );
  });

  // KNOWN-VECTOR: locks the exact wire format so any drift (encoding, HMAC
  // input, padding) is caught here AND must byte-match inbox's verify.
  // secret="test-secret-test-secret-test-secret-32", email="alice@feldart.com",
  // exp=1750000000 (fixed) → this exact token string.
  it("matches the locked known-vector token string", () => {
    vi.useFakeTimers();
    // Date.now()/1000 must floor to (1750000000 - TTL) so exp lands on 1750000000.
    const nowMs = (1750000000 - VIEWER_TOKEN_TTL_SECONDS) * 1000;
    vi.setSystemTime(new Date(nowMs));
    const token = mintViewerToken("alice@feldart.com");
    expect(token).toBe(
      "eyJlbWFpbCI6ImFsaWNlQGZlbGRhcnQuY29tIiwiZXhwIjoxNzUwMDAwMDAwfQ.x3cZ6kOGE8Ju0PrnX0kl0NRmdilj65PZhpvYxwb0Rf0",
    );
  });
});
