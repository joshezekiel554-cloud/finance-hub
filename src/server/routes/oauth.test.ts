import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyShopifyHmac } from "./oauth-shopify-hmac.js";

const SECRET = "test-client-secret-1234567890";

function signShopifyParams(
  params: Record<string, string>,
  secret: string,
): Record<string, string> {
  const message = Object.keys(params)
    .filter((k) => k !== "hmac")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const hmac = createHmac("sha256", secret).update(message).digest("hex");
  return { ...params, hmac };
}

describe("verifyShopifyHmac", () => {
  it("accepts a correctly signed query", () => {
    const signed = signShopifyParams(
      {
        code: "abc123",
        shop: "feldart-usa.myshopify.com",
        timestamp: "1700000000",
        host: "example",
      },
      SECRET,
    );
    expect(verifyShopifyHmac(signed, SECRET)).toBe(true);
  });

  it("rejects a tampered query", () => {
    const signed = signShopifyParams(
      { code: "abc123", shop: "feldart-usa.myshopify.com" },
      SECRET,
    );
    expect(verifyShopifyHmac({ ...signed, code: "tampered" }, SECRET)).toBe(false);
  });

  it("rejects a missing hmac", () => {
    expect(
      verifyShopifyHmac({ code: "abc", shop: "feldart-usa.myshopify.com" }, SECRET),
    ).toBe(false);
  });

  it("rejects an hmac signed with a different secret", () => {
    const bogus = signShopifyParams(
      { code: "abc123", shop: "feldart-usa.myshopify.com" },
      "wrong-secret",
    );
    expect(verifyShopifyHmac(bogus, SECRET)).toBe(false);
  });
});
