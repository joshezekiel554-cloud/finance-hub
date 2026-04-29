import type { FastifyInstance } from "fastify";
import { requireAuth } from "../lib/auth.js";
import oauthRoutes from "./oauth.js";
import invoicingRoutes from "./invoicing.js";
import eventsRoute from "./events.js";
import customersRoute from "./customers.js";
import tasksRoute from "./tasks.js";
import commentsRoute from "./comments.js";
import usersRoute from "./users.js";
import mentionsRoute from "./mentions.js";
import qbPdfRoute from "./qb-pdf.js";
import emailLogRoute from "./email-log.js";
import emailTemplatesRoute from "./email-templates.js";
import holdsRoute from "./holds.js";
import statementsRoute from "./statements.js";
import emailSendRoute from "./email-send.js";

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
  await app.register(customersRoute, { prefix: "/api/customers" });
  await app.register(tasksRoute, { prefix: "/api/tasks" });
  await app.register(commentsRoute, { prefix: "/api/comments" });
  await app.register(usersRoute, { prefix: "/api/users" });
  await app.register(mentionsRoute, { prefix: "/api/mentions" });
  await app.register(qbPdfRoute, { prefix: "/api/qb-pdf" });
  await app.register(emailLogRoute, { prefix: "/api/email-log" });
  await app.register(emailTemplatesRoute, { prefix: "/api/email-templates" });
  await app.register(holdsRoute, { prefix: "/api/customers" });
  await app.register(statementsRoute, { prefix: "/api/customers" });
  await app.register(emailSendRoute, { prefix: "/api" });

  // Per-module API routes mount here as their owning agents land:
  //   await app.register(customersRoutes, { prefix: "/api/customers" });
}
