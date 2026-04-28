import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { nanoid } from "nanoid";
import { db } from "~/db/index.js";
import { oauthTokens, type OAuthProvider } from "~/db/schema/oauth.js";
import { encrypt } from "~/lib/crypto.js";
import { requireAuth } from "../lib/auth.js";

const PROVIDERS = ["quickbooks", "gmail", "shopify"] as const;

const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  // QuickBooks returns realmId; other providers may pass extra params we ignore.
  realmId: z.string().optional(),
  shop: z.string().optional(),
});

// TODO(week-3): replace placeholder with real per-provider token exchange.
// For now: validate state, accept code, store an encrypted placeholder so the
// pipeline can be wired through end-to-end without external dependencies.
async function exchangeCodeForTokens(
  provider: OAuthProvider,
  code: string,
  query: { realmId?: string; shop?: string },
): Promise<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  externalAccountId: string;
  scope: string | null;
}> {
  const externalAccountId =
    provider === "quickbooks"
      ? query.realmId ?? "unknown-realm"
      : provider === "shopify"
      ? query.shop ?? "unknown-shop"
      : `gmail:${code.slice(0, 8)}`;

  return {
    accessToken: `placeholder:${provider}:${code}`,
    refreshToken: `placeholder-refresh:${provider}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    externalAccountId,
    scope: null,
  };
}

async function consumeState(
  provider: OAuthProvider,
  state: string,
): Promise<{ userId: string } | null> {
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.pendingStateNonce, state))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.provider !== provider) return null;
  if (!row.pendingStateExpiresAt || row.pendingStateExpiresAt.getTime() < Date.now()) return null;
  return { userId: row.pendingStateUserId ?? "unknown" };
}

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
      return reply.code(400).send({ error: "missing code or state", details: parse.error.flatten() });
    }
    const { code, state, realmId, shop } = parse.data;

    const stateRow = await consumeState(provider, state);
    if (!stateRow) {
      return reply.code(400).send({ error: "invalid or expired state" });
    }

    const tokens = await exchangeCodeForTokens(provider, code, { realmId, shop });

    // TODO(week-3): UPDATE the pending row in place (matched by pendingStateNonce)
    // rather than INSERTing a second row. Today this leaves an orphan pending row
    // alongside the real token row for the same (provider, externalAccountId).
    await db.insert(oauthTokens).values({
      id: nanoid(24),
      provider,
      externalAccountId: tokens.externalAccountId,
      accessTokenEnc: encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    });

    return reply.send({ ok: true, provider, externalAccountId: tokens.externalAccountId });
  });
};

export default oauthRoutes;
