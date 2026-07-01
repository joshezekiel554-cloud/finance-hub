// Team Activity — admin-only report routes + the app-wide heartbeat sink.
//
// Routes (registered at /api by index.ts):
//   POST /api/heartbeat                      requireAuth (any user)  → 204
//   GET  /api/team-activity/members          admin → picker list
//   GET  /api/team-activity?userId=&from=&to=  admin → full report
//   GET  /api/team-activity/export.csv?…       admin → text/csv attachment
//
// The heartbeat is deliberately the only NON-admin route here: every signed-in
// user pings it so their active-minute set fills in. Everything else is gated
// on isAdmin (ADMIN_EMAILS) — non-admins get 403.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users } from "../../db/schema/auth.js";
import { userActiveMinutes } from "../../db/schema/user-active-minutes.js";
import { isAdmin, requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import { listMembers, resolveMemberById } from "../../integrations/inbox/members.js";
import { buildTeamActivityReport } from "../../modules/team-activity/report.js";
import { csvFilename, reportToCsv } from "../../modules/team-activity/csv.js";

const log = createLogger({ component: "routes.team-activity" });

// Inbox-only teammates (no finance `users` row) are addressable as report
// subjects under this synthetic userId. loadSubject unpacks it back to the
// inbox memberId; their finance-side gather is simply empty.
const INBOX_SUBJECT_PREFIX = "inbox:";

// Accept ISO datetimes for from/to. The frontend always sends explicit
// boundaries (start-of-day → end-of-range) so the route stays timezone-dumb;
// Europe/London grouping happens in the report layer.
const rangeSchema = z.object({
  userId: z.string().min(1),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

const teamActivityRoute: FastifyPluginAsync = async (app) => {
  // --- POST /heartbeat (any authenticated user) ---------------------------
  app.post("/heartbeat", async (req, reply) => {
    const user = await requireAuth(req);
    const minuteUtc = Math.floor(Date.now() / 60_000);
    // INSERT IGNORE on the (userId, minuteUtc) PK — a minute is recorded once
    // no matter how many pings land inside it.
    await db
      .insert(userActiveMinutes)
      .ignore()
      .values({ userId: user.id, minuteUtc });
    return reply.code(204).send();
  });

  // --- GET /team-activity/members (admin) ---------------------------------
  app.get("/team-activity/members", async (req, reply) => {
    const user = await requireAuth(req);
    if (!isAdmin(user)) return reply.code(403).send({ error: "Forbidden" });

    const rows = await db
      .select({ userId: users.id, name: users.name, email: users.email })
      .from(users);

    // Best-effort inbox member resolution for the picker. Inbox-unreachable
    // just yields null inboxMemberId — the picker still works.
    let members: Awaited<ReturnType<typeof listMembers>> = [];
    try {
      members = await listMembers();
    } catch (err) {
      log.warn({ err }, "inbox members unavailable for picker");
    }
    const byEmail = new Map<string, string>();
    for (const m of members) {
      if (m.email) byEmail.set(m.email.toLowerCase(), m.teamMemberId);
      if (m.googleEmail) byEmail.set(m.googleEmail.toLowerCase(), m.teamMemberId);
    }

    const out = rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      email: r.email,
      inboxMemberId: r.email ? byEmail.get(r.email.toLowerCase()) ?? null : null,
    }));

    // Append inbox-only teammates: inbox members with no matching finance user.
    // They become selectable subjects (finance-side gather is empty; their
    // inbox slice flows in via the memberId carried in the synthetic userId).
    const matchedMemberIds = new Set(
      out.map((m) => m.inboxMemberId).filter((id): id is string => Boolean(id)),
    );
    for (const m of members) {
      if (matchedMemberIds.has(m.teamMemberId)) continue;
      out.push({
        userId: `${INBOX_SUBJECT_PREFIX}${m.teamMemberId}`,
        name: m.name || null,
        email: m.email || null,
        inboxMemberId: m.teamMemberId,
      });
    }

    out.sort((a, b) =>
      (a.name ?? a.email ?? "").localeCompare(b.name ?? b.email ?? ""),
    );

    return reply.send({ members: out });
  });

  // --- GET /team-activity (admin) -----------------------------------------
  app.get("/team-activity", async (req, reply) => {
    const user = await requireAuth(req);
    if (!isAdmin(user)) return reply.code(403).send({ error: "Forbidden" });

    const parsed = rangeSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parsed.error.flatten() });
    }
    const { userId, from, to } = parsed.data;

    const subjectRow = await loadSubject(userId);
    if (!subjectRow) return reply.code(404).send({ error: "user not found" });

    const report = await buildTeamActivityReport(subjectRow, from, to);
    return reply.send(report);
  });

  // --- GET /team-activity/export.csv (admin) ------------------------------
  app.get("/team-activity/export.csv", async (req, reply) => {
    const user = await requireAuth(req);
    if (!isAdmin(user)) return reply.code(403).send({ error: "Forbidden" });

    const parsed = rangeSchema.safeParse(req.query);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "invalid query", details: parsed.error.flatten() });
    }
    const { userId, from, to } = parsed.data;

    const subjectRow = await loadSubject(userId);
    if (!subjectRow) return reply.code(404).send({ error: "user not found" });

    const report = await buildTeamActivityReport(subjectRow, from, to);
    const csv = reportToCsv(report);

    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="${csvFilename(report)}"`,
      );
    return reply.send(csv);
  });
};

type SubjectRow = {
  userId: string;
  name: string | null;
  email: string | null;
  inboxMemberId?: string | null;
};

async function loadSubject(userId: string): Promise<SubjectRow | null> {
  // Inbox-only subject: unpack the memberId and build the subject from the
  // inbox roster. No finance `users` row exists for them.
  if (userId.startsWith(INBOX_SUBJECT_PREFIX)) {
    const memberId = userId.slice(INBOX_SUBJECT_PREFIX.length);
    if (!memberId) return null;
    let member: Awaited<ReturnType<typeof resolveMemberById>> = null;
    try {
      member = await resolveMemberById(memberId);
    } catch (err) {
      log.warn({ err, memberId }, "inbox member resolve failed for subject");
      return null;
    }
    if (!member) return null;
    return {
      userId,
      name: member.name || null,
      email: member.email || null,
      inboxMemberId: member.teamMemberId,
    };
  }

  const rows = await db
    .select({ userId: users.id, name: users.name, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { userId: r.userId, name: r.name, email: r.email };
}

export default teamActivityRoute;
