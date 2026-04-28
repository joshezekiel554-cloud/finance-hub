// One-off: read 1.0's QBO + Gmail tokens, encrypt with 2.0's CRYPTO_KEY,
// upsert into oauth_tokens. Idempotent — safe to re-run.
//
// Run: npx tsx scripts/migrate-1.0-tokens.ts
import "dotenv/config";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../src/db/index.js";
import { oauthTokens } from "../src/db/schema/oauth.js";
import { encrypt } from "../src/lib/crypto.js";

const QB_TOKENS_PATH = "C:/Users/user/Documents/QuickBooksSync/qb-tokens.json";
const GMAIL_TOKENS_PATH =
  "C:/Users/user/Documents/QuickBooksSync/dashboard/gmail-tokens.json";

// Hardcoded — info@feldart.com is the inbox 1.0 polls (verified from
// .eml fixture's Delivered-To header).
const GMAIL_ACCOUNT_ID = "info@feldart.com";

type QbTokenFile = {
  access_token: string;
  refresh_token: string;
  realmId: string;
  expires_in: number;
  createdAt: string;
};

type GmailTokenFile = {
  access_token: string;
  refresh_token: string;
  scope: string;
  token_type: string;
  expiry_date: number;
};

async function upsert(args: {
  provider: "quickbooks" | "gmail";
  externalAccountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date | null;
  scope: string | null;
}) {
  const existing = await db
    .select({ id: oauthTokens.id })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.provider, args.provider),
        eq(oauthTokens.externalAccountId, args.externalAccountId),
      ),
    )
    .limit(1);

  const accessTokenEnc = encrypt(args.accessToken);
  const refreshTokenEnc = encrypt(args.refreshToken);

  if (existing[0]) {
    await db
      .update(oauthTokens)
      .set({
        accessTokenEnc,
        refreshTokenEnc,
        expiresAt: args.expiresAt,
        scope: args.scope,
        revokedAt: null,
      })
      .where(eq(oauthTokens.id, existing[0].id));
    console.log(
      `  updated ${args.provider} (${args.externalAccountId}) → id=${existing[0].id}`,
    );
    return;
  }

  const id = nanoid(24);
  await db.insert(oauthTokens).values({
    id,
    provider: args.provider,
    externalAccountId: args.externalAccountId,
    accessTokenEnc,
    refreshTokenEnc,
    expiresAt: args.expiresAt,
    scope: args.scope,
  });
  console.log(`  inserted ${args.provider} (${args.externalAccountId}) → id=${id}`);
}

async function main() {
  console.log("Migrating QBO tokens...");
  const qb: QbTokenFile = JSON.parse(readFileSync(QB_TOKENS_PATH, "utf-8"));
  const qbExpires = qb.createdAt
    ? new Date(new Date(qb.createdAt).getTime() + qb.expires_in * 1000)
    : new Date(Date.now() + qb.expires_in * 1000);
  await upsert({
    provider: "quickbooks",
    externalAccountId: qb.realmId,
    accessToken: qb.access_token,
    refreshToken: qb.refresh_token,
    expiresAt: qbExpires,
    scope: null,
  });

  console.log("\nMigrating Gmail tokens...");
  const gm: GmailTokenFile = JSON.parse(readFileSync(GMAIL_TOKENS_PATH, "utf-8"));
  await upsert({
    provider: "gmail",
    externalAccountId: GMAIL_ACCOUNT_ID,
    accessToken: gm.access_token,
    refreshToken: gm.refresh_token,
    expiresAt: new Date(gm.expiry_date),
    scope: gm.scope ?? null,
  });

  console.log("\nDone.");

  // Quick verify counts
  const all = await db.select().from(oauthTokens);
  console.log(`\noauth_tokens rows: ${all.length}`);
  for (const t of all) {
    console.log(
      `  - ${t.provider}: ${t.externalAccountId} (expires ${t.expiresAt?.toISOString() ?? "n/a"})`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
  });
