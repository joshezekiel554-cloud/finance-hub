import "dotenv/config";
import { z } from "zod";

const boolish = z
  .union([z.string(), z.boolean()])
  .transform((v) => (typeof v === "boolean" ? v : v.toLowerCase() === "true"));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  PUBLIC_URL: z.string().url().default("http://localhost:3001"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1, "REDIS_URL is required"),

  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 chars"),
  AUTH_URL: z.string().url(),
  AUTH_GOOGLE_CLIENT_ID: z.string().min(1),
  AUTH_GOOGLE_CLIENT_SECRET: z.string().min(1),
  // Comma-separated allow-list of emails permitted to sign in. Lowercased.
  // Empty in dev is allowed (auth plugin warns); production should set this.
  ALLOWED_EMAILS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .join(","),
    ),

  CRYPTO_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "CRYPTO_KEY must be 64 hex chars (32 bytes)"),

  ANTHROPIC_API_KEY: z.string().min(1),

  QB_CLIENT_ID: z.string().min(1),
  QB_CLIENT_SECRET: z.string().min(1),
  QB_REALM_ID: z.string().min(1),
  QB_REDIRECT_URI: z.string().url(),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),

  SHOPIFY_STORE_DOMAIN: z.string().min(1),
  SHOPIFY_ADMIN_TOKEN: z.string().min(1),
  SHOPIFY_API_VERSION: z.string().min(1).default("2025-01"),
  SHOPIFY_CLIENT_ID: z.string().min(1),
  SHOPIFY_CLIENT_SECRET: z.string().min(1),

  MONDAY_API_TOKEN: z.string().optional().default(""),
  MONDAY_ENABLED: boolish.default(false),
  // Board id for the USA Stores Information board — source of truth for
  // a one-off terms backfill. After the sync the operator manages terms
  // inside this app, so this id is only used by the sync routes.
  MONDAY_TERMS_BOARD_ID: z.string().optional().default(""),

  SENTRY_DSN: z.string().optional().default(""),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .optional(),

  // Shadow mode: when true, write-side jobs (sending emails, mutating QBO,
  // mutating Shopify) short-circuit and only log what they would have done.
  // Read-side syncs (QB pull, Gmail poll) still run normally — the flag only
  // gates outbound effects. Defaults to true in dev/test, false in production
  // (resolved post-parse below).
  SHADOW_MODE: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === "boolean" ? v : v.toLowerCase() === "true"))
    .optional(),

  // Daily chase digest recipient. When SHADOW_MODE is false the digest job
  // emails this address. In shadow mode the value is logged but no email is
  // sent. Defaults empty so the digest job is a no-op until configured.
  CHASE_DIGEST_RECIPIENT: z.string().optional().default(""),

  // Dev-only auth bypass. When NODE_ENV !== production AND this email is
  // set, requireAuth synthesizes a session for the matching user (creating
  // the row on first use). Real Google OAuth is still wired and works in
  // parallel; this just skips the OAuth dance for local development. The
  // server logs a loud warning at boot when this is active. UNSET in
  // production — the auth helper hard-fails if both DEV_USER_EMAIL is set
  // and NODE_ENV is production.
  DEV_USER_EMAIL: z.string().email().optional(),
});

// SHADOW_MODE has a NODE_ENV-derived default applied in loadEnv(), so the
// cached env always has it as a concrete boolean — narrow the inferred type.
type RawEnv = z.infer<typeof schema>;
export type Env = Omit<RawEnv, "SHADOW_MODE"> & { SHADOW_MODE: boolean };

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;

  const result = schema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    console.error(`\nInvalid environment configuration:\n${issues}\n`);
    throw new Error("Environment validation failed. See errors above.");
  }
  // SHADOW_MODE defaults depend on NODE_ENV: dev/test → true, prod → false.
  // Done post-parse since zod's default() can't reference another field.
  const shadowMode =
    result.data.SHADOW_MODE ?? result.data.NODE_ENV !== "production";
  cached = { ...result.data, SHADOW_MODE: shadowMode };
  return cached;
}

export const env = new Proxy({} as Env, {
  get(_, prop: string) {
    return loadEnv()[prop as keyof Env];
  },
});
