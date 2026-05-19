# Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's stat-tile wall with five action-queue widgets (My Tasks · Unactioned B2B Emails · Chase Queue · RMAs in Flight · Customers on Hold) in a 3+2 grid, with inline dismiss for chase rows.

**Architecture:** One new table (`chase_dismissals`) for the chase widget's permanent dismissals. Five new `GET /api/dashboard/<widget>` endpoints + two dismiss endpoints in the existing `dashboard.ts` route file (the old `GET /stats` endpoint is deleted). Five widget components under `src/web/components/dashboard/`, each owning a TanStack Query at 30s polling. `src/web/pages/home.tsx` body rewritten to compose the widgets in a 3+2 Tailwind grid; `customer-detail.tsx` gains an "Undismiss" badge.

**Tech Stack:** Drizzle ORM (MySQL 8) + drizzle-kit, Fastify v5 + Zod, vitest, React 18 + TanStack Query, Radix Card primitives, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-05-18-dashboard-redesign-design.md`

---

## Spec adaptations (discovered during recon)

The spec used some names that don't match the existing schema. The plan uses the real names everywhere:

1. **Chase tiers:** spec called them L1/L2/L3; codebase uses `CRITICAL | HIGH | MEDIUM | LOW` (per `src/modules/chase/scoring.ts:computeSeverity`). Plan uses tier names.
2. **Hold "good_standing" → "active":** `customers.holdStatus` enum is `["active", "hold", "payment_upfront"]`. Plan filters on `["hold", "payment_upfront"]` for "on hold" widget.
3. **Tasks status:** enum is `open | in_progress | blocked | done | cancelled` (5 values). "Open task" = `inArray(status, ["open", "in_progress", "blocked"])` (mirrors `src/server/routes/tasks.ts`).
4. **Customer detail endpoint:** doesn't currently fetch chase dismissals. Plan extends the existing handler to include `hasChaseDismissal: boolean` so the customer detail page can show the undismiss badge without a second round-trip.

---

## File structure

**Create:**
- `src/db/schema/chase-dismissals.ts` — Drizzle table for chase dismissals
- `src/web/components/dashboard/widget-header.tsx` — shared Title + Count + "See all →" header
- `src/web/components/dashboard/tasks-widget.tsx`
- `src/web/components/dashboard/emails-widget.tsx`
- `src/web/components/dashboard/chase-widget.tsx`
- `src/web/components/dashboard/rmas-widget.tsx`
- `src/web/components/dashboard/holds-widget.tsx`
- `src/web/components/dashboard/chase-widget.test.tsx`
- `src/server/routes/dashboard.test.ts`
- `migrations/0035_chase_dismissals.sql` (drizzle-kit generated; commit verbatim)

**Modify:**
- `src/db/schema/index.ts` — re-export the new schema file
- `src/server/routes/dashboard.ts` — delete `GET /stats`, add 5 GET widget endpoints + 2 dismiss endpoints
- `src/server/routes/customers.ts` — extend the GET `/api/customers/:id` handler to include `hasChaseDismissal`
- `src/web/pages/home.tsx` — rewrite body, remove StatTile component, replace with widget grid
- `src/web/pages/customer-detail.tsx` — add Undismiss badge after the HoldBanner

Each task below produces a self-contained commit on `feat/dashboard-redesign`.

---

## Task 1: Drizzle schema for `chase_dismissals`

**Files:**
- Create: `src/db/schema/chase-dismissals.ts`
- Modify: `src/db/schema/index.ts`

- [ ] **Step 1: Create the schema file**

```ts
// src/db/schema/chase-dismissals.ts
import { mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";
import { customers } from "./customers";
import { users } from "./auth";

export const chaseDismissals = mysqlTable("chase_dismissals", {
  customerId: varchar("customer_id", { length: 24 })
    .primaryKey()
    .references(() => customers.id, { onDelete: "cascade" }),
  dismissedAt: timestamp("dismissed_at").defaultNow().notNull(),
  dismissedByUserId: varchar("dismissed_by_user_id", { length: 255 }).references(
    () => users.id,
    { onDelete: "set null" },
  ),
});

export type ChaseDismissal = typeof chaseDismissals.$inferSelect;
export type NewChaseDismissal = typeof chaseDismissals.$inferInsert;
```

- [ ] **Step 2: Wire export in `src/db/schema/index.ts`**

Add (near the other dashboard-adjacent exports, e.g. after `email-templates`):

```ts
export * from "./chase-dismissals";
```

No relation entry needed in `src/db/relations.ts` — this is a simple lookup table with no children, and the FK joins handled directly inline by the dismiss endpoints.

- [ ] **Step 3: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema/chase-dismissals.ts src/db/schema/index.ts
git commit -m "Dashboard: drizzle schema for chase_dismissals"
```

---

## Task 2: Generate + apply migration 0035

**Files:**
- Create: `migrations/0035_chase_dismissals.sql` (drizzle-kit generated)
- Modify: `migrations/meta/_journal.json` and new `migrations/meta/0035_snapshot.json`

- [ ] **Step 1: Generate**

Run: `npm run db:generate`
Expected: drizzle-kit emits `migrations/0035_<word>.sql` + the journal updates + a `0035_snapshot.json` file.

- [ ] **Step 2: Inspect generated SQL**

Read the new SQL file. Confirm it contains:
- `CREATE TABLE \`chase_dismissals\` (...)` with `customer_id varchar(24) PRIMARY KEY`, `dismissed_at timestamp NOT NULL DEFAULT (now())`, `dismissed_by_user_id varchar(255)`.
- Two FK constraints: one to `customers(id) ON DELETE cascade`, one to `user(id) ON DELETE set null`.

If drizzle-kit produces unexpected ALTER/DROP on existing tables, STOP — Task 1 wiring is wrong.

- [ ] **Step 3: Rename for clarity (optional but matches convention)**

If drizzle gave a random suffix, rename to `0035_chase_dismissals.sql` and update the `tag` field in `migrations/meta/_journal.json`.

- [ ] **Step 4: Apply locally**

Run: `npm run db:migrate`
Expected: `[✓] migrations applied successfully`.

- [ ] **Step 5: Commit (include the snapshot file!)**

The migration commit MUST include `migrations/meta/0035_snapshot.json` — past migrations were missing this and we had to do a followup commit. Stage all three files together:

```bash
git add migrations/0035_chase_dismissals.sql migrations/meta/_journal.json migrations/meta/0035_snapshot.json
git commit -m "Dashboard: migration 0035 — chase_dismissals"
```

---

## Task 3: Tasks endpoint — `GET /api/dashboard/tasks`

**Files:**
- Modify: `src/server/routes/dashboard.ts`

- [ ] **Step 1: Read the current `dashboard.ts` end-to-end.**

There is exactly one handler today: `GET /stats`. You'll add new handlers above (or below) it; the next task deletes `/stats` entirely.

- [ ] **Step 2: Add imports**

At the top of `dashboard.ts`, ADD the following imports (preserve existing imports):

```ts
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { tasks } from "../../db/schema/crm.js";
import { customers } from "../../db/schema/customers.js";
import { rmas } from "../../db/schema/returns.js";
import { invoices } from "../../db/schema/invoices.js";
import { auditLog } from "../../db/schema/audit.js";
import { chaseDismissals } from "../../db/schema/chase-dismissals.js";
import { emailLog } from "../../db/schema/crm.js";
import { computeSeverity } from "../../modules/chase/scoring.js";
import { isAdmin } from "../lib/auth.js";
```

(Already imported: `db`, `customers`, `emailLog`, `tasks`, `requireAuth`, `and`, `eq`, `gt`, `gte`, `inArray`, `sql`. De-duplicate where overlap exists; keep this list as the union.)

- [ ] **Step 3: Add the handler**

Insert this handler inside the existing `dashboardRoute` plugin function:

```ts
app.get("/tasks", async (req, reply) => {
  const user = await requireAuth(req);
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      dueAt: tasks.dueAt,
      status: tasks.status,
      priority: tasks.priority,
      customerId: tasks.customerId,
      customerName: sql<string | null>`(
        SELECT ${customers.displayName} FROM ${customers}
        WHERE ${customers.id} = ${tasks.customerId}
      )`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.assigneeUserId, user.id),
        inArray(tasks.status, ["open", "in_progress", "blocked"]),
      ),
    )
    .orderBy(sql`${tasks.dueAt} IS NULL`, asc(tasks.dueAt))
    .limit(10);
  return reply.send({ rows });
});
```

`sql\`${tasks.dueAt} IS NULL\`` puts NULL-due tasks last (MySQL sorts NULLs first by default; this flips it).

The `customerName` subquery mirrors the pattern used in `f3c9d29 Tasks list: populate customerName via subquery` (recent commit on this repo).

If `tasks.priority` doesn't exist (verify by reading `src/db/schema/crm.ts`), drop it from the SELECT and types.

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Smoke against the running dev server**

Start dev server (`npm run dev`), then:

```bash
curl -s -i http://localhost:3001/api/dashboard/tasks
```

Expected: `401` (no auth). The endpoint is reachable.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/dashboard.ts
git commit -m "Dashboard: GET /api/dashboard/tasks endpoint"
```

---

## Task 4: Emails endpoint — `GET /api/dashboard/emails`

**Files:**
- Modify: `src/server/routes/dashboard.ts`

- [ ] **Step 1: Add the handler**

Insert in `dashboardRoute`:

```ts
app.get("/emails", async (req, reply) => {
  await requireAuth(req);

  // Today UTC start (00:00:00).
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  // Latest inbound B2B email per thread today, with no later outbound reply
  // in the same thread.
  const rows = await db
    .select({
      id: emailLog.id,
      threadId: emailLog.threadId,
      subject: emailLog.subject,
      snippet: emailLog.snippet,
      emailDate: emailLog.emailDate,
      customerId: emailLog.customerId,
      customerName: customers.displayName,
    })
    .from(emailLog)
    .innerJoin(customers, eq(customers.id, emailLog.customerId))
    .where(
      and(
        eq(emailLog.direction, "inbound"),
        gte(emailLog.emailDate, todayStart),
        eq(customers.customerType, "b2b"),
        sql`NOT EXISTS (
          SELECT 1 FROM ${emailLog} AS reply
          WHERE reply.thread_id = ${emailLog.threadId}
            AND reply.direction = 'outbound'
            AND reply.email_date > ${emailLog.emailDate}
        )`,
      ),
    )
    .orderBy(desc(emailLog.emailDate))
    .limit(10);
  return reply.send({ rows });
});
```

- [ ] **Step 2: Type-check + smoke**

Run: `npm run build` (PASS) then `curl -s -i http://localhost:3001/api/dashboard/emails` → expect 401.

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/dashboard.ts
git commit -m "Dashboard: GET /api/dashboard/emails (B2B inbound today, unreplied)"
```

---

## Task 5: RMAs endpoint — `GET /api/dashboard/rmas`

**Files:**
- Modify: `src/server/routes/dashboard.ts`

- [ ] **Step 1: Add the handler**

```ts
app.get("/rmas", async (req, reply) => {
  await requireAuth(req);
  const rows = await db
    .select({
      id: rmas.id,
      rmaNumber: rmas.rmaNumber,
      status: rmas.status,
      totalValue: rmas.totalValue,
      updatedAt: rmas.updatedAt,
      customerId: rmas.customerId,
      customerName: customers.displayName,
    })
    .from(rmas)
    .innerJoin(customers, eq(customers.id, rmas.customerId))
    .where(
      inArray(rmas.status, [
        "draft",
        "approved",
        "awaiting_warehouse_number",
        "sent_to_warehouse",
        "received",
      ]),
    )
    .orderBy(desc(rmas.updatedAt))
    .limit(50);
  return reply.send({ rows });
});
```

50-row cap is a safety net (spec said no limit for RMAs but real-world volume is low; cap protects against pathological cases).

- [ ] **Step 2: Type-check + smoke** (PASS + 401).

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/dashboard.ts
git commit -m "Dashboard: GET /api/dashboard/rmas (all non-terminal)"
```

---

## Task 6: Holds endpoint — `GET /api/dashboard/holds`

**Files:**
- Modify: `src/server/routes/dashboard.ts`

- [ ] **Step 1: Add the handler**

```ts
app.get("/holds", async (req, reply) => {
  await requireAuth(req);
  const rows = await db
    .select({
      id: customers.id,
      displayName: customers.displayName,
      holdStatus: customers.holdStatus,
      overdueBalance: customers.overdueBalance,
      // Days on hold: derived from the most recent audit_log row where
      // action='customer.hold_toggle' and after.holdStatus matches the
      // current status. Subquery; null if no audit row exists (legacy).
      heldSinceAt: sql<string | null>`(
        SELECT MAX(${auditLog.occurredAt}) FROM ${auditLog}
        WHERE ${auditLog.action} = 'customer.hold_toggle'
          AND ${auditLog.entityType} = 'customer'
          AND ${auditLog.entityId} = ${customers.id}
          AND JSON_UNQUOTE(JSON_EXTRACT(${auditLog.after}, '$.holdStatus')) = ${customers.holdStatus}
      )`,
    })
    .from(customers)
    .where(inArray(customers.holdStatus, ["hold", "payment_upfront"]))
    .orderBy(desc(customers.overdueBalance))
    .limit(50);
  return reply.send({ rows });
});
```

The frontend computes "days on hold" from `heldSinceAt` at render time using `formatRelative` or a small helper.

- [ ] **Step 2: Type-check + smoke** (PASS + 401).

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/dashboard.ts
git commit -m "Dashboard: GET /api/dashboard/holds (all currently on hold)"
```

---

## Task 7: Chase endpoint — `GET /api/dashboard/chase`

**Files:**
- Modify: `src/server/routes/dashboard.ts`

- [ ] **Step 1: Inspect `src/modules/chase/scoring.ts` and `src/modules/chase/digest.ts` first.**

You need to know how `computeSeverity(customer, invoices)` is wired today by the digest job — particularly, what SQL query it runs to fetch overdue customers + their invoices. Mirror that query, then exclude rows whose `customer_id` appears in `chase_dismissals`, then sort by `tier` ordinal then `daysOverdue DESC`, take top 10.

- [ ] **Step 2: Add the handler**

```ts
app.get("/chase", async (req, reply) => {
  await requireAuth(req);

  // Pull overdue customers + their open invoices. Mirror the shape the
  // chase-digest uses (src/modules/chase/digest.ts) so severity scoring
  // is identical.
  const overdueRows = await db
    .select({
      id: customers.id,
      displayName: customers.displayName,
      overdueBalance: customers.overdueBalance,
      unappliedCreditBalance: customers.unappliedCreditBalance,
      primaryEmail: customers.primaryEmail,
    })
    .from(customers)
    .leftJoin(chaseDismissals, eq(chaseDismissals.customerId, customers.id))
    .where(
      and(
        gt(customers.overdueBalance, "0"),
        isNull(chaseDismissals.customerId), // exclude dismissed
      ),
    );

  // For each candidate, fetch its open invoices, compute severity,
  // collect rows.
  const enriched = await Promise.all(
    overdueRows.map(async (c) => {
      const invs = await db
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.customerId, c.id),
            gt(invoices.balance, "0"),
          ),
        );
      const sev = computeSeverity(c as never, invs as never);
      return {
        customerId: c.id,
        customerName: c.displayName,
        tier: sev.tier,
        score: sev.score,
        daysOverdue: sev.daysOverdue,
        totalOverdue: sev.totalOverdue,
        oldestUnpaidDate: sev.oldestUnpaidDate,
        primaryEmail: c.primaryEmail,
      };
    }),
  );

  // Sort: tier rank then daysOverdue desc.
  const tierRank: Record<string, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
  };
  enriched.sort((a, b) => {
    const t = tierRank[a.tier] - tierRank[b.tier];
    return t !== 0 ? t : b.daysOverdue - a.daysOverdue;
  });

  return reply.send({ rows: enriched.slice(0, 10) });
});
```

If the actual signature of `computeSeverity` differs from `(customer, invoices)` — verify by reading the export — adjust the call. Don't widen types with `as never` unless TypeScript truly objects.

- [ ] **Step 3: Type-check + smoke** (PASS + 401).

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/dashboard.ts
git commit -m "Dashboard: GET /api/dashboard/chase (top 10 by tier, excl dismissed)"
```

---

## Task 8: Dismiss + undismiss endpoints

**Files:**
- Modify: `src/server/routes/dashboard.ts`

- [ ] **Step 1: Add both handlers**

```ts
app.post<{ Params: { customerId: string } }>(
  "/chase/:customerId/dismiss",
  async (req, reply) => {
    const user = await requireAuth(req);
    const { customerId } = req.params;

    // Verify customer exists (avoid orphan dismissal rows on bad input).
    const existing = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    if (!existing[0]) {
      return reply.code(404).send({ error: "customer not found" });
    }

    await db.transaction(async (tx) => {
      // Upsert: if already dismissed, refresh dismissed_at + dismissed_by.
      await tx
        .insert(chaseDismissals)
        .values({
          customerId,
          dismissedByUserId: user.id,
        })
        .onDuplicateKeyUpdate({
          set: {
            dismissedAt: sql`CURRENT_TIMESTAMP`,
            dismissedByUserId: user.id,
          },
        });
      await tx.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "chase_dismissal.create",
        entityType: "customer",
        entityId: customerId,
        before: null,
        after: { dismissed: true },
      });
    });
    return reply.send({ ok: true });
  },
);

app.delete<{ Params: { customerId: string } }>(
  "/chase/:customerId/dismiss",
  async (req, reply) => {
    const user = await requireAuth(req);
    const { customerId } = req.params;

    await db.transaction(async (tx) => {
      await tx
        .delete(chaseDismissals)
        .where(eq(chaseDismissals.customerId, customerId));
      await tx.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "chase_dismissal.delete",
        entityType: "customer",
        entityId: customerId,
        before: { dismissed: true },
        after: null,
      });
    });
    return reply.send({ ok: true });
  },
);
```

`.onDuplicateKeyUpdate({ set: ... })` is Drizzle's mysql equivalent of `ON DUPLICATE KEY UPDATE`. Verify the exact API in this drizzle version (`drizzle-orm/mysql-core` may export it as `.onDuplicateKeyUpdate` or similar) by grep-ing existing routes for the pattern. If absent, replace with: `SELECT existing; if exists UPDATE; else INSERT;` inside the transaction.

- [ ] **Step 2: Type-check + smoke**

`npm run build` PASS. With dev server running:

```bash
curl -s -i -X POST http://localhost:3001/api/dashboard/chase/SOME_REAL_CUSTOMER_ID/dismiss
```
Expected: `401` (no auth). With session, `200 {ok:true}` or `404` if id bogus.

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/dashboard.ts
git commit -m "Dashboard: POST/DELETE /api/dashboard/chase/:id/dismiss"
```

---

## Task 9: Delete `/stats` endpoint + cleanup

**Files:**
- Modify: `src/server/routes/dashboard.ts`

- [ ] **Step 1: Confirm nothing else calls `/api/dashboard/stats`**

Run:

```bash
```

(or use the project's preferred Grep tool)

```
Grep "/api/dashboard/stats" in src/
```

Expected: matches only inside `home.tsx` (which is being rewritten in Task 14) and the route file itself. If matches anywhere else, STOP and decide whether to keep `/stats` as a deprecation period.

- [ ] **Step 2: Remove the `app.get("/stats", ...)` handler block from `dashboard.ts`**

Delete the entire handler. Leave the imports it used in place if other handlers now need them.

- [ ] **Step 3: Remove any imports now unused**

Run `npm run build` and let TypeScript tell you which imports are dead. Remove them. Common candidates: any helper used only by the deleted aggregate query.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/dashboard.ts
git commit -m "Dashboard: remove GET /api/dashboard/stats (superseded by widget endpoints)"
```

---

## Task 10: Extend customer detail endpoint with `hasChaseDismissal`

**Files:**
- Modify: `src/server/routes/customers.ts`

- [ ] **Step 1: Find the `GET /api/customers/:id` handler in `customers.ts`**

It returns a response object that the customer detail page consumes. Find the JSON shape and the place where the customer row is assembled.

- [ ] **Step 2: Add a single subquery / extra `.select` field**

In the customer SELECT, add:

```ts
import { chaseDismissals } from "../../db/schema/chase-dismissals.js";
// ...

// In the existing .select({...}):
hasChaseDismissal: sql<number>`EXISTS(
  SELECT 1 FROM ${chaseDismissals}
  WHERE ${chaseDismissals.customerId} = ${customers.id}
)`,
```

Map the `0|1` to a boolean in the response:

```ts
return reply.send({
  ...existing,
  customer: {
    ...customer,
    hasChaseDismissal: !!customer.hasChaseDismissal,
  },
});
```

- [ ] **Step 3: Type-check** — PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/routes/customers.ts
git commit -m "Dashboard: include hasChaseDismissal in customer detail response"
```

---

## Task 11: Vitest — dismiss endpoint Zod boundaries

**Files:**
- Create: `src/server/routes/dashboard.test.ts`

- [ ] **Step 1: Create the test file**

```ts
// src/server/routes/dashboard.test.ts
import { describe, expect, it } from "vitest";

// The dismiss/undismiss handlers don't take a body — their input is
// the URL param. No Zod schema to test; the auth + 404 paths are
// integration-level. We test the tier-rank sort instead since it's
// pure logic that the chase endpoint depends on.

const tierRank: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function sortByChaseTier(
  rows: Array<{ tier: string; daysOverdue: number }>,
): Array<{ tier: string; daysOverdue: number }> {
  return [...rows].sort((a, b) => {
    const t = tierRank[a.tier] - tierRank[b.tier];
    return t !== 0 ? t : b.daysOverdue - a.daysOverdue;
  });
}

describe("chase widget sort order", () => {
  it("CRITICAL beats HIGH regardless of daysOverdue", () => {
    const sorted = sortByChaseTier([
      { tier: "HIGH", daysOverdue: 100 },
      { tier: "CRITICAL", daysOverdue: 5 },
    ]);
    expect(sorted[0].tier).toBe("CRITICAL");
  });

  it("within same tier, higher daysOverdue comes first", () => {
    const sorted = sortByChaseTier([
      { tier: "MEDIUM", daysOverdue: 10 },
      { tier: "MEDIUM", daysOverdue: 50 },
      { tier: "MEDIUM", daysOverdue: 30 },
    ]);
    expect(sorted.map((r) => r.daysOverdue)).toEqual([50, 30, 10]);
  });

  it("full ordering CRITICAL > HIGH > MEDIUM > LOW with daysOverdue tiebreak", () => {
    const sorted = sortByChaseTier([
      { tier: "LOW", daysOverdue: 99 },
      { tier: "CRITICAL", daysOverdue: 1 },
      { tier: "MEDIUM", daysOverdue: 50 },
      { tier: "HIGH", daysOverdue: 10 },
      { tier: "HIGH", daysOverdue: 20 },
    ]);
    expect(sorted.map((r) => `${r.tier}/${r.daysOverdue}`)).toEqual([
      "CRITICAL/1",
      "HIGH/20",
      "HIGH/10",
      "MEDIUM/50",
      "LOW/99",
    ]);
  });
});
```

This is unit-test discipline for the pure ordering logic the chase endpoint relies on. The DB-bound endpoints aren't unit-tested (no Fastify test harness in repo as of this plan — same rationale as the email-signatures plan); validated via manual smoke in Task 19.

- [ ] **Step 2: Run + confirm pass**

Run: `npx vitest run src/server/routes/dashboard.test.ts`
Expected: 3/3 pass.

- [ ] **Step 3: Commit**

```bash
git add src/server/routes/dashboard.test.ts
git commit -m "Dashboard: vitest cases for chase tier sort"
```

---

## Task 12: Shared `WidgetHeader` component

**Files:**
- Create: `src/web/components/dashboard/widget-header.tsx`

- [ ] **Step 1: Create the directory + file**

```tsx
// src/web/components/dashboard/widget-header.tsx
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

type Props = {
  title: string;
  count?: number;
  link?: string; // route path for "See all →"
  linkLabel?: string;
};

export function WidgetHeader({ title, count, link, linkLabel = "See all" }: Props) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-medium text-primary">{title}</h2>
        {typeof count === "number" && (
          <span className="text-xs text-muted">{count}</span>
        )}
      </div>
      {link && (
        <Link
          to={link}
          className="inline-flex items-center gap-0.5 text-xs text-secondary hover:text-primary"
        >
          {linkLabel}
          <ArrowRight className="size-3" />
        </Link>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `npm run build` → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web/components/dashboard/widget-header.tsx
git commit -m "Dashboard: shared WidgetHeader component"
```

---

## Task 13: TasksWidget

**Files:**
- Create: `src/web/components/dashboard/tasks-widget.tsx`

- [ ] **Step 1: Create the widget**

```tsx
// src/web/components/dashboard/tasks-widget.tsx
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";
import { WidgetHeader } from "./widget-header";

type TaskRow = {
  id: string;
  title: string;
  dueAt: string | null;
  status: string;
  customerId: string | null;
  customerName: string | null;
};

function relativeDueDate(iso: string | null): string {
  if (!iso) return "No due date";
  const due = new Date(iso);
  const today = new Date();
  const diffDays = Math.floor(
    (due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diffDays < 0) return `${-diffDays}d overdue`;
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  return `In ${diffDays}d`;
}

export function TasksWidget() {
  const { data, isPending, isError } = useQuery<{ rows: TaskRow[] }>({
    queryKey: ["dashboard", "tasks"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/tasks");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <WidgetHeader title="My open tasks" count={rows.length} link="/tasks" />
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="space-y-2">
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
          </div>
        ) : isError ? (
          <div className="text-xs text-accent-danger">Failed to load tasks.</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">No open tasks 🎉</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((t) => (
              <li key={t.id} className="py-2 first:pt-0 last:pb-0">
                <Link
                  to="/tasks"
                  className="block text-sm hover:text-accent-info"
                >
                  <div className="font-medium text-primary truncate">{t.title}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                    <span>{relativeDueDate(t.dueAt)}</span>
                    {t.customerName && <span>· {t.customerName}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
```

The `to="/tasks"` link is page-level (no per-task detail route exists in this codebase as of this plan). If a task detail modal lives elsewhere, link there instead; verify by grepping for how the existing tasks page opens a task.

- [ ] **Step 2: Type-check**

Run: `npm run build` → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web/components/dashboard/tasks-widget.tsx
git commit -m "Dashboard: TasksWidget"
```

---

## Task 14: EmailsWidget

**Files:**
- Create: `src/web/components/dashboard/emails-widget.tsx`

- [ ] **Step 1: Create the widget**

```tsx
// src/web/components/dashboard/emails-widget.tsx
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";
import { WidgetHeader } from "./widget-header";

type EmailRow = {
  id: string;
  threadId: string;
  subject: string;
  snippet: string | null;
  emailDate: string;
  customerId: string;
  customerName: string;
};

function relativeTimeShort(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ago`;
}

export function EmailsWidget() {
  const { data, isPending, isError } = useQuery<{ rows: EmailRow[] }>({
    queryKey: ["dashboard", "emails"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/emails");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <WidgetHeader title="Unactioned emails today" count={rows.length} />
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="space-y-2">
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
          </div>
        ) : isError ? (
          <div className="text-xs text-accent-danger">Failed to load emails.</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">Inbox zero for today.</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((e) => (
              <li key={e.id} className="py-2 first:pt-0 last:pb-0">
                <Link
                  to="/customers/$customerId"
                  params={{ customerId: e.customerId }}
                  className="block text-sm hover:text-accent-info"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium text-primary truncate">
                      {e.customerName}
                    </span>
                    <span className="text-xs text-muted shrink-0">
                      {relativeTimeShort(e.emailDate)}
                    </span>
                  </div>
                  <div className="text-xs text-secondary truncate">{e.subject}</div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
```

Verify the customer detail route name is `/customers/$customerId` by checking existing usage in the repo (grep `params={{ customerId`). If it's `/customer/$id` or similar, adjust.

- [ ] **Step 2: Type-check** → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web/components/dashboard/emails-widget.tsx
git commit -m "Dashboard: EmailsWidget"
```

---

## Task 15: RmasWidget

**Files:**
- Create: `src/web/components/dashboard/rmas-widget.tsx`

- [ ] **Step 1: Create the widget**

```tsx
// src/web/components/dashboard/rmas-widget.tsx
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";
import { WidgetHeader } from "./widget-header";

type RmaRow = {
  id: string;
  rmaNumber: string | null;
  status: string;
  totalValue: string;
  updatedAt: string;
  customerId: string;
  customerName: string;
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  awaiting_warehouse_number: "Awaiting WH#",
  sent_to_warehouse: "At warehouse",
  received: "Received",
};

export function RmasWidget() {
  const { data, isPending, isError } = useQuery<{ rows: RmaRow[] }>({
    queryKey: ["dashboard", "rmas"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/rmas");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <WidgetHeader title="RMAs in flight" count={rows.length} link="/returns" />
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="h-6 rounded bg-subtle animate-pulse" />
        ) : isError ? (
          <div className="text-xs text-accent-danger">Failed to load RMAs.</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">No RMAs in flight.</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((r) => (
              <li key={r.id} className="py-2 first:pt-0 last:pb-0">
                <Link
                  to="/returns"
                  className="flex items-center justify-between gap-2 text-sm hover:text-accent-info"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-primary truncate">
                      {r.rmaNumber ?? r.id.slice(0, 8)} · {r.customerName}
                    </div>
                  </div>
                  <span className="text-xs rounded bg-subtle px-1.5 py-0.5 text-muted shrink-0">
                    {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
```

- [ ] **Step 2: Type-check** → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web/components/dashboard/rmas-widget.tsx
git commit -m "Dashboard: RmasWidget"
```

---

## Task 16: HoldsWidget

**Files:**
- Create: `src/web/components/dashboard/holds-widget.tsx`

- [ ] **Step 1: Create the widget**

```tsx
// src/web/components/dashboard/holds-widget.tsx
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../ui/card";
import { WidgetHeader } from "./widget-header";

type HoldRow = {
  id: string;
  displayName: string;
  holdStatus: "hold" | "payment_upfront";
  overdueBalance: string;
  heldSinceAt: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  hold: "On hold",
  payment_upfront: "Prepay",
};

function formatMoney(s: string | number): string {
  const n = typeof s === "string" ? Number(s) : s;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function daysSince(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return `${days}d`;
}

export function HoldsWidget() {
  const { data, isPending, isError } = useQuery<{ rows: HoldRow[] }>({
    queryKey: ["dashboard", "holds"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/holds");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <WidgetHeader title="Customers on hold" count={rows.length} />
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="h-6 rounded bg-subtle animate-pulse" />
        ) : isError ? (
          <div className="text-xs text-accent-danger">Failed to load holds.</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">No customers on hold.</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((c) => (
              <li key={c.id} className="py-2 first:pt-0 last:pb-0">
                <Link
                  to="/customers/$customerId"
                  params={{ customerId: c.id }}
                  className="flex items-center justify-between gap-2 text-sm hover:text-accent-info"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-primary truncate">
                      {c.displayName}
                    </div>
                    <div className="text-xs text-muted">
                      {STATUS_LABEL[c.holdStatus] ?? c.holdStatus} · {daysSince(c.heldSinceAt)} · {formatMoney(c.overdueBalance)} overdue
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
```

- [ ] **Step 2: Type-check** → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/web/components/dashboard/holds-widget.tsx
git commit -m "Dashboard: HoldsWidget"
```

---

## Task 17: ChaseWidget (with inline dismiss)

**Files:**
- Create: `src/web/components/dashboard/chase-widget.tsx`
- Create: `src/web/components/dashboard/chase-widget.test.tsx`

- [ ] **Step 1: Create the widget**

```tsx
// src/web/components/dashboard/chase-widget.tsx
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Card, CardBody, CardHeader } from "../ui/card";
import { Button } from "../ui/button";
import { WidgetHeader } from "./widget-header";

type ChaseRow = {
  customerId: string;
  customerName: string;
  tier: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  daysOverdue: number;
  totalOverdue: number;
  oldestUnpaidDate: string | null;
};

const TIER_STYLES: Record<ChaseRow["tier"], string> = {
  CRITICAL: "bg-accent-danger/15 text-accent-danger",
  HIGH: "bg-accent-warning/15 text-accent-warning",
  MEDIUM: "bg-accent-info/15 text-accent-info",
  LOW: "bg-subtle text-muted",
};

function formatMoney(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

export function ChaseWidget() {
  const queryClient = useQueryClient();

  const { data, isPending, isError } = useQuery<{ rows: ChaseRow[] }>({
    queryKey: ["dashboard", "chase"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/chase");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const dismissMutation = useMutation({
    mutationFn: async (customerId: string) => {
      const res = await fetch(
        `/api/dashboard/chase/${encodeURIComponent(customerId)}/dismiss`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onMutate: async (customerId: string) => {
      // Optimistic remove: snapshot, drop the row, snapshot for rollback.
      await queryClient.cancelQueries({ queryKey: ["dashboard", "chase"] });
      const prev = queryClient.getQueryData<{ rows: ChaseRow[] }>([
        "dashboard",
        "chase",
      ]);
      if (prev) {
        queryClient.setQueryData(["dashboard", "chase"], {
          rows: prev.rows.filter((r) => r.customerId !== customerId),
        });
      }
      return { prev };
    },
    onError: (_err, _customerId, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(["dashboard", "chase"], ctx.prev);
      }
    },
    onSettled: () => {
      // Refetch so the next row from the backlog slides in.
      queryClient.invalidateQueries({ queryKey: ["dashboard", "chase"] });
    },
  });

  const rows = data?.rows ?? [];

  return (
    <Card>
      <CardHeader>
        <WidgetHeader title="Chase queue" count={rows.length} link="/chase" />
      </CardHeader>
      <CardBody>
        {isPending ? (
          <div className="space-y-2">
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
            <div className="h-6 rounded bg-subtle animate-pulse" />
          </div>
        ) : isError ? (
          <div className="text-xs text-accent-danger">Failed to load chase.</div>
        ) : rows.length === 0 ? (
          <div className="text-xs text-muted">Nothing to chase.</div>
        ) : (
          <ul className="divide-y divide-default">
            {rows.map((r) => (
              <li
                key={r.customerId}
                className="flex items-center gap-2 py-2 first:pt-0 last:pb-0"
              >
                <span
                  className={`text-[10px] font-semibold rounded px-1.5 py-0.5 shrink-0 ${TIER_STYLES[r.tier]}`}
                >
                  {r.tier}
                </span>
                <Link
                  to="/customers/$customerId"
                  params={{ customerId: r.customerId }}
                  className="flex-1 min-w-0 text-sm hover:text-accent-info"
                >
                  <div className="font-medium text-primary truncate">
                    {r.customerName}
                  </div>
                  <div className="text-xs text-muted">
                    {formatMoney(r.totalOverdue)} · {r.daysOverdue}d overdue
                  </div>
                </Link>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => dismissMutation.mutate(r.customerId)}
                  title="Dismiss — permanent until manually undismissed"
                  disabled={dismissMutation.isPending}
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
```

- [ ] **Step 2: Add the test**

```tsx
// src/web/components/dashboard/chase-widget.test.tsx
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRootRoute, createRouter, createMemoryHistory } from "@tanstack/react-router";
import { ChaseWidget } from "./chase-widget";

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // Minimal router so <Link> renders. Replace with the project's real router
  // shape if this skeleton fails to render.
  const root = createRootRoute({ component: () => <ChaseWidget /> });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return {
    qc,
    Wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
    router,
  };
}

describe("ChaseWidget — optimistic dismiss", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/dashboard/chase")) {
        return new Response(
          JSON.stringify({
            rows: [
              {
                customerId: "c1",
                customerName: "Acme Ltd",
                tier: "CRITICAL",
                daysOverdue: 30,
                totalOverdue: 1000,
                oldestUnpaidDate: null,
              },
              {
                customerId: "c2",
                customerName: "Brown & Co",
                tier: "HIGH",
                daysOverdue: 20,
                totalOverdue: 500,
                oldestUnpaidDate: null,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/dismiss") && url.includes("c1")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("removes the row optimistically on dismiss click", async () => {
    const { Wrapper, router } = makeWrapper();
    render(
      <Wrapper>
        <RouterProvider router={router} />
      </Wrapper>,
    );

    await waitFor(() => screen.getByText("Acme Ltd"));
    expect(screen.getByText("Acme Ltd")).toBeInTheDocument();
    expect(screen.getByText("Brown & Co")).toBeInTheDocument();

    const dismissButtons = screen.getAllByTitle(/Dismiss/);
    await userEvent.click(dismissButtons[0]);

    // Optimistic: row should disappear immediately, well before any network round-trip resolves.
    await waitFor(() => expect(screen.queryByText("Acme Ltd")).toBeNull());
    expect(screen.getByText("Brown & Co")).toBeInTheDocument();
  });
});
```

If the project's TanStack Router version doesn't accept the minimal route tree above, replace `RouterProvider`/`createRootRoute` with whatever the existing test files use; or wrap `<ChaseWidget />` with a minimal mock for `<Link>`. Don't get stuck — the goal is to exercise the dismiss flow, not test the router.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/web/components/dashboard/chase-widget.test.tsx`
Expected: 1/1 pass.

If it fails because router setup is wonky, FALLBACK strategy: extract the dismiss-mutation logic into a tiny pure hook (`useChaseDismiss`) and test the hook directly with `@testing-library/react`'s `renderHook`. Keep the router-rendered widget test in a `.skip` block with a TODO note.

- [ ] **Step 4: Type-check + commit**

Run: `npm run build` → PASS.

```bash
git add src/web/components/dashboard/chase-widget.tsx src/web/components/dashboard/chase-widget.test.tsx
git commit -m "Dashboard: ChaseWidget with optimistic dismiss"
```

---

## Task 18: Rewrite `home.tsx` body — compose widgets

**Files:**
- Modify: `src/web/pages/home.tsx`

- [ ] **Step 1: Read `home.tsx` end-to-end first**

Two parts stay:
- Page header (`<h1>Dashboard</h1>`) around line 121.
- The past-11am shipment nag block (lines ~127-151) with its `showInvoicingAlert` trigger logic.

Everything from the stat-tile grid down (lines ~153-217) gets replaced. The `StatTile` component definition at the bottom of the file (~lines 246-291) gets deleted entirely — confirmed unused elsewhere by recon.

- [ ] **Step 2: Apply the rewrite**

Replace the JSX between the past-11am nag block and the existing "Quick links" `<Card>` with:

```tsx
<div className="grid gap-4 md:grid-cols-3">
  <TasksWidget />
  <EmailsWidget />
  <ChaseWidget />
</div>
<div className="grid gap-4 md:grid-cols-2">
  <RmasWidget />
  <HoldsWidget />
</div>
```

Delete the existing stat-tile grids (Money tiles + Email volume tiles).

Decide on the "Quick links" Card (lines ~220+): if it still adds value, keep it below the widget grids. If it's redundant now that widgets link to their dedicated pages, delete it too. Default: keep, since deletion is a separable judgement.

Add imports at the top:

```tsx
import { TasksWidget } from "../components/dashboard/tasks-widget";
import { EmailsWidget } from "../components/dashboard/emails-widget";
import { RmasWidget } from "../components/dashboard/rmas-widget";
import { HoldsWidget } from "../components/dashboard/holds-widget";
import { ChaseWidget } from "../components/dashboard/chase-widget";
```

Remove now-unused imports from `lucide-react` (anything only used by deleted tiles: `DollarSign`, `CheckSquare`, `Mail`, `Users`, etc. — TypeScript will tell you which). Remove the `Tile`/`StatTile` import if it lives in another file; remove its definition if it's inline.

Remove the `DashboardStats` type and its `useQuery` (the one that fetched `/api/dashboard/stats`). Other types (`TodayRow`, `TodayResponse` for the 11am nag) stay.

Remove the local `formatMoney` helper if no remaining code in `home.tsx` uses it. (Widgets define their own.)

- [ ] **Step 3: Smoke + commit**

`npm run dev`; visit `/`. Confirm:
- Page header renders.
- Past-11am nag still appears at the appropriate time (the trigger logic is unchanged).
- 5 widgets render, each loading or showing data.
- No console errors.

```bash
git add src/web/pages/home.tsx
git commit -m "Dashboard: compose 5 widgets in 3+2 grid, remove StatTile"
```

---

## Task 19: Undismiss badge on customer detail page

**Files:**
- Modify: `src/web/pages/customer-detail.tsx`

- [ ] **Step 1: Read the customer detail page around the header area**

The HoldBanner (line ~339) is rendered just above the main name + email block. Use it as the precedent for inserting another state badge.

The customer detail query (around line 211) returns `DetailResponse` whose shape now includes `hasChaseDismissal: boolean` per Task 10. Update the DetailResponse type:

```ts
type DetailResponse = {
  customer: {
    // ...existing fields...
    hasChaseDismissal: boolean;
  };
  // ...rest unchanged...
};
```

- [ ] **Step 2: Add the badge + undismiss mutation**

Add near the existing imports:

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query"; // already imported probably
```

Inside the component body, near other hooks:

```tsx
const queryClient = useQueryClient();
const undismissMutation = useMutation({
  mutationFn: async () => {
    const res = await fetch(
      `/api/dashboard/chase/${encodeURIComponent(customerId)}/dismiss`,
      { method: "DELETE" },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
    queryClient.invalidateQueries({ queryKey: ["dashboard", "chase"] });
  },
});
```

Render the badge immediately after `<HoldBanner ... />` (so it stacks visually with other state notifications):

```tsx
{customer.hasChaseDismissal && (
  <div className="flex items-center justify-between gap-2 rounded border border-default bg-subtle px-3 py-2 text-xs">
    <span className="text-secondary">
      Dismissed from chase queue — won't surface on dashboard until undismissed.
    </span>
    <button
      type="button"
      onClick={() => undismissMutation.mutate()}
      disabled={undismissMutation.isPending}
      className="text-accent-info hover:underline disabled:opacity-50"
    >
      {undismissMutation.isPending ? "Undismissing…" : "Undismiss"}
    </button>
  </div>
)}
```

- [ ] **Step 3: Smoke**

Dismiss a customer from the dashboard. Open their customer detail page. Confirm:
- Badge appears with "Dismissed from chase queue".
- Clicking "Undismiss" → badge disappears.
- Returning to dashboard → customer reappears in chase widget.

- [ ] **Step 4: Commit**

```bash
git add src/web/pages/customer-detail.tsx
git commit -m "Dashboard: Undismiss badge on customer detail page"
```

---

## Task 20: Full smoke + push

- [ ] **Step 1: Full vitest suite**

Run: `npx vitest run`
Expected: all pass (besides the 2 pre-existing failures in `src/integrations/qb/sync.regression.test.ts` that pre-date this branch).

- [ ] **Step 2: Full build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Manual smoke (substitute for E2E)**

`npm run dev`, then:

- [ ] Visit `/` (Dashboard). Confirm 5 widgets render, no stat tiles, 3+2 grid intact, past-11am nag unchanged.
- [ ] Assign yourself a task with a due date today → it appears in My Open Tasks within 30s.
- [ ] Send an inbound test email from a B2B customer → appears in Unactioned Emails within 30s.
- [ ] Reply to that email from the customer detail page → email vanishes from the widget on next refetch.
- [ ] Dismiss the top chase row → it disappears immediately (optimistic), next row slides in after refetch, count stays the same (or drops if backlog is small).
- [ ] Hard refresh `/` → the dismissed customer is still gone (persistence works).
- [ ] Open the dismissed customer's detail page → "Dismissed from chase queue · Undismiss" badge appears.
- [ ] Click Undismiss → badge disappears; navigate back to `/`; customer is back in chase widget on next refetch.
- [ ] Test RMA widget: ensure non-terminal RMAs (draft, approved, etc.) show; completed/denied/cancelled do not.
- [ ] Test Holds widget: confirm only `hold` / `payment_upfront` customers show, with overdue balance sorted desc.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/dashboard-redesign
```

- [ ] **Step 5: Open PR (or merge per finance-hub workflow)**

```bash
gh pr create --title "Dashboard redesign: 5 action-queue widgets" --body "$(cat <<'EOF'
## Summary
- Replaces stat-tile dashboard with 5 action-queue widgets: My Tasks · Unactioned B2B Emails · Chase Queue · RMAs in Flight · Customers on Hold (3+2 grid)
- Chase queue supports inline dismiss with permanent-until-manually-undismissed semantics; new `chase_dismissals` table + dismiss/undismiss endpoints
- Removes the unused `GET /api/dashboard/stats` aggregate endpoint and the `StatTile` component
- Customer detail page gains an "Undismiss" badge when the customer has a chase dismissal

## Test plan
- [ ] All widgets render on `/`
- [ ] My Tasks shows the operator's assigned open/in_progress/blocked tasks
- [ ] Unactioned Emails: B2B inbound today with no later outbound reply in thread
- [ ] Chase: top 10 by tier (CRITICAL > HIGH > MEDIUM > LOW) excluding dismissed
- [ ] Dismiss → row vanishes optimistically, persists across hard refresh
- [ ] Undismiss from customer page → row returns on next dashboard load
- [ ] RMAs: all non-terminal statuses
- [ ] Holds: customers with hold_status IN ('hold','payment_upfront')

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

(Or merge to main directly per the finance-hub workflow — same pattern as the email-signatures branch.)

---

## Known follow-ups (out of scope, noted for backlog)

- **Per-user chase dismissals** — currently global; add `dismissed_by_user_id` to PK if a 5+ user team starts stepping on each other.
- **Dashboard refresh on visibility change** — TanStack Query's `refetchOnWindowFocus` covers this, but explicit `visibilitychange` listening would be more responsive.
- **Email widget pagination** — capped at 10; if inbox volume grows, surface "+N more" with link to a dedicated B2B inbox view.
- **Test harness for Fastify routes** — same gap noted in the email-signatures plan. Right tool would be a `tap`/`supertest` setup; one-time investment.
