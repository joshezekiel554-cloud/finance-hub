import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db } from "~/db/index.js";
import { oauthTokens, type OAuthProvider } from "~/db/schema/oauth.js";
import { encrypt } from "~/lib/crypto.js";
import { env } from "~/lib/env.js";
import { createLogger } from "~/lib/logger.js";
import { verifyShopifyHmac } from "./oauth-shopify-hmac.js";
import { requireAuth } from "../lib/auth.js";

const log = createLogger({ component: "oauth" });

const PROVIDERS = ["quickbooks", "gmail", "shopify"] as const;

// Shopify's managed-install flow does NOT send our pre-issued nonce, so `state`
// is optional. `hmac`/`timestamp`/`host` are Shopify-only. QB/Gmail still get
// validated against the pending-state row when state is present.
const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1).optional(),
  realmId: z.string().optional(),
  shop: z.string().optional(),
  hmac: z.string().optional(),
  timestamp: z.string().optional(),
  host: z.string().optional(),
});

type CallbackQuery = z.infer<typeof callbackQuerySchema>;

type ExchangedTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  externalAccountId: string;
  scope: string | null;
};

async function exchangeShopifyCode(code: string, shop: string): Promise<ExchangedTokens> {
  const url = `https://${shop}/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: env.SHOPIFY_CLIENT_ID,
      client_secret: env.SHOPIFY_CLIENT_SECRET,
      code,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Shopify token exchange failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as { access_token?: string; scope?: string };
  if (!json.access_token) {
    throw new Error("Shopify token exchange returned no access_token");
  }
  // Shopify offline tokens are permanent — no refresh, no expiry.
  return {
    accessToken: json.access_token,
    refreshToken: null,
    expiresAt: null,
    externalAccountId: shop,
    scope: json.scope ?? null,
  };
}

// TODO(week 4-5): real QuickBooks token exchange (intuit-oauth client.createToken).
async function exchangeQuickBooksCode(
  code: string,
  query: { realmId?: string },
): Promise<ExchangedTokens> {
  return {
    accessToken: `placeholder:quickbooks:${code}`,
    refreshToken: `placeholder-refresh:quickbooks`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    externalAccountId: query.realmId ?? "unknown-realm",
    scope: null,
  };
}

// TODO(week 4-5): real Gmail token exchange via googleapis OAuth2 client.
async function exchangeGmailCode(code: string): Promise<ExchangedTokens> {
  return {
    accessToken: `placeholder:gmail:${code}`,
    refreshToken: `placeholder-refresh:gmail`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    externalAccountId: `gmail:${code.slice(0, 8)}`,
    scope: null,
  };
}

// UPSERT into oauth_tokens keyed by (provider, externalAccountId). On hit,
// refresh the encrypted token columns, expiry, and scope, and clear any
// soft revocation. On miss, insert a new row.
async function saveExchangedTokens(
  provider: OAuthProvider,
  tokens: ExchangedTokens,
): Promise<void> {
  const existing = await db
    .select({ id: oauthTokens.id })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.provider, provider),
        eq(oauthTokens.externalAccountId, tokens.externalAccountId),
      ),
    )
    .limit(1);

  const accessTokenEnc = encrypt(tokens.accessToken);
  const refreshTokenEnc = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;

  if (existing[0]) {
    await db
      .update(oauthTokens)
      .set({
        accessTokenEnc,
        refreshTokenEnc,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        revokedAt: null,
      })
      .where(eq(oauthTokens.id, existing[0].id));
    return;
  }

  await db.insert(oauthTokens).values({
    id: nanoid(24),
    provider,
    externalAccountId: tokens.externalAccountId,
    accessTokenEnc,
    refreshTokenEnc,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
  });
}

// Atomically consumes the pending-state row keyed by (provider, nonce, not-yet-expired).
// We capture the userId *before* clearing the nonce, then clear within the same
// WHERE-bound UPDATE so a replayed callback finds nothing to consume. Returns
// null on any miss: unknown nonce, wrong provider, expired, or already consumed.
async function consumeState(
  provider: OAuthProvider,
  state: string,
): Promise<{ userId: string } | null> {
  const rows = await db
    .select({
      id: oauthTokens.id,
      userId: oauthTokens.pendingStateUserId,
    })
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.provider, provider),
        eq(oauthTokens.pendingStateNonce, state),
        isNotNull(oauthTokens.pendingStateExpiresAt),
        gt(oauthTokens.pendingStateExpiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const result = await db
    .update(oauthTokens)
    .set({
      pendingStateNonce: null,
      pendingStateExpiresAt: null,
      pendingStateUserId: null,
    })
    .where(
      and(
        eq(oauthTokens.id, row.id),
        eq(oauthTokens.pendingStateNonce, state),
      ),
    );

  const affected =
    Array.isArray(result) && result[0] && typeof (result[0] as { affectedRows?: number }).affectedRows === "number"
      ? (result[0] as { affectedRows: number }).affectedRows
      : 0;
  if (affected === 0) return null;

  return { userId: row.userId ?? "unknown" };
}

const SHOPIFY_SUCCESS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Shopify connected</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f6f7;margin:0;padding:48px;color:#202223}
.card{max-width:480px;margin:64px auto;background:#fff;border:1px solid #e1e3e5;border-radius:12px;padding:32px}
h1{margin:0 0 8px;font-size:20px;color:#008060}
p{margin:8px 0;line-height:1.5}</style></head>
<body><div class="card"><h1>Shopify connected</h1>
<p>The Finance Hub app is now installed. You can close this tab and return to the dashboard.</p>
</div></body></html>`;

const oauthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/start/:provider", async (req: FastifyRequest, reply: FastifyReply) => {
    const user = await requireAuth(req);
    const params = req.params as { provider: string };
    const provider = params.provider as OAuthProvider;
    if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
      return reply.code(404).send({ error: `unknown provider: ${provider}` });
    }

    const nonce = nanoid(32);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db.insert(oauthTokens).values({
      id: nanoid(24),
      provider,
      externalAccountId: `pending:${nonce}`,
      accessTokenEnc: encrypt("pending"),
      refreshTokenEnc: null,
      expiresAt: null,
      pendingStateNonce: nonce,
      pendingStateExpiresAt: expiresAt,
      pendingStateUserId: user.id,
    });

    // TODO(week-3): redirect to the actual provider authorize URL with `state=nonce`
    return reply.send({ ok: true, provider, state: nonce, todo: "build authorize URL" });
  });

  app.get("/callback/:provider", async (req: FastifyRequest, reply: FastifyReply) => {
    const params = req.params as { provider: string };
    const provider = params.provider as OAuthProvider;
    if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
      return reply.code(404).send({ error: `unknown provider: ${provider}` });
    }

    const parse = callbackQuerySchema.safeParse(req.query);
    if (!parse.success) {
      return reply.code(400).send({ error: "missing code", details: parse.error.flatten() });
    }
    const query: CallbackQuery = parse.data;

    if (provider === "shopify") {
      if (!query.shop) {
        return reply.code(400).send({ error: "missing shop" });
      }
      // HMAC verification is security-critical: reject anything not signed by Shopify.
      if (!verifyShopifyHmac(req.query as Record<string, string | string[] | undefined>)) {
        log.warn({ shop: query.shop }, "shopify callback rejected: bad hmac");
        return reply.code(401).send({ error: "invalid hmac" });
      }

      let tokens: ExchangedTokens;
      try {
        tokens = await exchangeShopifyCode(query.code, query.shop);
      } catch (err) {
        log.error({ err, shop: query.shop }, "shopify token exchange failed");
        return reply.code(502).send({ error: "shopify token exchange failed" });
      }

      await saveExchangedTokens("shopify", tokens);
      log.info(
        { shop: tokens.externalAccountId, scope: tokens.scope },
        "shopify oauth installed",
      );

      return reply.type("text/html").send(SHOPIFY_SUCCESS_HTML);
    }

    // QuickBooks / Gmail: still go through the pre-issued nonce flow.
    if (!query.state) {
      return reply.code(400).send({ error: "missing state" });
    }
    const stateRow = await consumeState(provider, query.state);
    if (!stateRow) {
      return reply.code(400).send({ error: "invalid or expired state" });
    }

    const tokens =
      provider === "quickbooks"
        ? await exchangeQuickBooksCode(query.code, { realmId: query.realmId })
        : await exchangeGmailCode(query.code);

    await saveExchangedTokens(provider, tokens);
    log.info(
      { provider, externalAccountId: tokens.externalAccountId },
      "oauth callback completed",
    );

    return reply.send({ ok: true, provider, externalAccountId: tokens.externalAccountId });
  });
};

export default oauthRoutes;
