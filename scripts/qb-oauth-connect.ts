// One-off helper to start the QBO OAuth flow without going through the
// auth-gated /oauth/start endpoint. Generates a state nonce, inserts the
// pending oauth_tokens row, prints the Intuit authorize URL.
//
// Run: npx tsx scripts/qb-oauth-connect.ts
//
// Click the printed URL → approve in QBO → Intuit redirects to
//   http://localhost:3001/api/oauth/callback/quickbooks?code=...&state=...&realmId=...
// Server exchanges code for token via intuit-oauth and saves it. Done.
import "dotenv/config";
import OAuthClient from "intuit-oauth";
import { nanoid } from "nanoid";
import { db } from "../src/db/index.js";
import { oauthTokens } from "../src/db/schema/oauth.js";
import { encrypt } from "../src/lib/crypto.js";
import { env } from "../src/lib/env.js";

async function main() {
  const client = new OAuthClient({
    clientId: env.QB_CLIENT_ID,
    clientSecret: env.QB_CLIENT_SECRET,
    environment: "production",
    redirectUri: env.QB_REDIRECT_URI,
  });

  const nonce = nanoid(32);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await db.insert(oauthTokens).values({
    id: nanoid(24),
    provider: "quickbooks",
    externalAccountId: `pending:${nonce}`,
    accessTokenEnc: encrypt("pending"),
    refreshTokenEnc: null,
    expiresAt: null,
    pendingStateNonce: nonce,
    pendingStateExpiresAt: expiresAt,
    pendingStateUserId: "dev-script",
  });

  const authUri = client.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: nonce,
  });

  const banner = "=".repeat(72);
  console.log(`\n${banner}`);
  console.log("QuickBooks OAuth — open this URL in your browser:");
  console.log(banner);
  console.log(`\n${authUri}\n`);
  console.log(banner);
  console.log("After you approve in QBO:");
  console.log("  - Intuit redirects to your /api/oauth/callback/quickbooks");
  console.log("  - Server exchanges the code for an access + refresh token");
  console.log("  - Token is saved to oauth_tokens (independent of 1.0)");
  console.log("  - Browser shows a success page");
  console.log(`\nState nonce expires in 10 minutes (${expiresAt.toISOString()}).`);
  console.log(`${banner}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
  });
