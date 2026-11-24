// A holds-only account (HOLDORDERS_EMAILS, not on ALLOWED_EMAILS) has a real
// session on holdorders.feldart.com — served by this same server — so every
// OTHER finance route must refuse it. Uses the REAL requireAuth (session
// lookup mocked at the db) against a real finance route (/api/orders/*).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const h = vi.hoisted(() => ({
  sessionUser: { id: "u1", email: "sales@feldart.com", name: null, image: null, emailVerified: null },
  history: vi.fn(async () => []),
}));

vi.mock("../../lib/env.js", () => ({
  env: {
    NODE_ENV: "test",
    DEV_USER_EMAIL: undefined,
    ADMIN_EMAILS: "josh@feldart.com",
    HOLDORDERS_EMAILS: "sales@feldart.com,both@feldart.com",
    ALLOWED_EMAILS: "josh@feldart.com,hillel@feldart.com,both@feldart.com",
  },
}));
vi.mock("../../db/index.js", () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () =>
      Promise.resolve([
        { sessionToken: "tok", expires: new Date(Date.now() + 86_400_000), user: h.sessionUser },
      ]),
  };
  return { db: { select: () => chain } };
});
vi.mock("../../modules/orders/hold-actions.js", () => ({
  releaseHold: vi.fn(),
  placeOnHold: vi.fn(),
  manualHold: vi.fn(),
  cancelHoldOrder: vi.fn(),
  dismissOrderReview: vi.fn(),
  getHoldHistory: h.history,
  pauseHoldLadder: vi.fn(),
}));

import ordersRoute from "./orders.js";

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  await app.register(ordersRoute, { prefix: "/api/orders" });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

const get = () =>
  app.inject({
    method: "GET",
    url: "/api/orders/o1/hold-history",
    headers: { cookie: "authjs.session-token=tok" },
  });

describe("finance routes vs holds-only accounts", () => {
  it("sales@ (holds-only) gets 403 from a finance API", async () => {
    h.sessionUser.email = "sales@feldart.com";
    const res = await get();
    expect(res.statusCode).toBe(403);
    expect(h.history).not.toHaveBeenCalled();
  });

  it("finance staff still get through", async () => {
    h.sessionUser.email = "hillel@feldart.com";
    expect((await get()).statusCode).toBe(200);
  });

  it("someone on BOTH lists is a full finance user", async () => {
    h.sessionUser.email = "both@feldart.com";
    expect((await get()).statusCode).toBe(200);
  });
});
