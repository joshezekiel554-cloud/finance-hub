// Complete the QBO OAuth handshake when the redirect URI is the Intuit
// playground (so our /callback handler never gets invoked).
//
// Run: npx tsx scripts/qb-oauth-complete.ts "<full callback URL pasted from browser>"
//
// The pasted URL looks like:
//   https://developer.intuit.com/v2/OAuth2Playground/RedirectUrl?code=AB11...&state=...&realmId=9341...
//
// We extract the params, hand the URL to intuit-oauth's createToken, encrypt,
// upsert into oauth_tokens. Independent of the /api/oauth/callback route —
// useful when Intuit refuses to register http://localhost in production
// redirect URIs.
import "dotenv/config";
import OAuthClient from "intuit-oauth";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../src/db/index.js";
import { oauthTokens } from "../src/db/schema/oauth.js";
import { encrypt } from "../src/lib/crypto.js";
import { env } from "../src/lib/env.js";

async function main() {
  const callbackUrl = process.argv[2];
  if (!callbackUrl) {
    console.error("Usage: npx tsx scripts/qb-oauth-complete.ts \"<full callback URL>\"");
    process.exit(2);
  }

  const parsed = new URL(callbackUrl);
  const realmId = parsed.searchParams.get("realmId");
  const code = parsed.searchParams.get("code");
  if (!realmId || !code) {
    console.error(`URL is missing required params (need code + realmId). Got: ${[...parsed.searchParams.keys()].join(", ")}`);
    process.exit(2);
  }

  const client = new OAuthClient({
    clientId: env.QB_CLIENT_ID,
    clientSecret: env.QB_CLIENT_SECRET,
    environment: "production",
    redirectUri: env.QB_REDIRECT_URI,
  });

  console.log(`Exchanging code for tokens (realmId=${realmId})...`);
  const result = await client.createToken(callbackUrl);
  const token = result.getJson() as {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
  };
  if (!token.access_token || !token.refresh_token) {
    throw new Error("createToken returned no access_token/refresh_token");
  }

  // Upsert keyed on (provider, realmId) — same shape as our normal callback.
  const existing = await db
    .select({ id: oauthTokens.id })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.provider, "quickbooks"),
        eq(oauthTokens.externalAccountId, realmId),
      ),
    )
    .limit(1);

  const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);
  const accessTokenEnc = encrypt(token.access_token);
  const refreshTokenEnc = encrypt(token.refresh_token);

  if (existing[0]) {
    await db
      .update(oauthTokens)
      .set({
        accessTokenEnc,
        refreshTokenEnc,
        expiresAt,
        scope: "com.intuit.quickbooks.accounting",
        revokedAt: null,
      })
      .where(eq(oauthTokens.id, existing[0].id));
    console.log(`Updated existing oauth_tokens row id=${existing[0].id}`);
  } else {
    const id = nanoid(24);
    await db.insert(oauthTokens).values({
      id,
      provider: "quickbooks",
      externalAccountId: realmId,
      accessTokenEnc,
      refreshTokenEnc,
      expiresAt,
      scope: "com.intuit.quickbooks.accounting",
    });
    console.log(`Inserted new oauth_tokens row id=${id}`);
  }

  // Sweep stale "pending" rows so they don't accumulate.
  const pending = await db
    .select({ id: oauthTokens.id, externalAccountId: oauthTokens.externalAccountId })
    .from(oauthTokens)
    .where(eq(oauthTokens.provider, "quickbooks"));
  const stale = pending.filter((p) =>
    p.externalAccountId.startsWith("pending:"),
  );
  for (const row of stale) {
    await db.delete(oauthTokens).where(eq(oauthTokens.id, row.id));
  }
  if (stale.length > 0) {
    console.log(`Cleaned up ${stale.length} stale pending state row(s)`);
  }

  console.log("\nDone. 2.0 now has its own QBO refresh chain.");
  console.log(`  realmId: ${realmId}`);
  console.log(`  expiresAt: ${expiresAt.toISOString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
  });
