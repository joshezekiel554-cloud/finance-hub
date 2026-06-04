# Customer Detail Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox (`- [ ]`).

**Goal:** Declutter the desktop customer detail page into a two-column layout (work tabs + a persistent context rail with always-visible Notes), and rebuild the Activity tab as a real vertical timeline. Mobile keeps its single-column stack.

**Architecture:** Extract a new `CustomerContextRail` (KPIs → AI summary → Notes → AI context (collapsible) → recipients/meta). Restructure `customer-detail.tsx`'s top into a header card + `flex` two-column grid (main `Card` with tabs+content, rail). Rework `activity-timeline.tsx` from a flat `<ul>` into a day-grouped vertical timeline, reusing its existing `KIND_META`/filter/SSE/links.

**Tech Stack:** React 18 + TanStack Query, Tailwind, lucide-react, vitest. Spec: `docs/superpowers/specs/2026-06-04-customer-detail-redesign-design.md`.

---

### Task 1: Activity timeline — day grouping helper (TDD)

**Files:**
- Modify: `src/web/components/activity-timeline.tsx`
- Create: `src/web/components/activity-timeline.group.test.ts`

- [ ] **Step 1: Failing test** — `groupActivitiesByDay` returns day buckets, newest-first, each with items newest-first and a stable `dayKey` (local YYYY-MM-DD).

```ts
import { describe, expect, it } from "vitest";
import { groupActivitiesByDay } from "./activity-timeline.js";

const mk = (id: string, iso: string) => ({ id, occurredAt: iso, kind: "email_out" } as any);

describe("groupActivitiesByDay", () => {
  it("buckets by local day, newest day first, newest item first", () => {
    const a = mk("a", "2026-05-13T16:30:00Z");
    const b = mk("b", "2026-05-12T18:00:00Z");
    const c = mk("c", "2026-05-12T12:00:00Z");
    const groups = groupActivitiesByDay([c, a, b]);
    expect(groups.map((g) => g.dayKey)).toEqual(["2026-05-13", "2026-05-12"]);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(["b", "c"]);
  });
  it("returns [] for empty input", () => {
    expect(groupActivitiesByDay([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect fail** (`groupActivitiesByDay` not exported).
- [ ] **Step 3: Implement + export** in `activity-timeline.tsx`:

```ts
export function groupActivitiesByDay<T extends { occurredAt: string }>(
  items: T[],
): { dayKey: string; items: T[] }[] {
  const sorted = [...items].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
  const map = new Map<string, T[]>();
  for (const it of sorted) {
    const d = new Date(it.occurredAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    (map.get(key) ?? map.set(key, []).get(key)!).push(it);
  }
  return Array.from(map, ([dayKey, items]) => ({ dayKey, items }));
}

// Human day header. now defaults to Date.now() (injectable for tests).
export function formatDayLabel(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today.getTime() - that.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short",
    year: that.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}
```

- [ ] **Step 4: Run, expect pass.**
- [ ] **Step 5: Commit.**

### Task 2: Activity timeline — vertical timeline render

**Files:** Modify `src/web/components/activity-timeline.tsx` (the `return` in `ActivityTimeline`, lines ~301-416).

Replace the `<Card><ul>` list with day groups + a connector line + circular nodes. Keep: filter chips block (unchanged), empty state, `metaFor`, expand-on-body, `PdfLink`/`RmaLink`/phone-jump/`AiProposalBadge`/amount/docNumber, `formatTime` for per-item time.

- [ ] **Step 1:** Build groups from `filtered` via `groupActivitiesByDay`. For each group render a day header (`formatDayLabel(group.items[0].occurredAt)`) and an `.items` container with a left connector line (`::before` via a `relative` wrapper + an absolutely-positioned 2px line) and per-item rows: a `node` (rounded-full, tone-colored border+icon, white bg so it sits over the line) + an event card. Tone→color reuses the existing `m.tone` mapping (info→accent-info, success→accent-success [highlighted card bg for payments], medium→accent-warning, neutral→slate). Preserve all per-item affordances from the current row.
- [ ] **Step 2:** `npx tsc --noEmit` clean.
- [ ] **Step 3:** Commit.

### Task 3: Extract `CustomerContextRail`

**Files:** Create `src/web/components/customer-context-rail.tsx`.

The rail renders (top→bottom): KPI mini-cards (Overdue red when >0, Balance + open-invoice count); `CustomerAiCard`; a Notes card (add-note textarea + Save via `POST /api/customers/:id/notes` reusing the NotesPanel mutation pattern, + the recent `manual_note` items passed in); `AiContextCard` wrapped in a collapsed `<details>`; a recipients/account meta card (statement recipients, phone, terms, unapplied credit, tags).

- [ ] **Step 1:** Create the component. Props: `{ customer, kpi, overdue, balance, credits, notes: Activity[], onAction }` (onAction forwarded to `CustomerAiCard`). Move the Notes mutation (from `NotesPanel`) in; reuse `CustomerAiCard`, `AiContextCard`, `TermsCard` by import. Amber-accented Notes card; collapsed AI-context `<details>`.
- [ ] **Step 2:** `tsc --noEmit` clean.
- [ ] **Step 3:** Commit.

### Task 4: Restructure `customer-detail.tsx` layout

**Files:** Modify `src/web/pages/customer-detail.tsx`.

- [ ] **Step 1:** Wrap the page body in a two-column `flex` (desktop) / stacked (mobile): `<div className="flex flex-col gap-4 md:flex-row md:items-start">` with a `md:flex-[1.85] min-w-0` main column and a `md:w-[330px] md:shrink-0` rail. Header card stays full-width above the grid.
- [ ] **Step 2:** Main column = a `Card`-less wrapper holding the existing tab `<nav>` + tab-content `<div>` (Activity/Emails/Invoices/etc.) — minus the `notes` tab. Remove `{ key: "notes", ... }` from `TABS` and the `tab === "notes"` block; delete `NotesPanel` (moved to rail) or leave it unused-but-removed.
- [ ] **Step 3:** Rail = `<CustomerContextRail customer={customer} kpi={kpi} overdue={overdue} balance={balance} credits={credits} notes={recentActivities.filter(a => a.kind === "manual_note")} onAction={handleAiCardAction} />`. Remove from the main flow: the `StatCard` strip (`<div className="grid ... md:grid-cols-6">`), `<RecipientsAndTagsSection>`, the standalone `<CustomerAiCard>` + `<AiContextCard>` (now in rail). Move the Autopilot toggle (the bare button ~459-466) into the header sub-line as a small control.
- [ ] **Step 4:** `tsc --noEmit` clean; `npx vitest run src/web/components/activity-timeline.group.test.ts` green.
- [ ] **Step 5:** Commit.

### Task 5: Verify, polish, review, ship

- [ ] **Step 1:** Make the local customer-detail page renderable: add the missing `ai_customer_context` column to the local DB (the prod schema has it; local is behind) so the real page loads. Start `dev:no-worker` with the dev bypass.
- [ ] **Step 2:** Playwright on a real customer (Bais Hasforim) at desktop width: confirm header, two-column rail (KPIs/AI/Notes/AI-context/recipients), and the timeline (day groups + nodes); add a note via the rail; resize to mobile and confirm single-column stack. Screenshot + 0 console errors from the page.
- [ ] **Step 3:** `impeccable` polish pass on the rendered page (spacing, hierarchy, color, alignment, the timeline visual) — iterate in-browser until it looks right.
- [ ] **Step 4:** Independent review subagent over the diff; fix findings.
- [ ] **Step 5:** Clean up (env bypass, servers, artifacts), `tsc` + tests green, merge to main + push, watch deploy to completion.

## Self-review

- **Spec coverage:** two-column layout + rail order (T3/T4), Notes = manual-note feed in rail (T3), AI context collapsible (T3), timeline rework (T1/T2), header tidy + autopilot toggle move + notes-tab removal (T4), mobile stack (T4), verify/polish/review (T5). ✓
- **Type consistency:** `groupActivitiesByDay`/`formatDayLabel` (T1) used in T2; `CustomerContextRail` props (T3) match the call in T4; `notes` filtered by `kind === "manual_note"` consistent with NotesPanel.
- **Risk:** `customer-detail.tsx` is huge — restructure is the main effort; rail extraction bounds it. Timeline must preserve filter/SSE/links (T2 keeps them).
