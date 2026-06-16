import { describe, expect, it } from "vitest";
import { checkBearerToken } from "./service-auth.js";

const TOKEN = "a".repeat(64); // 64 hex chars, like `openssl rand -hex 32`

describe("checkBearerToken", () => {
  it("accepts the exact configured token", () => {
    expect(checkBearerToken(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    const wrong = "b".repeat(64);
    expect(checkBearerToken(`Bearer ${wrong}`, TOKEN)).toBe(false);
  });

  it("rejects a token of a different length", () => {
    expect(checkBearerToken(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(checkBearerToken(`Bearer ${TOKEN.slice(0, -1)}`, TOKEN)).toBe(false);
  });

  it("fails closed when no token is configured", () => {
    expect(checkBearerToken(`Bearer ${TOKEN}`, undefined)).toBe(false);
    expect(checkBearerToken(`Bearer ${TOKEN}`, "")).toBe(false);
  });

  it("rejects a missing or malformed Authorization header", () => {
    expect(checkBearerToken(undefined, TOKEN)).toBe(false);
    expect(checkBearerToken("", TOKEN)).toBe(false);
    expect(checkBearerToken(TOKEN, TOKEN)).toBe(false); // no "Bearer " prefix
    expect(checkBearerToken("Bearer ", TOKEN)).toBe(false); // empty token
    expect(checkBearerToken("Basic xyz", TOKEN)).toBe(false);
  });

  it("is case-sensitive on the scheme and value", () => {
    expect(checkBearerToken(`bearer ${TOKEN}`, TOKEN)).toBe(false);
    expect(checkBearerToken(`Bearer ${TOKEN.toUpperCase()}`, TOKEN)).toBe(
      false,
    );
  });
});
