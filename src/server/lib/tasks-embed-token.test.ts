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
  mintEditToken,
  verifyViewerToken,
  VIEWER_TOKEN_TTL_SECONDS,
  EDIT_TOKEN_TTL_SECONDS,
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
  it("round-trips mint → verify (read token defaults to scope 'view')", () => {
    const token = mintViewerToken("alice@feldart.com");
    const result = verifyViewerToken(token);
    expect(result).toEqual({ email: "alice@feldart.com", scope: "view" });
  });

  it("read token payload omits the scope field entirely (byte-compat)", () => {
    const token = mintViewerToken("alice@feldart.com");
    const seg1 = token.split(".")[0]!;
    const b64 = seg1.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    expect("scope" in payload).toBe(false);
  });

  it("edit token round-trips with scope 'edit' + the 30-min TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T12:00:00.000Z"));
    const nowSec = Math.floor(Date.now() / 1000);
    const token = mintEditToken("alice@feldart.com");
    expect(verifyViewerToken(token)).toEqual({
      email: "alice@feldart.com",
      scope: "edit",
    });
    const seg1 = token.split(".")[0]!;
    const b64 = seg1.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
      exp: number;
      scope: string;
    };
    expect(payload.scope).toBe("edit");
    expect(payload.exp).toBe(nowSec + EDIT_TOKEN_TTL_SECONDS);
  });

  it("edit token also expires (30-min TTL enforced)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T12:00:00.000Z"));
    const token = mintEditToken("alice@feldart.com");
    vi.setSystemTime(Date.now() + (EDIT_TOKEN_TTL_SECONDS + 1) * 1000);
    expect(verifyViewerToken(token)).toBeNull();
  });

  it("rejects a properly-signed token carrying an out-of-enum scope", async () => {
    // Build a token with a VALID signature but scope:"superuser" so we exercise
    // the scope-allow-list branch (not the tamper branch). Re-create the exact
    // wire format with node crypto + the same secret.
    const { createHmac } = await import("node:crypto");
    const b64url = (buf: Buffer) =>
      buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    const payload = {
      email: "alice@feldart.com",
      exp: Math.floor(Date.now() / 1000) + 600,
      scope: "superuser",
    };
    const seg1 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
    const sig = b64url(createHmac("sha256", SECRET).update(seg1).digest());
    expect(verifyViewerToken(`${seg1}.${sig}`)).toBeNull();
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
