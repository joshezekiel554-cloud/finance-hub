import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mintAppToHubToken, mintHubToken, verifyHubToken } from "./hub-token.js";

// Feldart Hub SSO handoff token (spec §4): `seg1.sig` where
//   seg1 = base64url(JSON{ email, exp, aud, jti, scope? })
//   sig  = base64url(HMAC-SHA256(HUB_SSO_SECRET, seg1))
// Byte-compatible with inbox's src/lib/embed-token.ts verifier.

const SECRET = "test-hub-sso-secret-at-least-32-chars-long";
const NOW = 1_800_000_000;

describe("verifyHubToken", () => {
  it("accepts a valid user token for its own audience", () => {
    const t = mintHubToken({ email: "leibel@feldart.com", aud: "finance", ttlSeconds: 300, nowSeconds: NOW, secret: SECRET });
    expect(verifyHubToken(t, { secret: SECRET, aud: "finance", nowSeconds: NOW + 10 })).toEqual({
      email: "leibel@feldart.com",
      aud: "finance",
      scope: "user",
      ops: false,
      pid: "",
      jti: expect.any(String),
    });
  });

  it("rejects an expired token", () => {
    const t = mintHubToken({ email: "a@b.c", aud: "finance", ttlSeconds: 300, nowSeconds: NOW, secret: SECRET });
    expect(verifyHubToken(t, { secret: SECRET, aud: "finance", nowSeconds: NOW + 301 })).toBeNull();
  });

  it("rejects a token minted for another app", () => {
    const t = mintHubToken({ email: "a@b.c", aud: "inbox", ttlSeconds: 300, nowSeconds: NOW, secret: SECRET });
    expect(verifyHubToken(t, { secret: SECRET, aud: "finance", nowSeconds: NOW })).toBeNull();
  });

  it("rejects a bad signature", () => {
    const t = mintHubToken({ email: "a@b.c", aud: "finance", ttlSeconds: 300, nowSeconds: NOW, secret: SECRET });
    const [seg1, sig] = t.split(".");
    const tampered = `${seg1}.${sig!.slice(0, -2)}xx`;
    expect(verifyHubToken(tampered, { secret: SECRET, aud: "finance", nowSeconds: NOW })).toBeNull();
    expect(verifyHubToken(t, { secret: "other-secret-that-is-also-32-chars-long!!", aud: "finance", nowSeconds: NOW })).toBeNull();
  });

  it("rejects garbage, empty secret, and payloads without email", () => {
    expect(verifyHubToken("", { secret: SECRET, aud: "finance", nowSeconds: NOW })).toBeNull();
    expect(verifyHubToken("nodot", { secret: SECRET, aud: "finance", nowSeconds: NOW })).toBeNull();
    const t = mintHubToken({ email: "a@b.c", aud: "finance", ttlSeconds: 300, nowSeconds: NOW, secret: SECRET });
    expect(verifyHubToken(t, { secret: "", aud: "finance", nowSeconds: NOW })).toBeNull();
    const seg1 = Buffer.from(JSON.stringify({ exp: NOW + 100, aud: "finance" })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(seg1).digest("base64url");
    expect(verifyHubToken(`${seg1}.${sig}`, { secret: SECRET, aud: "finance", nowSeconds: NOW })).toBeNull();
  });

  it("carries the service scope through and rejects unknown scopes", () => {
    const svc = mintHubToken({ email: "leibel@feldart.com", aud: "finance", ttlSeconds: 60, nowSeconds: NOW, secret: SECRET, scope: "service" });
    expect(verifyHubToken(svc, { secret: SECRET, aud: "finance", nowSeconds: NOW })?.scope).toBe("service");
    const seg1 = Buffer.from(JSON.stringify({ email: "a@b.c", exp: NOW + 100, aud: "finance", jti: "x", scope: "admin" })).toString("base64url");
    const sig = createHmac("sha256", SECRET).update(seg1).digest("base64url");
    expect(verifyHubToken(`${seg1}.${sig}`, { secret: SECRET, aud: "finance", nowSeconds: NOW })).toBeNull();
  });

  it("lower-cases the email so allow-list checks are case-insensitive", () => {
    const t = mintHubToken({ email: "Leibel@Feldart.com", aud: "finance", ttlSeconds: 300, nowSeconds: NOW, secret: SECRET });
    expect(verifyHubToken(t, { secret: SECRET, aud: "finance", nowSeconds: NOW })?.email).toBe("leibel@feldart.com");
  });
});

describe("mintAppToHubToken", () => {
  it("signs {aud:hub, iss:finance, exp, jti} with HMAC-SHA256 over seg1 (no padding)", () => {
    const t = mintAppToHubToken({ secret: SECRET, ttlSeconds: 120, nowSeconds: NOW, jti: "j1" });
    const [seg1, sig] = t.split(".");
    expect(seg1).toBeTruthy();
    expect(t).not.toContain("=");
    expect(JSON.parse(Buffer.from(seg1!, "base64url").toString())).toEqual({ aud: "hub", iss: "finance", exp: NOW + 120, jti: "j1" });
    expect(sig).toBe(createHmac("sha256", SECRET).update(seg1!).digest("base64url"));
  });

  it("caps the TTL at 300 s and mints a fresh jti each call", () => {
    const a = mintAppToHubToken({ secret: SECRET, ttlSeconds: 9999, nowSeconds: NOW });
    const b = mintAppToHubToken({ secret: SECRET, nowSeconds: NOW });
    const pa = JSON.parse(Buffer.from(a.split(".")[0]!, "base64url").toString()) as { exp: number; jti: string };
    const pb = JSON.parse(Buffer.from(b.split(".")[0]!, "base64url").toString()) as { exp: number; jti: string };
    expect(pa.exp).toBe(NOW + 300);
    expect(pb.exp).toBe(NOW + 60);
    expect(pa.jti).not.toBe(pb.jti);
  });
});
