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

  CRYPTO_KEY: z
    .string()
    .min(1, "CRYPTO_KEY is required (32 bytes = 64 hex chars)")
    .refine((v) => /^[0-9a-fA-F]{64}$/.test(v), "CRYPTO_KEY must be 64 hex chars (32 bytes)"),

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

  MONDAY_API_TOKEN: z.string().optional().default(""),
  MONDAY_ENABLED: boolish.default(false),

  SENTRY_DSN: z.string().optional().default(""),
});

export type Env = z.infer<typeof schema>;

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
  cached = result.data;
  return cached;
}

export const env = new Proxy({} as Env, {
  get(_, prop: string) {
    return loadEnv()[prop as keyof Env];
  },
});
