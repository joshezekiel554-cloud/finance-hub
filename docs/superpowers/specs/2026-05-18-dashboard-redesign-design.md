# Dashboard Redesign — Design Spec

**Date:** 2026-05-18
**Status:** Awaiting user review
**Branch context:** new branch off `main` (`feat/dashboard-redesign`)

---

## Problem

The current dashboard at `src/web/pages/home.tsx` is a wall of *stat
tiles* (numbers) — open balance, overdue balance, customers needing
chase, emails-in count, emails-out count, my-open-tasks count. The
operator opens it, glances at the numbers, and clicks through to
dedicated pages to actually act. The dashboard adds a navigation hop
without telling them *what* to do next.

This redesign flips the surface from "stats" to "action queue": every
widget is a *list of items the operator can act on*. No vanity
numbers; everything is clickable, dismissable, or directly drivable
without leaving the page.

## Goal

Five action-queue widgets, laid out in a 3+2 grid:

```
┌────────────┬────────────┬────────────┐
│  My Tasks  │ Unactioned │ Chase      │
│  (10)      │ Emails (N) │ Queue (10) │
└────────────┴────────────┴────────────┘
┌─────────────────────┬─────────────────────┐
│ RMAs in Flight (N)  │ Customers on Hold (N)│
└─────────────────────┴─────────────────────┘
```

Each widget shows ~10 rows, has a header with its title + count + a
"See all" link to its dedicated page, and lets the operator either
click into a row OR perform a queue action (chase dismiss) inline.

## Out of scope

- Mobile-first layout — desktop is the primary surface (5-user team
  on workstations). The grid will degrade to single-column on narrow
  screens via Tailwind's responsive classes, but no purpose-built
  mobile design.
- Cross-widget filtering / global search.
- User-customisable widget order or hidden widgets.
- Real-time push updates — TanStack Query polling at 30s is enough
  for an accounts-team-paced workflow.
- Replacing the existing 11am-London shipment nag — it stays as-is,
  rendered above the widget grid.

## Approach

Replace the contents of `src/web/pages/home.tsx` below the page
header. Build five small widget components, one per file under
`src/web/components/dashboard/`. Each component owns its own
TanStack Query against a dedicated `/api/dashboard/<widget>` endpoint
(separate endpoints so each widget caches/polls independently — also
makes the home query latency the slowest single widget, not their sum).

Backend adds one new table (`chase_dismissals`) for the chase queue's
dismiss-permanently behaviour. Other widgets compose existing tables
with no schema changes.

## Architecture

### 1. Schema migration

New table `chase_dismissals`:

```sql
CREATE TABLE chase_dismissals (
  customer_id VARCHAR(24) NOT NULL PRIMARY KEY,
  dismissed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dismissed_by_user_id VARCHAR(255),
  CONSTRAINT fk_chase_dismissals_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_chase_dismissals_user FOREIGN KEY (dismissed_by_user_id)
    REFERENCES user(id) ON DELETE SET NULL
);
```

PK on `customer_id` makes the upsert + dedup natural (one dismissal
per customer at a time; re-dismissing just re-stamps the timestamp).
Undismissing is `DELETE FROM chase_dismissals WHERE customer_id = ?`.

### 2. Drizzle schema

New file `src/db/schema/chase-dismissals.ts` with the table + types.
Wire into `src/db/schema/index.ts` exports. No relation needed
(simple lookup table).

### 3. API endpoints

Five new endpoints, all under `src/server/routes/dashboard.ts`
(the file already exists; extend it). All require auth via
`requireAuth(req)`.

| Method | Path | Returns | Notes |
|---|---|---|---|
| GET | `/api/dashboard/tasks` | `{ rows: Task[] }` | Tasks where `assignee_user_id = current user` AND `status != 'completed'`, ordered by `due_date ASC NULLS LAST`, limit 10. Each row includes customerName via join. |
| GET | `/api/dashboard/emails` | `{ rows: Email[] }` | Inbound emails today (`received_at >= today UTC`) where `customer.customer_type = 'b2b'` AND no outbound email exists in the same thread received after the inbound one. Ordered by `received_at DESC`, limit 10. |
| GET | `/api/dashboard/rmas` | `{ rows: Rma[] }` | RMAs where `status NOT IN ('completed', 'denied', 'cancelled')`. Ordered by `updated_at DESC`. No limit (5-user team, low volume — but cap at 50 as a safety). |
| GET | `/api/dashboard/holds` | `{ rows: Customer[] }` | Customers where `hold_status IN ('hold', 'payment_upfront')`. Includes overdue_balance + days_since_hold (derived from latest audit_log row that flipped the status). Ordered by overdue_balance DESC. Cap 50. |
| GET | `/api/dashboard/chase` | `{ rows: Chase[] }` | Customers with overdue invoices, ordered by chase severity then days_overdue DESC. EXCLUDES rows whose customer_id is in `chase_dismissals`. Limit 10. Each row includes customerName, severity (L1/L2/L3), overdueBalance, oldestUnpaidDate. |

Plus the dismiss/undismiss endpoints:

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/dashboard/chase/:customerId/dismiss` | — | Upserts `chase_dismissals` row for the customer. audit_log entry. Returns 200 with the new dismissal record. |
| DELETE | `/api/dashboard/chase/:customerId/dismiss` | — | Removes the dismissal. audit_log entry. Used by the customer detail page's "Undismiss" action (see §5). |

All endpoints follow the existing `dashboard.ts` patterns (look at
the file's first few handlers as templates).

### 4. Frontend — widget components

Five new files under `src/web/components/dashboard/`. Each is a
self-contained Card that owns its query + render. Pattern:

```tsx
// src/web/components/dashboard/tasks-widget.tsx
export function TasksWidget() {
  const { data, isPending } = useQuery<{ rows: Task[] }>({
    queryKey: ["dashboard", "tasks"],
    queryFn: async () => {
      const res = await fetch("/api/dashboard/tasks");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  return (
    <Card>
      <CardHeader>
        <WidgetHeader title="My Tasks" count={data?.rows.length} link="/tasks" />
      </CardHeader>
      <CardBody>{/* row list */}</CardBody>
    </Card>
  );
}
```

`WidgetHeader` is a shared component (`src/web/components/dashboard/widget-header.tsx`)
that all five widgets use — title, count badge, "See all →" link.

The five widgets:

- `tasks-widget.tsx` — rows show task title, due-date (relative), customer name. Click row → opens task detail (existing modal or `/tasks/:id`). Empty state: "No open tasks 🎉".
- `emails-widget.tsx` — rows show customer name, subject, received-time (relative), 1-line snippet. Click → opens existing email thread view on customer detail page. Empty state: "Inbox zero for today".
- `chase-widget.tsx` — rows show severity pill (L1/L2/L3), customer name, overdue balance, days overdue, inline Dismiss button. Click row → customer detail page (Activity tab). Dismiss triggers POST + optimistic mutation; row vanishes, next item loads from the cached list (or refetch). Empty state: "Nothing to chase".
- `rmas-widget.tsx` — rows show RMA number, customer, status pill, time-in-status. Click → opens RMA detail (existing). Empty state: "No RMAs in flight".
- `holds-widget.tsx` — rows show customer name, hold status, overdue balance, days on hold. Click → customer detail page. Empty state: "No customers on hold".

### 5. Frontend — dashboard composition

Rewrite `src/web/pages/home.tsx` body. Keep:
- Page header (`<h1>Dashboard</h1>` line 121)
- The past-11am shipment nag block (untouched)

Replace the stat-tile grid with:

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

Tailwind responsive: stacks to single column on `<md` (768px).

Remove the existing imports for `Tile` component (or whatever the
stat-tile component is) plus the `useQuery` for `/api/dashboard/stats`
(presumably the existing combined endpoint — verify and delete if
nothing else consumes it).

### 6. Undismiss UI (customer detail page)

Customer detail page (`src/web/pages/customer-detail.tsx`) gains a
small badge in the customer header area: "Dismissed from chase queue"
with an "Undismiss" link if the customer has a row in
`chase_dismissals`. Clicking it fires `DELETE /api/dashboard/chase/:id/dismiss`
and invalidates the chase widget cache.

This is the ONLY surface where undismissal happens — keeps the
chase widget itself purely about dismissing-forward.

### 7. Empty states + edge cases

- **No data for a widget** → friendly empty-state copy (per-widget,
  see §4).
- **Loading** → skeleton rows (3 grey placeholder rows) for visual
  stability.
- **Error** → small red text in widget body, no full-page error.
- **Customer flips back to good_standing while on the chase list** →
  the next 30s refetch naturally drops them (they're no longer
  overdue, fail the WHERE clause).
- **Operator dismisses a customer then their severity worsens** →
  customer STAYS dismissed (per design decision: permanent until
  manually undismissed via the customer detail page). The "see all"
  chase page should show dismissed customers with a flag so the
  operator can find them.
- **Email thread has multiple inbound messages today** → only the
  most recent inbound is shown (avoid duplicates in the queue).
- **RMA at exactly the cap (50 items)** → cap is a safety net; if
  hit, log a warning so we know to add pagination.

## Testing

### Unit (vitest)

- `src/server/routes/dashboard.test.ts` — Zod schema boundaries for
  the dismiss endpoints; query shape sanity (mocked db).
- `src/web/components/dashboard/chase-widget.test.tsx` — render with
  3 rows, click Dismiss on row 1, verify optimistic removal.

### Manual smoke (replaces E2E)

Walk through after deploy:

1. Visit `/`. Confirm 5 widgets render, no stat tiles.
2. Create a new task assigned to yourself → appears in My Tasks.
3. Send yourself an inbound test email from a B2B customer →
   appears in Unactioned Emails within 30s.
4. Reply to it → email disappears from the widget on next refetch.
5. Dismiss the top chase row → it vanishes, next item slides in,
   total stays ~10.
6. Refresh page → dismissed customer is gone, persists across
   reload.
7. Open the dismissed customer's detail page → "Dismissed from
   chase queue · Undismiss" appears in header.
8. Click Undismiss → they reappear in chase widget on next refetch.

## Migration / rollout

1. Apply migration on deploy. `chase_dismissals` starts empty —
   zero behaviour change for existing customers.
2. The dashboard page swap is purely UI; no flag, no opt-in. On
   first load post-deploy, every operator sees the new layout.
3. The old stat-tile endpoint (`/api/dashboard/stats` or whatever
   it is) gets deleted in the same PR. Verify nothing else
   consumes it first via repo-wide grep.

## Risks and tradeoffs

- **5 endpoints = 5 round trips per page load.** Mitigation: each
  widget caches at 30s + on-focus refetch, so steady-state is one
  fetch per widget per minute (300 req/hr per logged-in operator —
  trivial). First load is the only sync-burst moment.
- **Chase dismissal is global, not per-user.** A 5-user team
  shouldn't see meaningful conflicts; if someone dismisses an item
  it's gone for everyone. If this becomes a friction point, the
  table is set up to add `dismissed_by_user_id` as part of a
  composite key later (small migration).
- **No "snooze for N days" mode.** Decided in brainstorming —
  permanent dismissal is the cleanest mental model for this team.
  Adding a snooze later is an additive column on `chase_dismissals`
  + UI control.
- **Removed stat tiles means top-level totals (open balance,
  overdue) aren't visible from home.** Operators who want those
  glance-numbers will need to visit a dedicated reporting page or
  the customers list. Acceptable — those totals weren't actionable.
- **Email-widget definition uses "no outbound in thread"** which
  depends on the existing thread-association logic working correctly.
  If thread association is fuzzy, the widget might miss/spuriously
  show emails. Existing chase email flow already depends on this
  same logic, so risk is shared, not new.

## Effort estimate

Half a day end-to-end:

- 2h: schema + drizzle + 5 backend endpoints + dismiss/undismiss
- 2h: 5 widget components + dashboard composition + WidgetHeader shared
- 1h: undismiss badge on customer detail page + tests + manual smoke
