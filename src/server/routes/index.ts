import type { FastifyInstance } from "fastify";

// Routes are mounted as their owning agents land. Each module registers its own
// routes via a Fastify plugin and gets prefixed under /api here.

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/ping", async () => ({ ok: true, ts: Date.now() }));

  // Auth routes mount here once the auth task lands:
  //   await app.register(authRoutes, { prefix: "/api/auth" });
  // OAuth callback routes (QB, Google):
  //   await app.register(oauthRoutes, { prefix: "/oauth" });
  // Per-module API routes:
  //   await app.register(customersRoutes, { prefix: "/api/customers" });
  //   await app.register(invoicingRoutes, { prefix: "/api/invoicing" });
  //   ... etc
}
