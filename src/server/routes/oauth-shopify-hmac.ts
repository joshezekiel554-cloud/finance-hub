import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "~/lib/env.js";

// HMAC verification per Shopify's authorization-code-grant install flow.
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant#step-3-verify-the-installation
// All query params *except* `hmac` are sorted alphabetically, joined as
// `key=value&key=value`, then HMAC-SHA256'd with the app's client secret.
// Compare in constant time to prevent timing oracles.
export function verifyShopifyHmac(
  query: Record<string, string | string[] | undefined>,
  secret: string = env.SHOPIFY_CLIENT_SECRET,
): boolean {
  const provided = query.hmac;
  if (typeof provided !== "string" || provided.length === 0) return false;

  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(query)) {
    if (k === "hmac") continue;
    if (v === undefined) continue;
    entries.push([k, Array.isArray(v) ? v.join(",") : v]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const message = entries.map(([k, v]) => `${k}=${v}`).join("&");

  const expected = createHmac("sha256", secret).update(message).digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
