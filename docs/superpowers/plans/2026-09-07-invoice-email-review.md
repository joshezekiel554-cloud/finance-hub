# Invoice Email Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface, on the Invoicing Today page, every recent QBO invoice that was never emailed or whose email bounced, with Send / Dismiss actions, fed by QBO email-delivery fields the 30-min sync now persists.

**Architecture:** Three sync-owned columns land on `invoices` (`email_status`, `delivery_time`, `delivery_error`) via the existing full-fetch QB sync; a small `invoice_email_dismissals` table holds operator dismissals; a pure `classifyForEmailReview` function is the single rule set, used by a new `/api/invoicing/email-review` route; a self-contained React section on the Today page renders the two buckets and reuses the existing `InvoiceSendDialog` for sending.

**Tech Stack:** Fastify v5 + zod, Drizzle ORM (mysql2) + drizzle-kit migrations, Vitest, React 18 + TanStack Query/Router + Tailwind v4.

Spec: `docs/superpowers/specs/2026-09-07-invoice-email-review-design.md`.
Conventions that apply everywhere (from CLAUDE.md): strict TS, zero `any`; server imports are relative with `.js` suffix; env only via `src/lib/env.ts`; logging via `createLogger`; state changes write `audit_log`. Tests run with `npx vitest run <path>` (bare `npm test` is watch mode).

---

## File structure

| File | Responsibility |
|---|---|
| `src/integrations/qb/types.ts` (modify) | add `DeliveryInfo` to `QboInvoice` |
| `src/db/schema/invoices.ts` (modify) | three new QBO-owned columns |
| `src/db/schema/invoice-email-dismissals.ts` (create) | dismissal table + reason constants |
| `src/db/schema/index.ts` (modify) | export the new schema file |
| `migrations/0057_*.sql` + `migrations/meta/*` (generated) | DDL |
| `src/integrations/qb/sync.ts` (modify) | persist the three fields on create/update paths |
| `src/integrations/qb/sync.email-status.test.ts` (create) | `planInvoiceUpdate` drift tests |
| `src/modules/invoice-email-review/select.ts` (create) | pure classification rules + constants |
| `src/modules/invoice-email-review/select.test.ts` (create) | table-driven rule tests |
| `src/server/routes/invoicing-email-review.ts` (create) | GET list, POST dismiss, POST restore |
| `src/server/routes/invoicing-email-review.test.ts` (create) | body-schema tests |
| `src/server/routes/index.ts` (modify) | register the new plugin |
| `src/web/components/invoicing/email-review-section.tsx` (create) | hook + section UI |
| `src/web/pages/invoicing-today.tsx` (modify) | 4th stat card + render section |

---

### Task 1: Schema, QBO type, migration

**Files:**
- Modify: `src/integrations/qb/types.ts` (inside `export type QboInvoice`, after `EmailStatus?: string;`)
- Modify: `src/db/schema/invoices.ts` (after `sentVia` column, ~line 78)
- Create: `src/db/schema/invoice-email-dismissals.ts`
- Modify: `src/db/schema/index.ts`
- Generate: `migrations/0057_*.sql`

- [ ] **Step 1: Add `DeliveryInfo` to the QBO invoice type**

In `src/integrations/qb/types.ts`, inside `QboInvoice`, directly after `EmailStatus?: string;`:

```ts
  // Populated by QBO after /send. DeliveryErrorType appears asynchronously
  // (minutes after the send call returned 200) when Intuit's mail step
  // failed — values seen in prod: "Bounced Email", "Undeliverable".
  DeliveryInfo?: {
    DeliveryType?: string;
    DeliveryTime?: string;
    DeliveryErrorType?: string;
  };
```

- [ ] **Step 2: Add the three sync-owned columns to `invoices`**

In `src/db/schema/invoices.ts`, directly after `sentVia: varchar("sent_via", { length: 32 }),`:

```ts
    // QBO-owned email delivery state, mirrored by the 30-min sync (unlike
    // sent_at / sent_via, which are local). email_status is QBO's
    // EmailStatus (NotSet | NeedToSend | EmailSent); delivery_* come from
    // DeliveryInfo and are the only signal that an accepted send later
    // bounced. Drives the Email review section on Invoicing Today.
    emailStatus: varchar("email_status", { length: 32 }),
    deliveryTime: timestamp("delivery_time"),
    deliveryError: varchar("delivery_error", { length: 64 }),
```

- [ ] **Step 3: Create the dismissals schema**

Create `src/db/schema/invoice-email-dismissals.ts`:

```ts
import {
  index,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { invoices } from "./invoices";
import { users } from "./auth";

// Operator dismissal of an invoice from the Email review section on
// Invoicing Today ("never emailed" / "delivery failed"). Keyed by the hub
// invoice id so the QB sync — which owns invoices.email_status /
// delivery_* — never touches it. A dismissed invoice that QBO later marks
// EmailSent leaves the never-emailed set on its own; the row here just
// stops it re-appearing while it is still NotSet.
export const EMAIL_REVIEW_DISMISS_REASONS = [
  "sent_elsewhere",
  "no_invoice_needed",
  "other",
] as const;
export type EmailReviewDismissReason =
  (typeof EMAIL_REVIEW_DISMISS_REASONS)[number];

export const invoiceEmailDismissals = mysqlTable(
  "invoice_email_dismissals",
  {
    invoiceId: varchar("invoice_id", { length: 24 })
      .primaryKey()
      .references(() => invoices.id, { onDelete: "cascade" }),
    reason: mysqlEnum("reason", EMAIL_REVIEW_DISMISS_REASONS).notNull(),
    // Required by the route when reason === "other".
    reasonNote: text("reason_note"),
    dismissedAt: timestamp("dismissed_at").defaultNow().notNull(),
    dismissedByUserId: varchar("dismissed_by_user_id", { length: 255 }).references(
      () => users.id,
      { onDelete: "set null" },
    ),
  },
  (t) => ({
    dismissedAtIdx: index("idx_invoice_email_dismissals_dismissed_at").on(
      t.dismissedAt,
    ),
  }),
);

export type InvoiceEmailDismissal = typeof invoiceEmailDismissals.$inferSelect;
export type NewInvoiceEmailDismissal = typeof invoiceEmailDismissals.$inferInsert;
```

- [ ] **Step 4: Export it from the schema index**

In `src/db/schema/index.ts`, after `export * from "./invoice-bcc-forwards";` add:

```ts
export * from "./invoice-email-dismissals";
```

- [ ] **Step 5: Generate the migration**

Run: `npx drizzle-kit generate --name invoice_email_review`
Expected: a new file `migrations/0057_invoice_email_review.sql` and an updated `migrations/meta/0057_snapshot.json` + `_journal.json`.

Open the SQL and confirm it contains exactly (order may differ):

```sql
CREATE TABLE `invoice_email_dismissals` (
	`invoice_id` varchar(24) NOT NULL,
	`reason` enum('sent_elsewhere','no_invoice_needed','other') NOT NULL,
	`reason_note` text,
	`dismissed_at` timestamp NOT NULL DEFAULT (now()),
	`dismissed_by_user_id` varchar(255),
	CONSTRAINT `invoice_email_dismissals_invoice_id` PRIMARY KEY(`invoice_id`)
);
--> statement-breakpoint
ALTER TABLE `invoices` ADD `email_status` varchar(32);--> statement-breakpoint
ALTER TABLE `invoices` ADD `delivery_time` timestamp;--> statement-breakpoint
ALTER TABLE `invoices` ADD `delivery_error` varchar(64);--> statement-breakpoint
ALTER TABLE `invoice_email_dismissals` ADD CONSTRAINT ... FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON DELETE cascade ...;--> statement-breakpoint
ALTER TABLE `invoice_email_dismissals` ADD CONSTRAINT ... FOREIGN KEY (`dismissed_by_user_id`) REFERENCES `user`(`id`) ON DELETE set null ...;--> statement-breakpoint
CREATE INDEX `idx_invoice_email_dismissals_dismissed_at` ON `invoice_email_dismissals` (`dismissed_at`);
```

If the generator also emits unrelated ALTERs (schema drift from earlier hand edits), STOP and report — do not commit a migration that touches other tables.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/integrations/qb/types.ts src/db/schema/invoices.ts src/db/schema/invoice-email-dismissals.ts src/db/schema/index.ts migrations/
git commit -m "feat(email-review): invoices email/delivery columns + dismissals table (migration 0057)"
```

---

### Task 2: Sync persists EmailStatus / DeliveryInfo

**Files:**
- Modify: `src/integrations/qb/sync.ts` — `InvoiceUpdateBefore` (~line 404), `InvoiceUpdateDesired` (~line 416), `planInvoiceUpdate` (~line 428), `upsertInvoice` `desired` object (~line 478) and ODKU `set` (~line 514), helpers near `parseQboDate` (~line 1164)
- Test: `src/integrations/qb/sync.email-status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/integrations/qb/sync.email-status.test.ts`:

```ts
// planInvoiceUpdate must treat QBO's email/delivery fields as sync-owned:
// drift on any of them produces an update set that carries all three, and
// sent_at / sent_via stay out of the set (they are local-only).
import { describe, expect, it } from "vitest";
import { planInvoiceUpdate } from "./sync.js";

type Before = Parameters<typeof planInvoiceUpdate>[0];
type Desired = Parameters<typeof planInvoiceUpdate>[1];

const synced = new Date("2026-09-07T10:00:00Z");

function before(overrides: Partial<Before> = {}): Before {
  return {
    customerId: "cust-1",
    docNumber: "19562",
    issueDate: new Date("2026-09-02T00:00:00Z"),
    dueDate: new Date("2026-10-02T00:00:00Z"),
    total: "195.00",
    balance: "195.00",
    status: "sent",
    customerMemo: null,
    syncToken: "0",
    originSource: "prefix",
    emailStatus: "NotSet",
    deliveryTime: null,
    deliveryError: null,
    ...overrides,
  };
}

function desired(overrides: Partial<Desired> = {}): Desired {
  return {
    customerId: "cust-1",
    docNumber: "19562",
    issueDate: new Date("2026-09-02T00:00:00Z"),
    dueDate: new Date("2026-10-02T00:00:00Z"),
    total: "195.00",
    balance: "195.00",
    status: "sent",
    customerMemo: null,
    syncToken: "0",
    origin: "feldart",
    emailStatus: "NotSet",
    deliveryTime: null,
    deliveryError: null,
    lastSyncedAt: synced,
    ...overrides,
  };
}

describe("planInvoiceUpdate — email/delivery fields", () => {
  it("returns null when nothing (including email fields) drifted", () => {
    expect(planInvoiceUpdate(before(), desired())).toBeNull();
  });

  it("detects EmailStatus flipping NotSet → EmailSent", () => {
    const set = planInvoiceUpdate(
      before(),
      desired({
        emailStatus: "EmailSent",
        deliveryTime: new Date("2026-09-07T12:34:52Z"),
      }),
    );
    expect(set).not.toBeNull();
    expect(set?.emailStatus).toBe("EmailSent");
    expect(set?.deliveryTime?.toISOString()).toBe("2026-09-07T12:34:52.000Z");
    expect(set?.deliveryError).toBeNull();
  });

  it("detects a DeliveryErrorType appearing after the fact", () => {
    const set = planInvoiceUpdate(
      before({
        emailStatus: "EmailSent",
        deliveryTime: new Date("2026-09-02T13:36:04Z"),
      }),
      desired({
        emailStatus: "EmailSent",
        deliveryTime: new Date("2026-09-02T13:36:04Z"),
        deliveryError: "Bounced Email",
      }),
    );
    expect(set?.deliveryError).toBe("Bounced Email");
  });

  it("detects a re-send clearing the error and moving DeliveryTime", () => {
    const set = planInvoiceUpdate(
      before({
        emailStatus: "EmailSent",
        deliveryTime: new Date("2026-09-02T13:36:04Z"),
        deliveryError: "Bounced Email",
      }),
      desired({
        emailStatus: "EmailSent",
        deliveryTime: new Date("2026-09-06T21:43:23Z"),
        deliveryError: null,
      }),
    );
    expect(set?.deliveryError).toBeNull();
    expect(set?.deliveryTime?.toISOString()).toBe("2026-09-06T21:43:23.000Z");
  });

  it("never includes sent_at / sent_via in the set", () => {
    const set = planInvoiceUpdate(before(), desired({ emailStatus: "EmailSent" }));
    expect(set).not.toBeNull();
    expect(Object.keys(set ?? {})).not.toContain("sentAt");
    expect(Object.keys(set ?? {})).not.toContain("sentVia");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/integrations/qb/sync.email-status.test.ts`
Expected: FAIL — TypeScript/vitest errors that `emailStatus` is not a known property, and the drift tests fail because `planInvoiceUpdate` returns `null`.

- [ ] **Step 3: Extend the types and `planInvoiceUpdate`**

In `src/integrations/qb/sync.ts`:

Replace the `InvoiceUpdateBefore` type with:

```ts
type InvoiceUpdateBefore = Pick<
  Invoice,
  | "customerId"
  | "docNumber"
  | "issueDate"
  | "dueDate"
  | "total"
  | "balance"
  | "status"
  | "customerMemo"
  | "syncToken"
  | "originSource"
  | "emailStatus"
  | "deliveryTime"
  | "deliveryError"
>;
```

Replace the `InvoiceUpdateDesired` type with:

```ts
type InvoiceUpdateDesired = Pick<
  NewInvoice,
  | "customerId"
  | "docNumber"
  | "issueDate"
  | "dueDate"
  | "total"
  | "balance"
  | "status"
  | "customerMemo"
  | "syncToken"
  | "origin"
  | "emailStatus"
  | "deliveryTime"
  | "deliveryError"
> & { lastSyncedAt: Date };
```

In `planInvoiceUpdate`, extend the drift expression — after `before.syncToken !== desired.syncToken` add:

```ts
    (before.emailStatus ?? null) !== (desired.emailStatus ?? null) ||
    isoDateTimeOrNull(before.deliveryTime) !== isoDateTimeOrNull(desired.deliveryTime) ||
    (before.deliveryError ?? null) !== (desired.deliveryError ?? null);
```

(and turn the previous last line's trailing `;` into `||`). Then in the `set` object, after `syncToken: desired.syncToken,` add:

```ts
    emailStatus: desired.emailStatus ?? null,
    deliveryTime: desired.deliveryTime ?? null,
    deliveryError: desired.deliveryError ?? null,
```

Add two helpers next to `parseQboDate` (bottom of file):

```ts
// QBO DeliveryInfo.DeliveryTime is an ISO-8601 string with an offset
// ("2026-09-06T14:43:23-07:00"). Unparsable → null with a warn, never throw.
function parseQboDateTime(v: string | undefined | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    log.warn({ value: v }, "unparsable QBO DeliveryTime; storing null");
    return null;
  }
  return d;
}

function isoDateTimeOrNull(v: Date | null | undefined): string | null {
  return v ? v.toISOString() : null;
}
```

- [ ] **Step 4: Populate the fields on both write paths in `upsertInvoice`**

In the `desired` object, after `syncToken: qboInvoice.SyncToken ?? null,` add:

```ts
    emailStatus: qboInvoice.EmailStatus ?? null,
    deliveryTime: parseQboDateTime(qboInvoice.DeliveryInfo?.DeliveryTime),
    deliveryError: qboInvoice.DeliveryInfo?.DeliveryErrorType ?? null,
```

In the create-path `.onDuplicateKeyUpdate({ set: { ... } })`, after `syncToken: desired.syncToken,` add:

```ts
          emailStatus: desired.emailStatus,
          deliveryTime: desired.deliveryTime,
          deliveryError: desired.deliveryError,
```

The update path already flows through `planInvoiceUpdate`, so nothing else changes. Do NOT touch `sent_at` / `sent_via` handling.

- [ ] **Step 5: Run the new test and the existing sync tests**

Run: `npx vitest run src/integrations/qb/`
Expected: all PASS (new file 5 tests; `sync.reconcile`, `sync.regression`, `sync.invoice-repoint`, `credit-memo-aggregation` unchanged).

- [ ] **Step 6: Typecheck and commit**

Run: `npx tsc --noEmit` → no errors.

```bash
git add src/integrations/qb/sync.ts src/integrations/qb/sync.email-status.test.ts
git commit -m "feat(email-review): qb sync persists EmailStatus + DeliveryInfo on invoices"
```

---

### Task 3: Pure classification rules

**Files:**
- Create: `src/modules/invoice-email-review/select.ts`
- Test: `src/modules/invoice-email-review/select.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/modules/invoice-email-review/select.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  classifyForEmailReview,
  emailReviewWindowStart,
  isDismissalActive,
  EMAIL_REVIEW_GRACE_HOURS,
  EMAIL_REVIEW_WINDOW_DAYS,
  type EmailReviewCandidate,
} from "./select.js";

const NOW = new Date("2026-09-07T14:00:00Z");

function candidate(overrides: Partial<EmailReviewCandidate> = {}): EmailReviewCandidate {
  return {
    emailStatus: "NotSet",
    deliveryError: null,
    status: "sent",
    total: "195.00",
    balance: "195.00",
    issueDate: "2026-09-02",
    createdAt: new Date("2026-09-02T23:41:34Z"),
    dismissedAt: null,
    deliveryTime: null,
    ...overrides,
  };
}

describe("isDismissalActive", () => {
  it("no dismissal → false", () => {
    expect(isDismissalActive(null, null)).toBe(false);
    expect(isDismissalActive(null, new Date("2026-09-06T21:43:23Z"))).toBe(false);
  });
  it("dismissal with no delivery attempt → true", () => {
    expect(isDismissalActive(new Date("2026-09-03T12:00:00Z"), null)).toBe(true);
  });
  it("dismissal newer than the last delivery attempt → true", () => {
    expect(
      isDismissalActive(new Date("2026-09-03T12:00:00Z"), new Date("2026-09-02T13:36:04Z")),
    ).toBe(true);
  });
  it("delivery attempt after the dismissal → false (stale)", () => {
    expect(
      isDismissalActive(new Date("2026-09-03T12:00:00Z"), new Date("2026-09-06T21:43:23Z")),
    ).toBe(false);
  });
  it("accepts ISO strings", () => {
    expect(isDismissalActive("2026-09-03T12:00:00Z", "2026-09-02T13:36:04Z")).toBe(true);
  });
});

describe("classifyForEmailReview", () => {
  it("exports the documented constants", () => {
    expect(EMAIL_REVIEW_WINDOW_DAYS).toBe(90);
    expect(EMAIL_REVIEW_GRACE_HOURS).toBe(24);
  });

  it("NotSet + open + old enough → never_emailed", () => {
    expect(classifyForEmailReview(candidate(), NOW)).toBe("never_emailed");
  });

  it("NeedToSend counts the same as NotSet", () => {
    expect(classifyForEmailReview(candidate({ emailStatus: "NeedToSend" }), NOW)).toBe("never_emailed");
  });

  it("EmailSent with no error → null", () => {
    expect(classifyForEmailReview(candidate({ emailStatus: "EmailSent" }), NOW)).toBeNull();
  });

  it("NULL email_status (not yet synced) → null", () => {
    expect(classifyForEmailReview(candidate({ emailStatus: null }), NOW)).toBeNull();
  });

  it("voided → null even with an error", () => {
    expect(
      classifyForEmailReview(candidate({ status: "void", deliveryError: "Bounced Email" }), NOW),
    ).toBeNull();
  });

  it("zero total → null", () => {
    expect(classifyForEmailReview(candidate({ total: "0.00", balance: "0.00" }), NOW)).toBeNull();
  });

  it("paid (balance 0) never-emailed → null", () => {
    expect(classifyForEmailReview(candidate({ balance: "0.00" }), NOW)).toBeNull();
  });

  it("future issue date (2030 placeholder) → null", () => {
    expect(classifyForEmailReview(candidate({ issueDate: "2030-01-01" }), NOW)).toBeNull();
  });

  it("older than the window → null", () => {
    expect(classifyForEmailReview(candidate({ issueDate: "2026-06-01" }), NOW)).toBeNull();
  });

  it("issued exactly on the window edge is included", () => {
    // NOW is 2026-09-07; 90 days earlier is 2026-06-09.
    expect(emailReviewWindowStart(NOW)).toBe("2026-06-09");
    expect(classifyForEmailReview(candidate({ issueDate: "2026-06-09" }), NOW)).toBe("never_emailed");
  });

  it("issued the day before the window edge is excluded", () => {
    expect(classifyForEmailReview(candidate({ issueDate: "2026-06-08" }), NOW)).toBeNull();
  });

  it("created exactly 24h ago is no longer in grace", () => {
    expect(
      classifyForEmailReview(
        candidate({ issueDate: "2026-09-06", createdAt: new Date("2026-09-06T14:00:00Z") }),
        NOW,
      ),
    ).toBe("never_emailed");
  });

  it("null status still classifies", () => {
    expect(classifyForEmailReview(candidate({ status: null }), NOW)).toBe("never_emailed");
  });

  it("created within the grace period → null (still in today's queue)", () => {
    expect(
      classifyForEmailReview(
        candidate({ issueDate: "2026-09-07", createdAt: new Date("2026-09-07T09:00:00Z") }),
        NOW,
      ),
    ).toBeNull();
  });

  it("missing issueDate → null", () => {
    expect(classifyForEmailReview(candidate({ issueDate: null }), NOW)).toBeNull();
  });

  it("delivery error → delivery_failed even when paid", () => {
    expect(
      classifyForEmailReview(
        candidate({ emailStatus: "EmailSent", deliveryError: "Undeliverable", balance: "0.00" }),
        NOW,
      ),
    ).toBe("delivery_failed");
  });

  it("delivery error wins over NotSet", () => {
    expect(classifyForEmailReview(candidate({ deliveryError: "Bounced Email" }), NOW)).toBe("delivery_failed");
  });

  it("active dismissal → null in either bucket", () => {
    const dismissedAt = new Date("2026-09-03T12:00:00Z");
    expect(classifyForEmailReview(candidate({ dismissedAt }), NOW)).toBeNull();
    expect(
      classifyForEmailReview(
        candidate({
          dismissedAt,
          emailStatus: "EmailSent",
          deliveryError: "Bounced Email",
          deliveryTime: new Date("2026-09-02T13:36:04Z"),
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it("stale dismissal (re-sent after dismissing, then bounced) → delivery_failed", () => {
    expect(
      classifyForEmailReview(
        candidate({
          dismissedAt: new Date("2026-09-03T12:00:00Z"),
          emailStatus: "EmailSent",
          deliveryError: "Bounced Email",
          deliveryTime: new Date("2026-09-06T21:43:23Z"),
        }),
        NOW,
      ),
    ).toBe("delivery_failed");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/modules/invoice-email-review/select.test.ts`
Expected: FAIL — cannot resolve `./select.js`.

- [ ] **Step 3: Implement**

Create `src/modules/invoice-email-review/select.ts`:

```ts
// Single rule set for the Email review section on Invoicing Today.
//
// The route fetches a superset of candidates with SQL (issue-date window +
// "NotSet/NeedToSend or has delivery error") and runs every row through
// classifyForEmailReview so the SQL only has to be a cheap pre-filter and
// the exact contract lives here, unit-tested.
//
// Buckets:
//   never_emailed  — QBO says the invoice was never emailed and it is still
//                    open and old enough to have left today's normal queue.
//   delivery_failed — QBO accepted the send but later recorded a
//                    DeliveryErrorType (Bounced Email / Undeliverable).

export const EMAIL_REVIEW_WINDOW_DAYS = 90;
export const EMAIL_REVIEW_GRACE_HOURS = 24;

// QBO EmailStatus values that mean "not emailed".
export const NOT_EMAILED_STATUSES = ["NotSet", "NeedToSend"] as const;

export type EmailReviewBucket = "never_emailed" | "delivery_failed";

export type EmailReviewCandidate = {
  emailStatus: string | null;
  deliveryError: string | null;
  // invoices.status enum value (or null on very old rows).
  status: string | null;
  // decimal(12,2) strings as Drizzle returns them.
  total: string;
  balance: string;
  // invoices.issue_date as a plain YYYY-MM-DD string. The route selects it
  // with DATE_FORMAT on purpose: mysql2 returns DATE columns as LOCAL-midnight
  // Date objects, so reading them back as a UTC day shifts by one on any host
  // ahead of UTC. A string keeps this module host-timezone independent.
  issueDate: string | null;
  createdAt: string | Date;
  // invoice_email_dismissals.dismissed_at (null = never dismissed) and
  // invoices.delivery_time (QBO's last delivery attempt). A dismissal only
  // counts while it is newer than the last attempt — see isDismissalActive.
  dismissedAt: string | Date | null;
  deliveryTime: string | Date | null;
};

// YYYY-MM-DD in UTC for `now`; strings are taken as already-formatted days.
function isoDay(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : v.slice(0, 10);
}

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function ms(v: string | Date): number {
  return v instanceof Date ? v.getTime() : new Date(v).getTime();
}

// First issue day still inside the window (inclusive). Exported so the
// route's SQL pre-filter uses the SAME floor as the classifier — a
// CURDATE()-based floor evaluated in the MySQL server timezone could be a day
// narrower than this UTC-day computation and silently drop rows.
export function emailReviewWindowStart(now: Date = new Date()): string {
  return addDays(isoDay(now), -EMAIL_REVIEW_WINDOW_DAYS);
}

// A dismissal hides an invoice only until QBO records a NEWER delivery
// attempt. So "dismissed while NotSet, later sent and bounced" and
// "dismissed bounce, re-sent, bounced again" both re-surface — otherwise the
// invisible-bounce failure this feature exists to catch would survive it.
export function isDismissalActive(
  dismissedAt: string | Date | null,
  deliveryTime: string | Date | null,
): boolean {
  if (!dismissedAt) return false;
  if (!deliveryTime) return true;
  return ms(dismissedAt) > ms(deliveryTime);
}

export function classifyForEmailReview(
  c: EmailReviewCandidate,
  now: Date = new Date(),
): EmailReviewBucket | null {
  if (isDismissalActive(c.dismissedAt, c.deliveryTime)) return null;
  if (c.status === "void") return null;
  if (!c.issueDate) return null;

  const today = isoDay(now);
  const issued = isoDay(c.issueDate);
  // Both buckets: future-dated rows (the 2030-01-01 placeholders) and rows
  // older than the window are out, bounce or not.
  if (issued > today) return null;
  if (issued < emailReviewWindowStart(now)) return null;

  if (c.deliveryError) return "delivery_failed";

  const notEmailed = NOT_EMAILED_STATUSES.some((s) => s === c.emailStatus);
  if (!notEmailed) return null;
  // decimal(12,2) NOT NULL columns, so NaN means corrupt data — fail closed.
  const total = Number(c.total);
  const balance = Number(c.balance);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (!Number.isFinite(balance) || balance <= 0) return null;

  const createdMs = new Date(c.createdAt).getTime();
  if (now.getTime() - createdMs < EMAIL_REVIEW_GRACE_HOURS * 60 * 60 * 1000) {
    return null;
  }
  return "never_emailed";
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/modules/invoice-email-review/select.test.ts`
Expected: PASS (25 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/invoice-email-review/
git commit -m "feat(email-review): pure classification rules for never-emailed / delivery-failed"
```

---

### Task 4: API route

**Files:**
- Create: `src/server/routes/invoicing-email-review.ts`
- Test: `src/server/routes/invoicing-email-review.test.ts`
- Modify: `src/server/routes/index.ts` (import block + the `register` list after line 64)

- [ ] **Step 1: Write the failing schema test**

Create `src/server/routes/invoicing-email-review.test.ts`:

```ts
// Schema-level route tests — same convention as statements.test.ts (no
// Fastify harness in the repo; handlers 400 on safeParse failure, so the
// zod schema is the rejection contract).
import { describe, expect, it } from "vitest";
import { dismissBodySchema, restoreBodySchema } from "./invoicing-email-review.js";

describe("POST /api/invoicing/email-review/dismiss body", () => {
  it("accepts a categorical reason without a note", () => {
    expect(
      dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "sent_elsewhere" }).success,
    ).toBe(true);
  });

  it("requires a non-blank note when reason is other", () => {
    expect(dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "other" }).success).toBe(false);
    expect(
      dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "other", reasonNote: "   " }).success,
    ).toBe(false);
    expect(
      dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "other", reasonNote: "PDF'd by hand" })
        .success,
    ).toBe(true);
  });

  it("rejects unknown reasons and over-long notes", () => {
    expect(dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "b2c_paid_upfront" }).success).toBe(false);
    expect(
      dismissBodySchema.safeParse({ invoiceId: "inv_1", reason: "sent_elsewhere", reasonNote: "x".repeat(501) })
        .success,
    ).toBe(false);
  });

  it("rejects a missing invoiceId", () => {
    expect(dismissBodySchema.safeParse({ reason: "sent_elsewhere" }).success).toBe(false);
  });
});

describe("POST /api/invoicing/email-review/restore body", () => {
  it("needs an invoiceId", () => {
    expect(restoreBodySchema.safeParse({}).success).toBe(false);
    expect(restoreBodySchema.safeParse({ invoiceId: "inv_1" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/server/routes/invoicing-email-review.test.ts`
Expected: FAIL — cannot resolve `./invoicing-email-review.js`.

- [ ] **Step 3: Implement the route plugin**

Create `src/server/routes/invoicing-email-review.ts`:

```ts
// Email review — the two blind spots behind "customers say they never got
// the invoice" (see docs/superpowers/invoice-delivery-audit-2026-09-07.md):
//
//   GET  /            → { neverEmailed, deliveryFailed, dismissed, syncedAt }
//   POST /dismiss     → hide an invoice from the lists (reason required)
//   POST /restore     → un-hide
//
// Data comes from invoices.email_status / delivery_* which the QB sync
// mirrors every 30 min; no live QBO call here. Rules live in
// modules/invoice-email-review/select.ts; the SQL below is only a cheap
// superset pre-filter.

import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { db } from "../../db/index.js";
import { auditLog } from "../../db/schema/audit.js";
import { users } from "../../db/schema/auth.js";
import { customers } from "../../db/schema/customers.js";
import {
  EMAIL_REVIEW_DISMISS_REASONS,
  invoiceEmailDismissals,
} from "../../db/schema/invoice-email-dismissals.js";
import { invoices } from "../../db/schema/invoices.js";
import { createLogger } from "../../lib/logger.js";
import {
  classifyForEmailReview,
  emailReviewWindowStart,
  isDismissalActive,
  NOT_EMAILED_STATUSES,
  type EmailReviewBucket,
} from "../../modules/invoice-email-review/select.js";
import { requireAuth } from "../lib/auth.js";

const log = createLogger({ component: "invoicing-email-review-route" });

export const dismissBodySchema = z
  .object({
    invoiceId: z.string().min(1).max(24),
    reason: z.enum(EMAIL_REVIEW_DISMISS_REASONS),
    reasonNote: z.string().max(500).optional(),
  })
  .refine(
    (b) => b.reason !== "other" || (b.reasonNote ?? "").trim().length > 0,
    { message: "a note is required when reason is 'other'", path: ["reasonNote"] },
  );

export const restoreBodySchema = z.object({
  invoiceId: z.string().min(1).max(24),
});

export type EmailReviewRow = {
  invoiceId: string;
  qbInvoiceId: string;
  docNumber: string | null;
  customerId: string;
  customerName: string;
  origin: "feldart" | "tj";
  issueDate: string | null;
  createdAt: string;
  total: string;
  balance: string;
  status: string | null;
  emailStatus: string | null;
  deliveryTime: string | null;
  deliveryError: string | null;
  recipients: { to: string[]; cc: string[] };
  dismissal: {
    reason: (typeof EMAIL_REVIEW_DISMISS_REASONS)[number];
    reasonNote: string | null;
    dismissedAt: string;
    dismissedBy: string | null;
  } | null;
};

export type EmailReviewResponse = {
  neverEmailed: EmailReviewRow[];
  deliveryFailed: EmailReviewRow[];
  dismissed: EmailReviewRow[];
  syncedAt: string | null;
};

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const emailReviewRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const now = new Date();
    // Same floor the classifier uses — never CURDATE(), which would be
    // evaluated in the MySQL server timezone.
    const windowStartDay = emailReviewWindowStart(now);

    const rows = await db
      .select({
        invoiceId: invoices.id,
        qbInvoiceId: invoices.qbInvoiceId,
        docNumber: invoices.docNumber,
        customerId: invoices.customerId,
        customerName: customers.displayName,
        origin: invoices.origin,
        // DATE_FORMAT → plain 'YYYY-MM-DD'. mysql2 hands DATE columns back as
        // local-midnight Date objects, which would shift the day on a
        // non-UTC host; the classifier's contract is a string day.
        issueDate: sql<string | null>`DATE_FORMAT(${invoices.issueDate}, '%Y-%m-%d')`,
        createdAt: invoices.createdAt,
        total: invoices.total,
        balance: invoices.balance,
        status: invoices.status,
        emailStatus: invoices.emailStatus,
        deliveryTime: invoices.deliveryTime,
        deliveryError: invoices.deliveryError,
        invoiceToEmails: customers.invoiceToEmails,
        invoiceCcEmails: customers.invoiceCcEmails,
        dismissReason: invoiceEmailDismissals.reason,
        dismissNote: invoiceEmailDismissals.reasonNote,
        dismissedAt: invoiceEmailDismissals.dismissedAt,
        dismissedBy: users.name,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .leftJoin(invoiceEmailDismissals, eq(invoiceEmailDismissals.invoiceId, invoices.id))
      .leftJoin(users, eq(users.id, invoiceEmailDismissals.dismissedByUserId))
      .where(
        and(
          sql`${invoices.issueDate} >= ${windowStartDay}`,
          or(
            inArray(invoices.emailStatus, [...NOT_EMAILED_STATUSES]),
            isNotNull(invoices.deliveryError),
          ),
        ),
      )
      .orderBy(asc(invoices.issueDate), desc(invoices.balance));

    const syncedRows = await db
      .select({ syncedAt: sql<string | Date | null>`MAX(${invoices.lastSyncedAt})` })
      .from(invoices);

    const out: EmailReviewResponse = {
      neverEmailed: [],
      deliveryFailed: [],
      dismissed: [],
      syncedAt: iso(syncedRows[0]?.syncedAt ?? null),
    };

    for (const r of rows) {
      // A dismissal only hides the row while it is newer than QBO's last
      // delivery attempt (isDismissalActive). Stale dismissals fall through
      // to the live buckets but keep their `dismissal` info for display.
      const dismissed =
        r.dismissReason !== null && isDismissalActive(r.dismissedAt, r.deliveryTime);
      // Classify as if not dismissed so actively-dismissed rows that would
      // otherwise qualify land in the Dismissed tab (restore path); rows
      // that no longer qualify at all are dropped regardless of dismissal.
      const bucket: EmailReviewBucket | null = classifyForEmailReview(
        {
          emailStatus: r.emailStatus,
          deliveryError: r.deliveryError,
          status: r.status,
          total: r.total,
          balance: r.balance,
          issueDate: r.issueDate,
          createdAt: r.createdAt,
          dismissedAt: null,
          deliveryTime: r.deliveryTime,
        },
        now,
      );
      if (!bucket) continue;

      const row: EmailReviewRow = {
        invoiceId: r.invoiceId,
        qbInvoiceId: r.qbInvoiceId,
        docNumber: r.docNumber,
        customerId: r.customerId,
        customerName: r.customerName,
        origin: r.origin,
        issueDate: r.issueDate,
        createdAt: iso(r.createdAt) ?? now.toISOString(),
        total: r.total,
        balance: r.balance,
        status: r.status,
        emailStatus: r.emailStatus,
        deliveryTime: iso(r.deliveryTime),
        deliveryError: r.deliveryError,
        recipients: {
          to: strings(r.invoiceToEmails),
          cc: strings(r.invoiceCcEmails),
        },
        dismissal:
          r.dismissReason && r.dismissedAt
            ? {
                reason: r.dismissReason,
                reasonNote: r.dismissNote,
                dismissedAt: iso(r.dismissedAt) ?? now.toISOString(),
                dismissedBy: r.dismissedBy,
              }
            : null,
      };

      if (dismissed) out.dismissed.push(row);
      else if (bucket === "never_emailed") out.neverEmailed.push(row);
      else out.deliveryFailed.push(row);
    }

    return reply.send(out);
  });

  app.post("/dismiss", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = dismissBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { invoiceId, reason } = parse.data;
    const reasonNote = parse.data.reasonNote?.trim() || null;

    const invoiceRows = await db
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1);
    if (!invoiceRows[0]) return reply.code(404).send({ error: "invoice not found" });

    const beforeRows = await db
      .select()
      .from(invoiceEmailDismissals)
      .where(eq(invoiceEmailDismissals.invoiceId, invoiceId))
      .limit(1);
    const before = beforeRows[0] ?? null;

    const dismissedAt = new Date();
    await db
      .insert(invoiceEmailDismissals)
      .values({ invoiceId, reason, reasonNote, dismissedAt, dismissedByUserId: user.id })
      .onDuplicateKeyUpdate({
        set: { reason, reasonNote, dismissedAt, dismissedByUserId: user.id },
      });

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "invoice_email_review.dismiss",
      entityType: "invoice",
      entityId: invoiceId,
      before: before ? { ...before } : null,
      after: { invoiceId, reason, reasonNote, dismissedAt: dismissedAt.toISOString(), dismissedByUserId: user.id },
    });

    log.info({ invoiceId, reason, userId: user.id }, "email-review dismissed");
    return reply.send({ ok: true });
  });

  app.post("/restore", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = restoreBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply.code(400).send({ error: "invalid body", details: parse.error.flatten() });
    }
    const { invoiceId } = parse.data;

    const beforeRows = await db
      .select()
      .from(invoiceEmailDismissals)
      .where(eq(invoiceEmailDismissals.invoiceId, invoiceId))
      .limit(1);
    const before = beforeRows[0] ?? null;
    if (!before) return reply.code(404).send({ error: "no dismissal to restore" });

    await db
      .delete(invoiceEmailDismissals)
      .where(eq(invoiceEmailDismissals.invoiceId, invoiceId));

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "invoice_email_review.restore",
      entityType: "invoice",
      entityId: invoiceId,
      before: { ...before },
      after: null,
    });

    log.info({ invoiceId, userId: user.id }, "email-review dismissal restored");
    return reply.send({ ok: true });
  });
};

export default emailReviewRoutes;
```

Notes for the implementer:
- `customers.displayName`, `customers.invoiceToEmails`, `customers.invoiceCcEmails` are the Drizzle property names for `display_name`, `invoice_to_emails`, `invoice_cc_emails` — verify with `grep -n "displayName\|invoiceToEmails\|invoiceCcEmails" src/db/schema/customers.ts` before relying on them; if the JSON columns are typed `$type<string[]>()` the `strings()` helper still applies (defensive).
- If `tsc` complains that `before: { ...before }` is not assignable to `Record<string, unknown>`, cast the spread through `as Record<string, unknown>` — the audit column is `json().$type<Record<string, unknown>>()`.

- [ ] **Step 4: Register the plugin**

In `src/server/routes/index.ts`, add the import next to the invoicing import:

```ts
import invoicingEmailReviewRoutes from "./invoicing-email-review.js";
```

and directly after `await app.register(invoicingRoutes, { prefix: "/api/invoicing" });`:

```ts
  await app.register(invoicingEmailReviewRoutes, { prefix: "/api/invoicing/email-review" });
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run src/server/routes/invoicing-email-review.test.ts` → PASS (5 tests).
Run: `npx tsc --noEmit` → no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes/invoicing-email-review.ts src/server/routes/invoicing-email-review.test.ts src/server/routes/index.ts
git commit -m "feat(email-review): GET list + dismiss/restore routes with audit"
```

---

### Task 5: UI — hook, section component, Today page wiring

**Files:**
- Create: `src/web/components/invoicing/email-review-section.tsx`
- Modify: `src/web/pages/invoicing-today.tsx` — imports (top), `Summary` call (~line 342), section insertion point (just before the `{/* ──── Returns section ──── */}` comment, ~line 461), `Summary` component (~line 697) and its grid (~line 711)

There is no DOM test environment in this repo (see memory: extract UI logic to plain `.ts` when it needs tests). The only logic here is formatting; keep it inline.

- [ ] **Step 1: Create the section component**

Create `src/web/components/invoicing/email-review-section.tsx`:

```tsx
// Email review — invoices QBO says were never emailed, or whose email
// bounced. Data: GET /api/invoicing/email-review (mirrors QBO's
// EmailStatus/DeliveryInfo, refreshed by the 30-min QB sync). Send reuses
// InvoiceSendDialog (same path as the customer page); Dismiss/Restore hit
// this section's own endpoints.

import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { AlertTriangle, MailX, RotateCcw } from "lucide-react";
import InvoiceSendDialog from "../invoice-send-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardBody } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { cn } from "../../lib/cn";

export type EmailReviewRow = {
  invoiceId: string;
  qbInvoiceId: string;
  docNumber: string | null;
  customerId: string;
  customerName: string;
  origin: "feldart" | "tj";
  issueDate: string | null;
  createdAt: string;
  total: string;
  balance: string;
  status: string | null;
  emailStatus: string | null;
  deliveryTime: string | null;
  deliveryError: string | null;
  recipients: { to: string[]; cc: string[] };
  dismissal: {
    reason: DismissReason;
    reasonNote: string | null;
    dismissedAt: string;
    dismissedBy: string | null;
  } | null;
};

export type EmailReviewResponse = {
  neverEmailed: EmailReviewRow[];
  deliveryFailed: EmailReviewRow[];
  dismissed: EmailReviewRow[];
  syncedAt: string | null;
};

type DismissReason = "sent_elsewhere" | "no_invoice_needed" | "other";
const REASON_LABELS: Record<DismissReason, string> = {
  sent_elsewhere: "Sent another way",
  no_invoice_needed: "No invoice needed",
  other: "Other",
};

export const EMAIL_REVIEW_QUERY_KEY = ["invoicing", "email-review"] as const;

export function useEmailReview(): UseQueryResult<EmailReviewResponse> {
  return useQuery<EmailReviewResponse>({
    queryKey: EMAIL_REVIEW_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/invoicing/email-review");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });
}

type Tab = "never_emailed" | "delivery_failed" | "dismissed";

function money(v: string): string {
  const n = Number(v);
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function ageDays(isoDay: string | null): string {
  if (!isoDay) return "";
  const days = Math.floor((Date.now() - new Date(`${isoDay}T00:00:00Z`).getTime()) / 86_400_000);
  return days <= 0 ? "today" : `${days}d`;
}

function timeOfDay(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) message = j.error;
    } catch {
      // keep the HTTP status message
    }
    throw new Error(message);
  }
}

export function EmailReviewSection({
  id,
  query,
}: {
  id: string;
  query: UseQueryResult<EmailReviewResponse>;
}) {
  const [tab, setTab] = useState<Tab>("never_emailed");
  const data = query.data;
  const counts = {
    never_emailed: data?.neverEmailed.length ?? 0,
    delivery_failed: data?.deliveryFailed.length ?? 0,
    dismissed: data?.dismissed.length ?? 0,
  };
  const rows: EmailReviewRow[] =
    tab === "never_emailed"
      ? data?.neverEmailed ?? []
      : tab === "delivery_failed"
        ? data?.deliveryFailed ?? []
        : data?.dismissed ?? [];

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "never_emailed", label: "Never emailed" },
    { key: "delivery_failed", label: "Delivery failed" },
    { key: "dismissed", label: "Dismissed" },
  ];

  return (
    <section id={id} className="space-y-3 mt-8 pt-6 border-t-2 border-default scroll-mt-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Email review</h2>
          <p className="text-sm text-secondary">
            What QuickBooks says about recent invoices: never emailed by anyone, or emailed and
            bounced. As of {timeOfDay(data?.syncedAt ?? null)} (30-min QB sync).
          </p>
        </div>
        <div className="flex gap-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm",
                tab === t.key ? "bg-surface-raised font-medium" : "text-secondary hover:text-primary",
              )}
            >
              {t.label}
              <span className="ml-1.5 text-xs text-secondary">{counts[t.key]}</span>
            </button>
          ))}
        </div>
      </div>

      {query.isPending && (
        <Card>
          <CardBody>
            <p className="text-sm text-secondary">Loading email review…</p>
          </CardBody>
        </Card>
      )}
      {query.isError && (
        <Card>
          <CardBody className="flex items-center justify-between gap-3">
            <p className="text-sm text-accent-critical">
              Couldn't load: {query.error instanceof Error ? query.error.message : "unknown error"}
            </p>
            <Button size="sm" variant="secondary" onClick={() => query.refetch()}>
              Retry
            </Button>
          </CardBody>
        </Card>
      )}
      {data && rows.length === 0 && (
        <Card>
          <CardBody>
            <p className="text-sm text-secondary">
              {tab === "dismissed"
                ? "Nothing dismissed."
                : "Nothing waiting — QuickBooks agrees every recent invoice was emailed."}
            </p>
          </CardBody>
        </Card>
      )}
      {data && rows.length > 0 && (
        <Card>
          <ul className="divide-y divide-default">
            {rows.map((row) => (
              <EmailReviewRowItem key={row.invoiceId} row={row} tab={tab} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}

function EmailReviewRowItem({ row, tab }: { row: EmailReviewRow; tab: Tab }) {
  const queryClient = useQueryClient();
  const [sendOpen, setSendOpen] = useState(false);
  const [dismissOpen, setDismissOpen] = useState(false);
  const [reason, setReason] = useState<DismissReason>("sent_elsewhere");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: EMAIL_REVIEW_QUERY_KEY });

  const dismiss = useMutation({
    mutationFn: () =>
      postJson("/api/invoicing/email-review/dismiss", {
        invoiceId: row.invoiceId,
        reason,
        reasonNote: note.trim() || undefined,
      }),
    onSuccess: () => {
      setDismissOpen(false);
      setError(null);
      void invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const restore = useMutation({
    mutationFn: () => postJson("/api/invoicing/email-review/restore", { invoiceId: row.invoiceId }),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  const noteRequired = reason === "other" && note.trim().length === 0;

  return (
    <li className="p-3 md:p-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">#{row.docNumber ?? row.qbInvoiceId}</span>
            <Link
              to="/customers/$customerId"
              params={{ customerId: row.customerId }}
              className="truncate text-accent-primary underline-offset-2 hover:underline"
            >
              {row.customerName}
            </Link>
            {row.origin === "tj" && <Badge tone="neutral">TJ</Badge>}
            {row.deliveryError && (
              <Badge tone="critical">
                <MailX className="mr-1 inline h-3 w-3" />
                {row.deliveryError}
              </Badge>
            )}
            {!row.deliveryError && (
              <Badge tone="warning">
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                {row.emailStatus ?? "NotSet"}
              </Badge>
            )}
          </div>
          <div className="text-sm text-secondary">
            Issued {row.issueDate ?? "—"} ({ageDays(row.issueDate)}) · {money(row.total)} total ·{" "}
            {money(row.balance)} open
            {row.deliveryTime && ` · last email ${new Date(row.deliveryTime).toLocaleString()}`}
          </div>
          <div className="text-sm">
            <span className="font-medium">{row.recipients.to.join(", ") || "no TO address"}</span>
            {row.recipients.cc.length > 0 && (
              <span className="text-secondary"> · cc {row.recipients.cc.join(", ")}</span>
            )}
          </div>
          {row.dismissal && (
            <div className="text-xs text-secondary">
              Dismissed {new Date(row.dismissal.dismissedAt).toLocaleString()}
              {row.dismissal.dismissedBy ? ` by ${row.dismissal.dismissedBy}` : ""} ·{" "}
              {REASON_LABELS[row.dismissal.reason]}
              {row.dismissal.reasonNote ? ` — ${row.dismissal.reasonNote}` : ""}
            </div>
          )}
          {error && <div className="text-xs text-accent-critical">{error}</div>}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {tab === "dismissed" ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => restore.mutate()}
              disabled={restore.isPending}
            >
              <RotateCcw className="mr-1 h-3.5 w-3.5" />
              Restore
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={() => setSendOpen(true)}>
                Send via QBO
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDismissOpen((v) => !v)}>
                Dismiss
              </Button>
            </>
          )}
        </div>
      </div>

      {dismissOpen && tab !== "dismissed" && (
        <div className="mt-3 flex flex-col gap-2 rounded-md bg-surface-raised p-3 md:flex-row md:items-center">
          <Select
            value={reason}
            onChange={(e) => setReason(e.target.value as DismissReason)}
            className="md:w-48"
          >
            {(Object.keys(REASON_LABELS) as DismissReason[]).map((r) => (
              <option key={r} value={r}>
                {REASON_LABELS[r]}
              </option>
            ))}
          </Select>
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={reason === "other" ? "Why? (required)" : "Note (optional)"}
            maxLength={500}
            className="md:flex-1"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => dismiss.mutate()}
              disabled={dismiss.isPending || noteRequired}
            >
              Confirm
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDismissOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {sendOpen && (
        <InvoiceSendDialog
          open={sendOpen}
          onOpenChange={setSendOpen}
          customerId={row.customerId}
          customerName={row.customerName}
          invoice={{
            qbInvoiceId: row.qbInvoiceId,
            docNumber: row.docNumber,
            total: row.total,
            balance: row.balance,
            issueDate: row.issueDate,
            dueDate: null,
          }}
          onSent={() => {
            setSendOpen(false);
            // Optimistic: drop the row now; the next sync confirms EmailSent.
            queryClient.setQueryData<EmailReviewResponse>(EMAIL_REVIEW_QUERY_KEY, (prev) =>
              prev
                ? {
                    ...prev,
                    neverEmailed: prev.neverEmailed.filter((r) => r.invoiceId !== row.invoiceId),
                    deliveryFailed: prev.deliveryFailed.filter((r) => r.invoiceId !== row.invoiceId),
                  }
                : prev,
            );
          }}
        />
      )}
    </li>
  );
}
```

Implementer checks before moving on:
- `Badge` tones: run `grep -n "tone" src/web/components/ui/badge.tsx` and use only tones that exist (the Today page already uses `neutral`, `info`, `critical`; if `warning` is absent use `info`).
- `Button` variants: `grep -n "variant" src/web/components/ui/button.tsx`; if `ghost` is absent use `secondary`.
- Customer route param: `grep -n 'path: "/customers' src/web/main.tsx` — use the exact `$param` name the route declares in the `Link` above.
- `InvoiceSendDialog`'s `onSent` callback type is `InvoiceSendSuccess`; ignoring the argument is fine.
- Utility classes `bg-surface-raised`, `text-accent-critical`, `border-default`, `text-secondary` are the ones the Today page already uses; do not invent new tokens.

- [ ] **Step 2: Wire into the Today page**

In `src/web/pages/invoicing-today.tsx`:

a) Add the import after the `ShipmentRowMobile` import:

```ts
import { EmailReviewSection, useEmailReview } from "../components/invoicing/email-review-section";
import { MailWarning } from "lucide-react";
```

(If `MailWarning` does not exist in the installed lucide version, use `MailX`.)

b) Inside `InvoicingTodayPage`, next to the other `useQuery` hooks (after the `unmatchedData` query, ~line 280):

```ts
  const emailReview = useEmailReview();
  const emailReviewCount =
    (emailReview.data?.neverEmailed.length ?? 0) +
    (emailReview.data?.deliveryFailed.length ?? 0);
```

c) Extend the `<Summary … />` call (~line 342) with two props:

```tsx
          emailReviewCount={emailReviewCount}
          onScrollToEmailReview={() => {
            document
              .getElementById("email-review-section")
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
```

d) Directly before the `{/* ──────────────── Returns section ──── */}` comment, add:

```tsx
      {/* ──────────────── Email review ─────────────────────────────── */}
      {data && <EmailReviewSection id="email-review-section" query={emailReview} />}
```

e) In the `Summary` component props type add:

```ts
  emailReviewCount: number;
  onScrollToEmailReview: () => void;
```

change its grid class from `md:grid-cols-3` to `md:grid-cols-2 lg:grid-cols-4`, and append a fourth card after the returns card:

```tsx
      <StatCard
        icon={MailWarning}
        iconClassName="text-accent-warning"
        count={props.emailReviewCount}
        label={`invoice${props.emailReviewCount === 1 ? "" : "s"} need email review`}
        onClick={props.onScrollToEmailReview}
      />
```

- [ ] **Step 3: Typecheck and build**

Run: `npx tsc --noEmit` → no errors.
Run: `npm run build` → completes (the existing ~2.5 MB chunk-size warning is pre-existing and fine).

- [ ] **Step 4: Smoke in the dev server (if a local MySQL/Redis is available; otherwise skip and note it)**

Run: `npm run dev` and open `http://localhost:5173/invoicing`. Expect a fourth stat card and an "Email review" section between Orders and Returns. With no synced `email_status` yet, both lists are empty and the empty-state copy shows.

- [ ] **Step 5: Commit**

```bash
git add src/web/components/invoicing/email-review-section.tsx src/web/pages/invoicing-today.tsx
git commit -m "feat(email-review): Email review section + stat card on Invoicing Today"
```

---

### Task 6: Full verification

- [ ] **Step 1: Whole test suite**

Run: `npx vitest run`
Expected: all green (previous baseline plus the 3 new files).

- [ ] **Step 2: Typecheck + build once more from clean**

Run: `npx tsc --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 3: Review the diff for convention slips**

Run: `git diff main --stat` and `git diff main -- src | grep -n "console.log\|process.env\|: any\b"`
Expected: no matches.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin worktree-invoice-email-review
```

Deployment (migration 0057 + dist) is done by the orchestrating session over `ssh finance-vps` per the standing recipe, followed by one QB sync cycle and a manual check that the never-emailed list matches the audit's bucket 2 and the failed list shows the 15 bounced invoices.

---

## Self-review

- **Spec coverage:** §1 sync → Task 2; §2 dismissals → Task 1 + 4; §3 rules → Task 3 (window, grace, void, future date, balance, dismissal, NULL status all tested); §4 API → Task 4 (shape, syncedAt, audit, 404s); §5 UI → Task 5 (tabs, row fields, Send via `InvoiceSendDialog`, Dismiss with required note for "other", Restore, stat card, empty state, mobile stacking via flex-col); §6 errors → Task 2 warn-on-unparsable, Task 4 zod 400 / 404, Task 5 retry + inline error; §7 tests → Tasks 2, 3, 4; §8 rollout → Task 6 + orchestrator.
- **Placeholders:** none; every code step is complete. Two "verify before relying" notes point at exact greps rather than guesses.
- **Type consistency:** `EmailReviewRow` / `EmailReviewResponse` shapes are identical in Task 4 and Task 5; `EMAIL_REVIEW_DISMISS_REASONS` values match the UI `DismissReason` union and the zod enum; `NOT_EMAILED_STATUSES` is used by both the classifier and the SQL pre-filter; `classifyForEmailReview` signature `(candidate, now)` is the same in tests and route.
