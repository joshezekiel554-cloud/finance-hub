# Returns Workflow Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the returns processing workflow off the Today tab's inline review dialog and onto the RMA detail page. Add passive email-to-RMA linking. Replace the credit memo dialog with a QBO-mirror create page. Fix three independent bugs (SKU order, recipient list, memo on statements).

**Architecture:** Three pillars — passive email-RMA linking via Gmail poll, RMA-page-centric processing flow, QBO-mirror credit memo create page (its own route).

**Tech Stack:** TanStack Router routes for the new credit memo page, Drizzle migration for the new tables, Zod for new endpoint schemas, sanitize-html for the email card body, existing Gmail+QBO+sanitize pipelines.

**Reference spec:** `docs/superpowers/specs/2026-05-07-returns-redesign.md`

---

## File Structure

**New files:**
- `migrations/<next>_email_rma_links.sql` — Drizzle migration
- `src/server/modules/rma/rma-number-format.ts` — regex + parser, single source of truth
- `src/server/modules/rma/email-linker.ts` — scanner module
- `src/web/components/return-receipt-card.tsx` — collapsible card renderer
- `src/web/components/process-return-panel.tsx` — RMA detail page panel
- `src/web/pages/credit-memo-create.tsx` — unified QBO-mirror create page
- `src/web/lib/search-schemas/credit-memo-create.ts` — Zod search schema for the new route

**Modified files:**
- `src/db/schema/returns.ts` — add `email_rma_links` table, `damages_note` column on `rmas`, `dismissed_at` / `dismissed_reason` / `dismissed_by_user_id` on `extensiv_receipts`
- `src/server/routes/returns.ts` — new endpoints
- `src/server/routes/invoicing.ts` — Today response includes linked RMAs
- `src/server/modules/email/inbound-classifier.ts` (verify path) — call email linker on classify
- `src/server/modules/qbo/credit-memo-builder.ts` (verify path) — `CustomerMemo` not `PrivateNote`
- `src/server/modules/email/send-pipeline.ts` (verify path) — credit memo branch uses invoice recipients
- `src/web/main.tsx` — register new credit memo route
- `src/web/pages/return-detail.tsx` — wire `ProcessReturnPanel`
- `src/web/pages/invoicing-today.tsx` — replace inline review with card list
- `src/web/components/rma-items-table.tsx` — preserve SKU order
- (Receipt parser file, path TBV in implementer step) — preserve SKU order

**Deletions (Phase 5, post-cutover only):**
- `src/web/components/return-receipt-review-dialog.tsx`
- `src/web/components/rma-credit-memo-dialog.tsx` (the existing dialog)

---

## Phase 0: Foundation

### Task 0.1: Schema migration

**Files:**
- Modify: `src/db/schema/returns.ts`
- Generate: `migrations/<next>_email_rma_links.sql`

- [ ] **Step 1: Add the `email_rma_links` table to the schema**

In `src/db/schema/returns.ts`, add:

```ts
export const emailRmaLinks = mysqlTable(
  "email_rma_links",
  {
    gmailMessageId: varchar("gmail_message_id", { length: 64 }).notNull(),
    rmaId: varchar("rma_id", { length: 24 }).notNull(),
    source: mysqlEnum("source", ["auto", "manual"]).notNull().default("auto"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.gmailMessageId, t.rmaId] }),
    rmaIdx: index("email_rma_links_rma_idx").on(t.rmaId),
    gmailIdx: index("email_rma_links_gmail_idx").on(t.gmailMessageId),
  }),
);

export type EmailRmaLink = typeof emailRmaLinks.$inferSelect;
```

- [ ] **Step 2: Add `damages_note` column to `rmas`**

```ts
// inside the existing rmas table definition:
damagesNote: text("damages_note"),
```

- [ ] **Step 3: Add dismiss columns to `extensiv_receipts` (or whatever table holds the warehouse emails)**

If the table is named differently, find it via `grep -n "extensiv_receipts\|warehouse_receipt" src/db/schema/returns.ts`. Add:

```ts
dismissedAt: timestamp("dismissed_at"),
dismissedReason: varchar("dismissed_reason", { length: 64 }),
dismissedByUserId: varchar("dismissed_by_user_id", { length: 255 }),
```

- [ ] **Step 4: Generate the migration**

```bash
npx drizzle-kit generate
```

This produces `migrations/<NNNN>_<name>.sql`. Review the generated SQL — confirm it adds the new table + new columns without dropping anything unexpected.

- [ ] **Step 5: Apply the migration**

```bash
npx drizzle-kit migrate
```

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/db/schema/returns.ts migrations/
git commit -m "feat(returns-redesign): schema for email_rma_links + damages_note + receipt dismiss"
```

---

### Task 0.2: RMA number format module

**Files:**
- Create: `src/server/modules/rma/rma-number-format.ts`

- [ ] **Step 1: Write the module**

```ts
// src/server/modules/rma/rma-number-format.ts
//
// Single source of truth for RMA number patterns. Used by the email
// linker to detect RMA references in inbound email subject + body.
//
// Patterns:
//   - DC##### for damage credit memos (5-digit, currently starts at DC38771)
//   - 5-7 digit sequential for seasonal/non-seasonal
//   - <rmaNumber>CR is the credit memo doc number (NOT auto-link target —
//     a CM doc number references back to its source RMA but linking the
//     CM email to the RMA via this pattern would create circular noise).

const DAMAGE_RE = /\bDC\d{5}\b/g;
const SEASONAL_RE = /\b\d{5,7}\b/g;

// Anchored exclusion: don't pick up <number>CR — that's a CM doc number.
const CR_SUFFIX_RE = /\b\d+CR\b/g;

export type ExtractedRmaRef = { number: string; kind: "damage" | "sequential" };

export function extractRmaNumbers(text: string): ExtractedRmaRef[] {
  if (!text) return [];
  const seen = new Set<string>();
  const refs: ExtractedRmaRef[] = [];

  // Strip CM doc number patterns first so they don't show up as bare digits
  const cleaned = text.replace(CR_SUFFIX_RE, "");

  for (const m of cleaned.matchAll(DAMAGE_RE)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      refs.push({ number: m[0], kind: "damage" });
    }
  }

  for (const m of cleaned.matchAll(SEASONAL_RE)) {
    // Skip if already captured as a damage number (DC##### contains a 5-digit run)
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      refs.push({ number: m[0], kind: "sequential" });
    }
  }

  return refs;
}
```

- [ ] **Step 2: Quick smoke-test in REPL or tiny test file**

Verify manually:
- `extractRmaNumbers("Pesach 26 returns (98863) has been counted")` → `[{ number: "98863", kind: "sequential" }]`
- `extractRmaNumbers("DC38771 damage credit issued")` → `[{ number: "DC38771", kind: "damage" }]`
- `extractRmaNumbers("Credit memo 123CR was sent")` → `[]` (the CR-suffix is stripped first)
- `extractRmaNumbers("RMA 98863, see attached DC38771")` → both refs

- [ ] **Step 3: Commit**

```bash
git add src/server/modules/rma/rma-number-format.ts
git commit -m "feat(returns-redesign): add RMA number format module for email auto-linking"
```

---

### Task 0.3: Email linker module

**Files:**
- Create: `src/server/modules/rma/email-linker.ts`

- [ ] **Step 1: Inventory inputs first**

Before writing, confirm:
- Where the Gmail poll's per-email handler lives. Likely `src/server/modules/email/inbound-classifier.ts` or `src/jobs/gmail-poll.ts`. Use `grep -rn "classify\|gmail.*poll" src/server src/jobs --include="*.ts" | head -20`.
- The shape of the persisted email row — find via `grep -rn "gmail_message_id\|gmailMessageId" src/db/schema --include="*.ts" | head`. Note the table name + which column stores the body text.
- The existing helper for fetching an email body from Gmail API. Likely lives in `src/integrations/gmail/`.

- [ ] **Step 2: Write the module**

```ts
// src/server/modules/rma/email-linker.ts
//
// Scans inbound emails for RMA number references and persists the
// email→RMA association in email_rma_links. Two entry points:
//   - linkEmailToRmas(messageId): called per-email at Gmail poll time
//   - backfillLinksForRma(rmaId): called when an RMA gets a number,
//     and on-demand from the "Check for emails" button on the RMA page

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { emailRmaLinks, rmas } from "../../db/schema/returns.js";
import { extractRmaNumbers } from "./rma-number-format.js";
import { searchGmail } from "../../integrations/gmail/client.js"; // verify path
import { getEmailBodyText } from "../../integrations/gmail/client.js"; // verify path
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "rma.email-linker" });

// Called when a new email is classified by the Gmail poller. Scans the
// (subject + body) for RMA number patterns and inserts link rows for
// any matching RMAs. Idempotent — duplicate inserts ignored via the
// composite PK on (gmail_message_id, rma_id).
export async function linkEmailToRmas(
  gmailMessageId: string,
  subject: string,
  body: string,
): Promise<{ linked: string[] }> {
  const refs = extractRmaNumbers(`${subject}\n${body}`);
  if (refs.length === 0) return { linked: [] };

  const numbers = refs.map((r) => r.number);
  const matchingRmas = await db
    .select({ id: rmas.id })
    .from(rmas)
    .where(sql`${rmas.rmaNumber} IN ${numbers}`);

  if (matchingRmas.length === 0) return { linked: [] };

  const linked: string[] = [];
  for (const rma of matchingRmas) {
    try {
      await db
        .insert(emailRmaLinks)
        .values({
          gmailMessageId,
          rmaId: rma.id,
          source: "auto",
        })
        .onDuplicateKeyUpdate({ set: { rmaId: rma.id } }); // no-op on dup
      linked.push(rma.id);
    } catch (err) {
      log.warn({ err, gmailMessageId, rmaId: rma.id }, "link insert failed");
    }
  }

  return { linked };
}

// Backfill: search Gmail for the RMA number across the last 90 days,
// link any matches not already linked. Used at RMA-number-assigned
// time and on-demand from the UI button.
export async function backfillLinksForRma(rmaId: string): Promise<{
  scanned: number;
  newLinks: number;
}> {
  const rmaRow = await db
    .select({ rmaNumber: rmas.rmaNumber })
    .from(rmas)
    .where(eq(rmas.id, rmaId))
    .limit(1);

  if (!rmaRow.length || !rmaRow[0]!.rmaNumber) {
    return { scanned: 0, newLinks: 0 };
  }
  const rmaNumber = rmaRow[0]!.rmaNumber;

  // Gmail search: the number anywhere in subject or body, last 90 days.
  // Adjust the search query format to whatever searchGmail accepts.
  const messages = await searchGmail({
    query: `"${rmaNumber}" newer_than:90d`,
    maxResults: 100,
  });

  let newLinks = 0;
  for (const m of messages) {
    const body = await getEmailBodyText(m.id);
    const result = await linkEmailToRmas(m.id, m.subject ?? "", body ?? "");
    if (result.linked.includes(rmaId)) {
      newLinks++;
    }
  }

  return { scanned: messages.length, newLinks };
}
```

> **Implementer note:** the imports for `searchGmail` and `getEmailBodyText` are best-guess paths. Use `grep -rn "function searchGmail\|searchGmail =\|export.*searchGmail" src/integrations/gmail` to find the actual export. If the helpers don't exist, write thin wrappers around the existing Gmail client used by the poller.

- [ ] **Step 3: Typecheck**

Run `npx tsc --noEmit`. Address any type mismatches against the actual Gmail client API.

- [ ] **Step 4: Commit**

```bash
git add src/server/modules/rma/email-linker.ts
git commit -m "feat(returns-redesign): email linker module with poll-time + backfill entry points"
```

---

### Task 0.4: Wire email linker into Gmail poll classifier

**Files:**
- Modify: `src/server/modules/email/inbound-classifier.ts` (or wherever per-email classification happens)

- [ ] **Step 1: Find the classifier hook**

`grep -rn "classify\|classifyInboundEmail" src/server src/jobs src/modules --include="*.ts" | head -20`

The handler that runs after a new email is persisted is the right injection point. We want to call `linkEmailToRmas` AFTER the email row is in the DB (so foreign-key references work) and BEFORE downstream side effects that depend on link state.

- [ ] **Step 2: Inject the call**

After the email is persisted with its `gmailMessageId`, `subject`, and `body`:

```ts
import { linkEmailToRmas } from "../rma/email-linker.js";

// ... existing classifier code ...

await linkEmailToRmas(persistedEmail.gmailMessageId, persistedEmail.subject ?? "", persistedEmail.bodyText ?? "");
```

The call is fire-and-forget-safe (errors logged but don't bubble). If you'd rather make linker failures fail the whole classification step, wrap in `try/catch` and log without rethrowing.

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/server/modules/email/inbound-classifier.ts  # or actual file
git commit -m "feat(returns-redesign): call email linker on every Gmail poll classify"
```

---

### Task 0.5: Server endpoints

**Files:**
- Modify: `src/server/routes/returns.ts`
- Modify: `src/server/routes/invoicing.ts`

- [ ] **Step 1: Add `POST /:id/refresh-email-links` to returns route**

```ts
app.post<{ Params: { id: string } }>("/:id/refresh-email-links", async (req, reply) => {
  await requireAuth(req);
  try {
    const result = await backfillLinksForRma(req.params.id);
    return result;
  } catch (err) {
    reply.code(500);
    return { error: err instanceof Error ? err.message : "Backfill failed" };
  }
});
```

- [ ] **Step 2: Add `POST /extensiv-receipts/:receiptId/dismiss-with-reason` for the three Dismiss actions**

The existing flow already has `POST /api/rmas/extensiv-receipts/:receiptId/confirm` and `POST /api/rmas/extensiv-receipts/:receiptId/dismiss`. The new endpoint sits alongside, dedicated to the three-reason dismiss path (the existing `/dismiss` is for "not a return" and gets unified into this).

```ts
const dismissBodySchema = z.object({
  reason: z.enum(["done", "not_return", "other"]),
  reasonText: z.string().max(500).optional(),
});

app.post<{ Params: { receiptId: string } }>(
  "/extensiv-receipts/:receiptId/dismiss-with-reason",
  async (req, reply) => {
    const user = await requireAuth(req);
    const parse = dismissBodySchema.safeParse(req.body);
    if (!parse.success) {
      reply.code(400);
      return { error: "invalid body", details: parse.error.flatten() };
    }
    const { reason, reasonText } = parse.data;
    const composedReason = reason === "other" && reasonText
      ? `other: ${reasonText}`
      : reason;
    // Update the receipts table — set dismissedAt/dismissedReason/dismissedByUserId.
    // Use the actual receipts table name from Task 0.1 (confirm via grep).
    await db
      .update(extensivReceipts)  // adjust to actual table name
      .set({
        dismissedAt: new Date(),
        dismissedReason: composedReason,
        dismissedByUserId: user.id,
      })
      .where(eq(extensivReceipts.id, req.params.receiptId));
    return { ok: true };
  },
);
```

This endpoint works for both linked and unlinked receipts (the receipt is the entity being dismissed, regardless of whether it has an RMA association).

The existing `/extensiv-receipts/:receiptId/dismiss` endpoint can stay for backward compatibility during the co-existence period; mark it deprecated with a comment.

- [ ] **Step 3: Update Today response to include linked RMAs per receipt**

In `src/server/routes/invoicing.ts`, find the handler for the Today endpoint (likely `GET /api/invoicing/today`). For each receipt row, join with `email_rma_links` (on gmail_message_id) and `rmas` to surface `linkedRmas: [{ rmaId, rmaNumber, customerName }]`.

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/server/routes/returns.ts src/server/routes/invoicing.ts
git commit -m "feat(returns-redesign): refresh-email-links + dismiss-receipt endpoints + linked RMAs in Today"
```

---

## Phase 1: Bug fixes (parallel-safe with Phase 0)

These three tasks touch different files than Phase 0 and don't depend on it. Can run any time.

### Task 1.1: SKU order preservation

**Files:**
- Modify: `src/web/components/rma-items-table.tsx`
- Modify: (receipt parser — find it via `grep -rn "extensiv\|return.*receipt.*parser" src/server src/modules --include="*.ts"`)

- [ ] **Step 1: Audit the wizard items table**

Read `src/web/components/rma-items-table.tsx`. Find every place items are sorted, transformed, or re-ordered. Look for `.sort(`, `localeCompare`, sort buttons, or order changes inside `useMemo` or `useEffect`.

- [ ] **Step 2: Audit the parser**

Find the receipt parser. Read it. Confirm SKU+qty pairs are emitted in the order they appear in the source email's table. Any sort applied? Any `Object.keys()` on a parsed map (which loses insertion order in some JS environments)? Fix any reorder.

- [ ] **Step 3: Fix and add a regression guard comment**

Where the array is built, add a one-line comment: `// Preserve insertion order — operator-visible UI relies on this.` This makes the rule explicit so a future refactor doesn't silently re-add a sort.

- [ ] **Step 4: Typecheck + manual smoke test + commit**

Smoke test: open the RMA wizard, paste a known SKU list, confirm the table renders in the same order. Repeat for receipt review (after Phase 2 ships).

```bash
npx tsc --noEmit
git add src/web/components/rma-items-table.tsx <parser-file>
git commit -m "fix(returns): preserve SKU order in RMA wizard + receipt parser"
```

---

### Task 1.2: Credit memo email recipients → invoice list

**Files:**
- Modify: (credit memo send-pipeline — find via `grep -rn "credit.*memo.*send\|sendCreditMemo" src/server src/modules --include="*.ts"`)

- [ ] **Step 1: Find the recipient-resolution code**

In whatever module sends the credit memo email, find where the `to` field is built. Currently uses chase recipients.

- [ ] **Step 2: Switch the fallback chain**

```ts
// Before:
const to = customer.chaseRecipients;

// After:
const to = customer.invoiceRecipients?.length
  ? customer.invoiceRecipients
  : customer.primaryEmail
    ? [customer.primaryEmail]
    : [];
```

> **Implementer note:** the actual customer field names may differ. Check `src/db/schema/customers.ts` for the exact column. If `invoiceRecipients` is stored as JSON in a column, parse before checking length.

- [ ] **Step 3: Surface the warning in the UI**

This step is best done together with Task 4.x (the new Create Credit Memo page). The page's `To` field should:
- Default-fill from invoice recipients
- Show a small warning banner if invoice recipients are empty and we fell back to primary email
- Block send if all three (invoice, primary, manually entered) are empty

For now, just fix the server side. UI surfacing comes with the redesign.

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add <send-pipeline-file>
git commit -m "fix(returns): credit memo emails go to invoice recipients, not chase"
```

---

### Task 1.3: Credit memo memo on statements

**Files:**
- Modify: (credit memo builder — find via `grep -rn "PrivateNote\|CustomerMemo" src/server src/modules src/integrations --include="*.ts"`)

- [ ] **Step 1: Audit the QBO call**

Find the code that POSTs the credit memo to QBO. Inspect the payload. Two fields matter:
- `PrivateNote` — internal-only, never shown on statements
- `CustomerMemo.value` — visible on statements (assuming the QBO statement template includes it)

- [ ] **Step 2: Switch field if needed**

If we're setting `PrivateNote`, change to `CustomerMemo`:

```ts
// Before:
PrivateNote: memoText,

// After:
CustomerMemo: { value: memoText },
```

If we're already setting `CustomerMemo`, the issue is likely the QBO statement template configuration (out of code scope — operator must adjust in QBO settings).

- [ ] **Step 3: Send a test credit memo + verify**

Use the dev environment to create a test credit memo with a memo. Pull a customer statement that includes that credit memo. Confirm the memo text appears.

If it doesn't appear despite `CustomerMemo` being set, document the QBO template setting that needs changing in a follow-up note for the user.

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add <builder-file>
git commit -m "fix(returns): credit memo memo uses CustomerMemo field for statement visibility"
```

---

## Phase 2: Today tab redesign

### Task 2.1: ReturnReceiptCard component

**Files:**
- Create: `src/web/components/return-receipt-card.tsx`

- [ ] **Step 1: Build the component**

Props:
- `receipt: ReceiptRow` (existing type)
- `linkedRmas: { rmaId: string; rmaNumber: string | null; customerName: string }[]`
- `onDismiss: (reason: "done" | "not_return" | "other", reasonText?: string) => void`
- `defaultExpanded?: boolean`

Render:
- Card with header (sender / date / subject)
- Collapsible body — full HTML, sanitized via `sanitize-html` (already a dep)
- Linked RMA badges below body, click → `Link to={"/returns/$rmaId"}`
- Three dismiss buttons. The `other` button opens a small inline reason input before firing onDismiss.

```tsx
import { useState } from "react";
import sanitizeHtml from "sanitize-html";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
// ... etc.

export function ReturnReceiptCard({
  receipt,
  linkedRmas,
  onDismiss,
  defaultExpanded = false,
}: ReturnReceiptCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [otherReasonInput, setOtherReasonInput] = useState<string | null>(null);
  const cleanHtml = sanitizeHtml(receipt.emailBodyHtml ?? "", {
    /* same allowed tags as elsewhere in the app */
  });

  return (
    <Card>
      <CardBody>
        <button onClick={() => setExpanded(e => !e)} className="flex items-center gap-2">
          {expanded ? <ChevronDown /> : <ChevronRight />}
          <span className="font-medium">{receipt.emailSubject}</span>
          <span className="text-xs text-muted">{receipt.emailFrom} · {receipt.classifiedAt}</span>
        </button>
        {expanded && (
          <div className="mt-2" dangerouslySetInnerHTML={{ __html: cleanHtml }} />
        )}
        {linkedRmas.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {linkedRmas.map((r) => (
              <Link key={r.rmaId} to="/returns/$rmaId" params={{ rmaId: r.rmaId }}>
                <Badge>{r.rmaNumber ?? r.rmaId} · {r.customerName}</Badge>
              </Link>
            ))}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <Button onClick={() => onDismiss("done")}>Dismiss — done</Button>
          <Button onClick={() => onDismiss("not_return")}>Dismiss — not return</Button>
          {otherReasonInput === null ? (
            <Button onClick={() => setOtherReasonInput("")}>Dismiss — other</Button>
          ) : (
            <>
              <Input
                placeholder="Reason"
                value={otherReasonInput}
                onChange={(e) => setOtherReasonInput(e.target.value)}
              />
              <Button onClick={() => onDismiss("other", otherReasonInput ?? "")}>Save</Button>
              <Button variant="ghost" onClick={() => setOtherReasonInput(null)}>Cancel</Button>
            </>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/web/components/return-receipt-card.tsx
git commit -m "feat(returns-redesign): add ReturnReceiptCard component"
```

---

### Task 2.2: Replace Today tab inline review with card list

**Files:**
- Modify: `src/web/pages/invoicing-today.tsx`

- [ ] **Step 1: Locate the existing returns inline review section**

Read `src/web/pages/invoicing-today.tsx`. Find the section that currently renders the `ReturnReceiptReviewDialog` (or its inline equivalent).

- [ ] **Step 2: Replace with a card list**

For each receipt row from the Today response, render `<ReturnReceiptCard receipt={...} linkedRmas={...} onDismiss={(reason, text) => dismissMutation.mutate({ receiptId: receipt.id, reason, reasonText: text })} />`.

The dismiss mutation calls `POST /api/rmas/extensiv-receipts/${receiptId}/dismiss-with-reason` with `{ reason, reasonText }` — receipt-scoped, works whether the receipt has a linked RMA or not (per the unified endpoint added in Task 0.5).

- [ ] **Step 3: Remove the old inline dialog mount**

Delete the `<ReturnReceiptReviewDialog>` component invocation and its surrounding state. Keep the dialog file for now (Phase 5 deletes it).

- [ ] **Step 4: Smoke test**

Run dev. Navigate to `/invoicing`. Confirm:
- Receipts render as cards with subject visible
- Click expand → email body shows
- Linked RMA badges link correctly
- Three dismiss actions work end-to-end (inspect DB row to confirm `dismissed_at` set)

- [ ] **Step 5: Commit**

```bash
git add src/web/pages/invoicing-today.tsx
git commit -m "feat(returns-redesign): Today tab uses ReturnReceiptCard list, no inline review"
```

---

## Phase 3: RMA Process Return panel

### Task 3.1: Build ProcessReturnPanel component

**Files:**
- Create: `src/web/components/process-return-panel.tsx`

- [ ] **Step 1: Component shape**

Props:
- `rmaId: string`
- `damagesNote: string | null` (from RMA record)

Renders three sections:
1. Linked emails — list of `ReturnReceiptCard` (read-only mode — pass empty `onDismiss` or hide buttons)
2. Action buttons — "Check for emails" and "Parse warehouse return"
3. Damages note textarea (auto-saves on blur to PATCH /api/rmas/:id with `{ damagesNote }`)

- [ ] **Step 2: Wire "Check for emails" button**

```tsx
const checkMutation = useMutation({
  mutationFn: async () => {
    const res = await fetch(`/api/rmas/${rmaId}/refresh-email-links`, { method: "POST" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<{ scanned: number; newLinks: number }>;
  },
  onSuccess: (data) => {
    queryClient.invalidateQueries({ queryKey: ["rma", rmaId, "linked-emails"] });
    toast.success(`Scanned ${data.scanned} emails, ${data.newLinks} new link(s)`);
  },
});
```

- [ ] **Step 3: Wire "Parse warehouse return" button**

```tsx
function onParse() {
  // Navigate to /returns/$rmaId/credit-memo — the page's loader does the parse.
  navigate({ to: "/returns/$rmaId/credit-memo", params: { rmaId } });
}
```

- [ ] **Step 4: Linked emails query**

```tsx
const linkedEmailsQuery = useQuery({
  queryKey: ["rma", rmaId, "linked-emails"],
  queryFn: async () => {
    const res = await fetch(`/api/rmas/${rmaId}/linked-emails`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<LinkedEmail[]>;
  },
});
```

> **Implementer note:** the `/api/rmas/:id/linked-emails` endpoint doesn't exist yet — add it to `src/server/routes/returns.ts`. It joins `email_rma_links` with the email-storage table to surface message id, subject, body html, sender, date.

- [ ] **Step 5: Damages note autosave**

```tsx
const [draft, setDraft] = useState(damagesNote ?? "");
const saveDamagesMutation = useMutation({
  mutationFn: async (next: string) => {
    const res = await fetch(`/api/rmas/${rmaId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ damagesNote: next }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  },
});

<textarea
  value={draft}
  onChange={(e) => setDraft(e.target.value)}
  onBlur={() => { if (draft !== damagesNote) saveDamagesMutation.mutate(draft); }}
  placeholder="Damages reported by warehouse — appears on credit memo memo"
/>
```

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/web/components/process-return-panel.tsx src/server/routes/returns.ts
git commit -m "feat(returns-redesign): ProcessReturnPanel + linked-emails endpoint"
```

---

### Task 3.2: Wire ProcessReturnPanel into RMA detail page

**Files:**
- Modify: `src/web/pages/return-detail.tsx`

- [ ] **Step 1: Mount the panel**

Add `<ProcessReturnPanel rmaId={rmaId} damagesNote={rma.damagesNote} />` to the RMA detail render, visible when `rma.status === "sent_to_warehouse"` or `rma.status === "received"`.

- [ ] **Step 2: Don't disturb existing per-status panels**

Other status-specific panels stay as they are. The Process Return panel sits alongside, not replacing.

- [ ] **Step 3: Typecheck + smoke test + commit**

```bash
npx tsc --noEmit
# manual: navigate to a sent_to_warehouse RMA, confirm panel appears + buttons work
git add src/web/pages/return-detail.tsx
git commit -m "feat(returns-redesign): wire ProcessReturnPanel to RMA detail page"
```

---

## Phase 4: Unified Create Credit Memo screen

### Task 4.1: Add credit memo create route

**Files:**
- Create: `src/web/lib/search-schemas/credit-memo-create.ts`
- Modify: `src/web/main.tsx`

- [ ] **Step 1: Search schema**

```ts
// src/web/lib/search-schemas/credit-memo-create.ts
import { z } from "zod";

// Search params for /returns/$rmaId/credit-memo. Currently no params, but
// reserve the schema slot so future filters can be added without a route
// signature change.
export const creditMemoCreateSearchSchema = z.object({});
export type CreditMemoCreateSearch = z.infer<typeof creditMemoCreateSearchSchema>;
```

- [ ] **Step 2: Register the route in main.tsx**

```ts
const creditMemoCreateRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/returns/$rmaId/credit-memo",
  component: CreditMemoCreatePage,
  validateSearch: creditMemoCreateSearchSchema,
});
```

Add to the route tree.

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/web/main.tsx src/web/lib/search-schemas/credit-memo-create.ts
git commit -m "feat(returns-redesign): register /returns/$rmaId/credit-memo route"
```

---

### Task 4.2: Build CreditMemoCreatePage — line items table

**Files:**
- Create: `src/web/pages/credit-memo-create.tsx`

- [ ] **Step 1: Page skeleton + data fetch**

```tsx
const creditMemoCreateRouteApi = getRouteApi("/returns/$rmaId/credit-memo");

export default function CreditMemoCreatePage() {
  const { rmaId } = creditMemoCreateRouteApi.useParams();
  // 1. Fetch RMA detail (existing endpoint)
  // 2. Fetch parsed receipts (new endpoint or derive from linked receipts)
  // 3. Fetch customer (existing endpoint)
  // ...
}
```

- [ ] **Step 2: Build line items state**

Lines combine RMA items + parsed receipt entries:

```ts
type Line = {
  key: string;             // unique row key
  qbItemId: string;
  sku: string;
  description: string;     // "<SKU> (invoice <docNum>, <date>)" — editable
  expectedQty: string | null;  // null for unexpected items
  receivedQty: string;
  unitPrice: string;
  taxable: boolean;
  isUnexpected: boolean;
};
```

Initial state: for each RMA item, build a Line with `expectedQty = item.quantity`, `receivedQty = parsed.qty ?? item.quantity`, `description = ...`, `taxable = false`. For each parsed receipt SKU not on the RMA, append an unexpected Line.

Preserve order: RMA items first (in RMA order), unexpected items appended (in parse order).

- [ ] **Step 3: Render the table**

```tsx
<table>
  <thead>
    <tr>
      <th>SKU</th>
      <th>Description</th>
      <th>Expected</th>
      <th>Received</th>
      <th>Unit price</th>
      <th>Tax</th>
      <th>Total</th>
      <th></th>
    </tr>
  </thead>
  <tbody>
    {lines.map((line, i) => (
      <tr key={line.key}>
        <td>{line.sku}</td>
        <td><Input value={line.description} onChange={(e) => updateLine(i, { description: e.target.value })} /></td>
        <td>{line.expectedQty ?? "—"}</td>
        <td>
          <Input
            type="number"
            value={line.receivedQty}
            onChange={(e) => updateLine(i, { receivedQty: e.target.value })}
            className={cn(
              parseFloat(line.receivedQty) < parseFloat(line.expectedQty ?? "0") && "text-accent-danger",
              parseFloat(line.receivedQty) > parseFloat(line.expectedQty ?? "0") && "text-accent-warning",
            )}
          />
        </td>
        <td><Input type="number" value={line.unitPrice} onChange={(e) => updateLine(i, { unitPrice: e.target.value })} /></td>
        <td><Checkbox checked={line.taxable} onCheckedChange={(v) => updateLine(i, { taxable: !!v })} /></td>
        <td className="text-right">${(parseFloat(line.receivedQty || "0") * parseFloat(line.unitPrice || "0")).toFixed(2)}</td>
        <td><Button variant="ghost" onClick={() => deleteLine(i)}><Trash2 size={14} /></Button></td>
      </tr>
    ))}
  </tbody>
</table>
```

- [ ] **Step 4: Add line buttons**

Below the table:
- `<QboItemPicker onPick={...}>` — adds a new line with the picked item, fires lookup-prices to fill price + invoice info, sets `expectedQty = null` and `isUnexpected = true`
- `<Button onClick={addBlankLine}>Add blank line</Button>` — manual entry without picker

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/web/pages/credit-memo-create.tsx
git commit -m "feat(returns-redesign): CreditMemoCreatePage line items table + add/delete"
```

---

### Task 4.3: Memo, recipients, totals, action buttons

**Files:**
- Modify: `src/web/pages/credit-memo-create.tsx`

- [ ] **Step 1: Subtotal / Tax / Total strip**

Below the table, compute:
- Subtotal = sum of line totals
- Tax = sum of line totals where `taxable === true`, multiplied by configured tax rate (pull from existing tax-rate logic or a per-customer/per-state field)
- Total = subtotal + tax

Show all three inline.

- [ ] **Step 2: Notes + Memo textareas**

```tsx
<textarea
  value={notes}
  onChange={(e) => setNotes(e.target.value)}
  placeholder="Internal notes (not shown on credit memo)"
/>

<textarea
  value={memo}
  onChange={(e) => setMemo(e.target.value)}
  placeholder="Memo — appears on credit memo + customer statement"
/>
```

Pre-populate `memo` on mount with the return-type standard memo + the RMA's `damagesNote` on a new line:

```tsx
const standardMemo = {
  damage: "damaged items",
  seasonal: "seasonal returns",
  non_seasonal: "returns",
}[rma.returnType];
const initialMemo = [standardMemo, rma.damagesNote].filter(Boolean).join("\n");
```

- [ ] **Step 3: Email recipients block**

```tsx
const [emailTo, setEmailTo] = useState(customer.invoiceRecipients ?? "");
const [emailCc, setEmailCc] = useState(settings.invoiceCc ?? "");
const [emailBcc, setEmailBcc] = useState(settings.invoiceBcc ?? "");

// Warning banner if invoiceRecipients is empty
{!customer.invoiceRecipients?.length && (
  <Alert tone="warning">No invoice recipients set — using primary email</Alert>
)}
```

- [ ] **Step 4: Action buttons**

```tsx
<Button onClick={() => submitMutation.mutate({ send: true })}>Send + create in QB</Button>
<Button variant="secondary" onClick={() => submitMutation.mutate({ send: false })}>Save without sending</Button>
<Button variant="ghost" onClick={() => navigate({ to: "/returns/$rmaId", params: { rmaId } })}>Cancel</Button>
```

- [ ] **Step 5: Submit mutation**

```tsx
const submitMutation = useMutation({
  mutationFn: async ({ send }: { send: boolean }) => {
    const res = await fetch(`/api/rmas/${rmaId}/process-return`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        lines: lines.map(l => ({
          qbItemId: l.qbItemId,
          sku: l.sku,
          description: l.description,
          quantity: l.receivedQty,
          unitPrice: l.unitPrice,
          taxable: l.taxable,
        })),
        notes,
        memo,
        sendEmail: send,
        emailTo,
        emailCc,
        emailBcc,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
    queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
    navigate({ to: "/returns/$rmaId", params: { rmaId } });
  },
});
```

- [ ] **Step 6: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/web/pages/credit-memo-create.tsx
git commit -m "feat(returns-redesign): CreditMemoCreatePage memo + recipients + submit"
```

---

### Task 4.4: Server endpoint `POST /:id/process-return`

**Files:**
- Modify: `src/server/routes/returns.ts`

- [ ] **Step 1: Define request schema**

```ts
const processReturnBodySchema = z.object({
  lines: z.array(z.object({
    qbItemId: z.string().min(1),
    sku: z.string().min(1),
    description: z.string().max(2000),
    quantity: z.string().min(1),
    unitPrice: z.string().min(1),
    taxable: z.boolean(),
  })).min(1),
  notes: z.string().max(2000).optional(),
  memo: z.string().max(2000),
  sendEmail: z.boolean(),
  emailTo: z.string().max(500),
  emailCc: z.string().max(500).optional(),
  emailBcc: z.string().max(500).optional(),
});
```

- [ ] **Step 2: Endpoint flow**

```ts
app.post<{ Params: { id: string } }>("/:id/process-return", async (req, reply) => {
  const user = await requireAuth(req);
  const parse = processReturnBodySchema.safeParse(req.body);
  if (!parse.success) {
    reply.code(400);
    return { error: "invalid body", details: parse.error.flatten() };
  }
  const { lines, notes, memo, sendEmail, emailTo, emailCc, emailBcc } = parse.data;

  // 1. Build QBO credit memo payload
  // 2. POST to QBO via existing client
  // 3. Persist the credit memo record locally (link to RMA)
  // 4. Mark RMA as completed
  // 5. Auto-dismiss linked Today receipts (set dismissed_at on the receipts table)
  // 6. If sendEmail: queue/send the email via existing pipeline (use invoice recipients)
  // 7. Return { creditMemoId, qboCreditMemoId }
});
```

> **Implementer note:** the credit memo builder + sender modules already exist (used by the old dialog). Reuse them — this endpoint is mostly orchestration. `CustomerMemo` is set to the `memo` field. Auto-dismiss is the new bit; query `email_rma_links` for this RMA, find linked emails of `email_kind = 'return_receipt'` that aren't already dismissed, set `dismissed_at = now()` and `dismissed_reason = 'done'` and `dismissed_by_user_id = user.id` on those receipt rows.

- [ ] **Step 3: Typecheck + commit**

```bash
npx tsc --noEmit
git add src/server/routes/returns.ts
git commit -m "feat(returns-redesign): process-return endpoint orchestrates QBO + email + dismiss"
```

---

## Phase 5: Cutover

### Task 5.1: Delete old dialogs (after operator validates)

**Files:**
- Delete: `src/web/components/return-receipt-review-dialog.tsx`
- Delete: `src/web/components/rma-credit-memo-dialog.tsx` (if it exists as separate file — verify name)
- Modify: any remaining import sites

- [ ] **Step 1: Operator validation gate**

DO NOT execute this task until the user has confirmed the new flow works in their daily workflow for at least a few days. Subagents should NOT auto-trigger this task — it's controller-gated.

- [ ] **Step 2: Find and remove dead imports**

```bash
grep -rn "ReturnReceiptReviewDialog\|RmaCreditMemoDialog" src/web --include="*.tsx" --include="*.ts"
```

For every match, either remove the import + the usage (if unused) or migrate the call site to the new flow.

- [ ] **Step 3: Delete the files**

```bash
git rm src/web/components/return-receipt-review-dialog.tsx
git rm src/web/components/rma-credit-memo-dialog.tsx  # if applicable
```

- [ ] **Step 4: Typecheck + commit**

```bash
npx tsc --noEmit
git add -A
git commit -m "chore(returns-redesign): remove old receipt-review + credit-memo dialogs"
```

---

## Final review checklist

- [ ] Foundation (Phase 0) end-to-end: a Gmail poll on a known-RMA-numbered email links automatically; visible on RMA page; "Check for emails" backfill works
- [ ] Bug fixes (Phase 1): SKU order preserved in both wizard + receipt parser; credit memo email goes to invoice recipients; memo appears on customer statements after a test send
- [ ] Today tab (Phase 2): cards render with HTML; three dismiss actions persist correctly; auto-dismiss fires when linked CM created
- [ ] RMA panel (Phase 3): linked emails surface; Check button triggers backfill; Parse button navigates to credit memo page; damages textarea autosaves
- [ ] Credit memo create page (Phase 4): line items editable; expected vs received columns visible; add/delete lines work; tax checkbox per line; memo pre-populated; recipients pre-filled from invoice list; submit creates QBO credit memo + sends email + dismisses receipts + marks RMA completed
- [ ] After all phases: invoke `superpowers:finishing-a-development-branch` to wrap up the branch
- [ ] Operator runs the new flow on real data for a few days
- [ ] Phase 5 cutover happens only after operator green-lights it

---

## Implementation handoff

Next: choose execution mode.

**Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, two-stage review between tasks. Same approach as the URL-state plan we just shipped.

**Inline Execution** — execute sequentially in the current session.
