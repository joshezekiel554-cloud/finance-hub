import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const SECRET = "s".repeat(40);
vi.mock("../../lib/env.js", () => ({
  env: {
    HUB_SECRET_FINANCE: "s".repeat(40),
    HUB_SSO_SECRET: undefined,
    HUB_SHARED_SECRET_RETIRED: false,
    ADMIN_EMAILS: "josh@feldart.com",
    HOLDORDERS_EMAILS: "sales@feldart.com",
    ALLOWED_EMAILS: "josh@feldart.com,hillel@feldart.com",
  },
}));

import { mintHubToken } from "../../lib/hub-token.js";
import extHoldOrdersRoute from "./ext-holdorders.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(extHoldOrdersRoute, { prefix: "/api/ext" });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

function tokenFor(email: string): string {
  return mintHubToken({ email, aud: "finance", scope: "service", ttlSeconds: 60, secret: SECRET });
}

const call = (auth?: string) =>
  app.inject({ method: "GET", url: "/api/ext/holdorders/access", headers: auth ? { authorization: auth } : {} });

describe("GET /api/ext/holdorders/access", () => {
  it("admin / holds / nobody", async () => {
    expect((await call(`Bearer ${tokenFor("josh@feldart.com")}`)).json()).toEqual({ allowed: true, role: "admin" });
    expect((await call(`Bearer ${tokenFor("sales@feldart.com")}`)).json()).toEqual({ allowed: true, role: "holds" });
    const other = await call(`Bearer ${tokenFor("hillel@feldart.com")}`);
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual({ allowed: false, role: null });
  });
  it("bad / missing token → 401", async () => {
    expect((await call()).statusCode).toBe(401);
    expect((await call("Bearer nope")).statusCode).toBe(401);
  });
});
