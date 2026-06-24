// Tasks API. Shared-tasks surface only: the embedded inbox board iframe URL,
// the assignee/member roster, the "my tasks" proxy, and the shared-create
// endpoint. The finance-native Kanban (DB tables tasks/task_watchers) has been
// RETIRED — everything lives on the shared inbox board now.
//
// The board itself is inbox's UI; finance only mints the scoped token + proxies
// the assigned-to-me list + creates tasks against the inbox canonical store.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import { env } from "../../lib/env.js";
import {
  mintViewerToken,
  mintEditToken,
  TasksEmbedSecretMissingError,
} from "../lib/tasks-embed-token.js";
import {
  requireMemberForUser,
  NoInboxAccountError,
} from "../../modules/tasks-shared/identity.js";
import { listMembers } from "../../integrations/inbox/members.js";
import {
  inboxFetch,
  InboxUnreachableError,
  InboxApiError,
} from "../../integrations/inbox/client.js";
import {
  sharedCreateBodySchema,
  createSharedTaskForUser,
} from "../../modules/tasks-shared/create.js";

// Re-export the shared-create core (now in modules/tasks-shared/create.ts) so
// existing importers — incl. the route test — keep importing from "./tasks.js".
export {
  sharedCreateBodySchema,
  createSharedTaskForUser,
  FINANCE_TO_INBOX_PRIORITY,
  type SharedCreateBody,
  type InboxCreatedTask,
} from "../../modules/tasks-shared/create.js";

// --- Shared-tasks embed config (M1) ------------------------------------------
// The embedded inbox global-tasks board. Finance points an <iframe> at:
//   `${INBOX_PUBLIC_URL}${EMBED_PATH}?vt=${viewerToken}`
// Path CONFIRMED with inbox (2026-06-22): a DEDICATED chrome-free route OUTSIDE
// the session-gated /tasks layout — https://inbox.feldart.com/embed/tasks?vt=<token>
// (the vt token is the auth; no session/redirect on this path).
const EMBED_PATH = "/embed/tasks";

// embed-url ?mode= — "edit" mints the M6 write-scoped token, anything else (incl.
// absent) yields a read-only view token. Coerced + defaulted so a missing/odd
// value degrades safely to "view" rather than erroring.
const embedModeSchema = z
  .enum(["view", "edit"])
  .catch("view")
  .default("view");

// embed-url ?customer= — an optional finance customer id to scope the board to.
// Short (finance ids are nanoids); cap at 64 so we never forward an absurd value
// into the iframe URL. Absent/empty → undefined (no scoping).
const embedCustomerSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .optional();

// Shape of a task as the inbox `GET /api/svc/tasks` endpoint returns it (LOCKED
// contract with inbox). `ownerId` is the ASSIGNEE member id (the inbox model
// names the assignee "owner"). The "my tasks" widget only needs these fields.
type InboxMineTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  financeCustomerId: string | null;
  ownerId: string | null;
};
type InboxMineResponse = { tasks: InboxMineTask[] };

const log = createLogger({ component: "routes.tasks" });

const tasksRoute: FastifyPluginAsync = async (app) => {
  // --- Shared tasks (M1) -----------------------------------------------------
  // These endpoints back the embedded inbox tasks board + the dashboard
  // "My tasks" widget. The board itself is inbox's (the canonical store); finance
  // only mints the scoped token + proxies the assigned-to-me list + creates
  // tasks against inbox. The finance-native Kanban CRUD has been RETIRED.

  // GET /api/tasks/embed-url — mint a fresh short-lived token for the current
  // finance user and return the inbox board iframe URL scoped to them.
  //   ?mode=edit     → mint a 30-min EDIT-scoped token (M6 interactive embed:
  //                    open a task + edit core fields + drag-restatus). Inbox
  //                    gates all writes on scope === "edit".
  //   default        → mint a 5-min VIEW token (read-only embed).
  //   ?customer=<id> → scope the embedded board to one finance customer's tasks
  //                    + default new-task creation to that customer (the inbox
  //                    embed reads &customer=<financeCustomerId>). Optional;
  //                    powers the per-customer Tasks tab.
  app.get("/embed-url", async (req, reply) => {
    const user = await requireAuth(req);
    if (!user.email) {
      return reply.code(409).send({ error: "no_email_on_account" });
    }
    const query = (req.query as { mode?: unknown; customer?: unknown } | undefined) ?? {};
    const mode = embedModeSchema.parse(query.mode);
    // Optional customer scope — a short id (finance customer ids are nanoids).
    // Reject anything implausibly long rather than forward junk into the URL.
    const customer = embedCustomerSchema.safeParse(query.customer);
    if (!customer.success) {
      return reply
        .code(400)
        .send({ error: "invalid customer", details: customer.error.flatten() });
    }
    let token: string;
    try {
      token = mode === "edit" ? mintEditToken(user.email) : mintViewerToken(user.email);
    } catch (err) {
      if (err instanceof TasksEmbedSecretMissingError) {
        log.error("tasks embed secret not configured");
        return reply.code(503).send({ error: "tasks_not_configured" });
      }
      throw err;
    }
    let url = `${env.INBOX_PUBLIC_URL.replace(/\/+$/, "")}${EMBED_PATH}?vt=${encodeURIComponent(token)}`;
    if (customer.data) {
      url += `&customer=${encodeURIComponent(customer.data)}`;
    }
    return reply.send({ url, mode });
  });

  // GET /api/tasks/mine — proxy the current user's assigned tasks from inbox.
  // Resolves the finance user → inbox member (409 NoInboxAccount), then calls
  // inbox `GET /api/svc/tasks?mine`. Degrades to 503 when inbox is unreachable.
  app.get("/mine", async (req, reply) => {
    const user = await requireAuth(req);
    let member;
    try {
      member = await requireMemberForUser({ email: user.email ?? "" });
    } catch (err) {
      if (err instanceof NoInboxAccountError) {
        return reply.code(409).send({ error: "no_inbox_account", message: err.message });
      }
      if (err instanceof InboxUnreachableError) {
        return reply.code(503).send({ error: "inbox_unreachable" });
      }
      // A non-2xx from the inbox roster fetch is a sibling-service error, not a
      // finance bug — degrade to 502 rather than a 500.
      if (err instanceof InboxApiError) {
        return reply.code(502).send({ error: "inbox_error" });
      }
      throw err;
    }

    try {
      // Locked contract: convey WHO is acting (the service token authenticates
      // the app, not a user) — inbox derives admin + scopes visibility from
      // actingMemberId, and `mine=1` filters to ownerId == actingMemberId.
      const res = await inboxFetch<InboxMineResponse>(
        `/api/svc/tasks?actingMemberId=${encodeURIComponent(member.teamMemberId)}&mine=1`,
      );
      return reply.send({ tasks: res.tasks ?? [] });
    } catch (err) {
      if (err instanceof InboxUnreachableError) {
        return reply.code(503).send({ error: "inbox_unreachable" });
      }
      if (err instanceof InboxApiError) {
        return reply.code(502).send({ error: "inbox_error" });
      }
      throw err;
    }
  });

  // --- Shared tasks: members + create (M2) -----------------------------------

  // GET /api/tasks/members — the assignee picker source. Returns the inbox
  // roster filtered to active, trimmed to just {teamMemberId, name} (don't leak
  // emails/roles to the picker — it only needs to render names + send an id).
  app.get("/members", async (req, reply) => {
    await requireAuth(req);
    try {
      const all = await listMembers();
      const members = all
        .filter((m) => m.active)
        .map((m) => ({ teamMemberId: m.teamMemberId, name: m.name }));
      return reply.send({ members });
    } catch (err) {
      if (err instanceof InboxUnreachableError) {
        return reply.code(503).send({ error: "inbox_unreachable" });
      }
      if (err instanceof InboxApiError) {
        return reply.code(502).send({ error: "inbox_error" });
      }
      throw err;
    }
  });

  // POST /api/tasks/shared — create a shared task in inbox (the canonical
  // store). Named `/shared` to avoid colliding with the native Kanban
  // `POST /api/tasks` above (different task system). The current user is the
  // creator (actingMemberId); `ownerId` (optional) is the assignee.
  app.post("/shared", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = sharedCreateBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }

    try {
      const task = await createSharedTaskForUser(
        { email: user.email },
        parse.data,
      );
      log.info(
        { taskId: task.id, byUserId: user.id, ownerId: task.ownerId },
        "shared task created",
      );
      return reply.code(201).send({ task });
    } catch (err) {
      if (err instanceof NoInboxAccountError) {
        return reply
          .code(409)
          .send({ error: "no_inbox_account", message: err.message });
      }
      if (err instanceof InboxUnreachableError) {
        return reply.code(503).send({ error: "inbox_unreachable" });
      }
      if (err instanceof InboxApiError) {
        return reply.code(502).send({ error: "inbox_error" });
      }
      throw err;
    }
  });
};

export default tasksRoute;
