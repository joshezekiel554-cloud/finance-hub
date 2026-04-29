import type { FastifyInstance } from "fastify";
import { requireAuth } from "../lib/auth.js";
import oauthRoutes from "./oauth.js";
import invoicingRoutes from "./invoicing.js";
import eventsRoute from "./events.js";

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/ping", async () => ({ ok: true, ts: Date.now() }));

  app.get("/api/me", async (req) => {
    const user = await requireAuth(req);
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
      },
    };
  });

  await app.register(oauthRoutes, { prefix: "/api/oauth" });
  await app.register(invoicingRoutes, { prefix: "/api/invoicing" });
  await app.register(eventsRoute, { prefix: "/api/events" });

  // Per-module API routes mount here as their owning agents land:
  //   await app.register(customersRoutes, { prefix: "/api/customers" });
}
