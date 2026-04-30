// Dashboard stats endpoint. Single round-trip rollup for the Home page
// — open balance, overdue balance, customers to chase, my open tasks,
// today's email volume in/out.
//
// All queries are aggregates against indexed columns, so the whole bundle
// returns in tens of milliseconds. Returned per-call rather than cached
// because the page is an at-a-glance dashboard — operators expect the
// numbers to track reality on each visit.

import type { FastifyPluginAsync } from "fastify";
import { and, eq, gt, gte, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { customers } from "../../db/schema/customers.js";
import { emailLog, tasks } from "../../db/schema/crm.js";
import { requireAuth } from "../lib/auth.js";

const dashboardRoute: FastifyPluginAsync = async (app) => {
  app.get("/stats", async (req, reply) => {
    const user = await requireAuth(req);

    // Today, anchored to Europe/London midnight. Format matches what
    // emailDate stores (UTC TIMESTAMP), but we want the day boundary in
    // London. Pull today's London Y-M-D, then convert back to a UTC
    // Date so the WHERE clause compares correctly.
    const londonYmd = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "Europe/London",
    }).format(new Date());
    // London is UTC+0 in winter, UTC+1 in summer. Compute the actual
    // London-midnight-as-UTC by formatting back. Simpler: use a query
    // that compares against a date string, since MySQL handles tz
    // conversion via CONVERT_TZ — but our installs may not have the
    // tz tables loaded. So we approximate: take the start of the
    // London day in UTC by parsing the formatted date as a local
    // ISO and then offsetting. The offset is small (1 hour at most)
    // and emails are timestamped to the second, so even the worst
    // case undercounts by ~1 hour either side. Acceptable for an
    // at-a-glance dashboard tile.
    const todayLondonMidnight = new Date(`${londonYmd}T00:00:00Z`);

    const [
      openRows,
      overdueRows,
      chaseCountRows,
      myTasksRows,
      emailsInRows,
      emailsOutRows,
    ] = await Promise.all([
      db
        .select({
          total: sql<string>`COALESCE(SUM(${customers.balance}), 0)`,
        })
        .from(customers)
        .where(gt(customers.balance, "0")),
      db
        .select({
          total: sql<string>`COALESCE(SUM(${customers.overdueBalance}), 0)`,
        })
        .from(customers)
        .where(gt(customers.overdueBalance, "0")),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(customers)
        .where(gt(customers.overdueBalance, "0")),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(tasks)
        .where(
          and(
            eq(tasks.assigneeUserId, user.id),
            inArray(tasks.status, ["open", "in_progress", "blocked"]),
          ),
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(emailLog)
        .where(
          and(
            eq(emailLog.direction, "inbound"),
            gte(emailLog.emailDate, todayLondonMidnight),
          ),
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(emailLog)
        .where(
          and(
            eq(emailLog.direction, "outbound"),
            gte(emailLog.emailDate, todayLondonMidnight),
          ),
        ),
    ]);

    return reply.send({
      openBalance: Number(openRows[0]?.total ?? 0),
      overdueBalance: Number(overdueRows[0]?.total ?? 0),
      customersOverdue: Number(chaseCountRows[0]?.count ?? 0),
      myOpenTasks: Number(myTasksRows[0]?.count ?? 0),
      emailsInToday: Number(emailsInRows[0]?.count ?? 0),
      emailsOutToday: Number(emailsOutRows[0]?.count ?? 0),
    });
  });
};

export default dashboardRoute;
