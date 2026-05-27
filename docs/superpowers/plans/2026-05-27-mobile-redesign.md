# Mobile redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Phone-first redesign of Today / Customers / Customer detail / Compose modal, plus a mobile app shell. Desktop layouts untouched.

**Architecture:** Single codebase, single breakpoint at Tailwind `md` (768px). Mobile shell adds a top app bar + left drawer below `md`. Pages branch internally with `md:hidden` / `hidden md:block`. Today's biggest change: list-vs-detail split via new TanStack Router routes (`/invoicing/$gmailId`, `/invoicing/$gmailId/email`, `/invoicing/$gmailId/invoice-details`) on top of extracted shipment-editing state hooks. Reuse existing CSS variables — no new design tokens.

**Tech Stack:** Tailwind v4, React 18, TanStack Router, TypeScript strict, existing UI primitives (Radix Dialog).

**Spec:** `docs/superpowers/specs/2026-05-27-mobile-redesign-design.md`
**Preview:** `scripts/mobile-preview-server.mjs` (running on :3940 — the design source of truth).

---

## Phase 1 — Mobile shell

### Task 1.1: Viewport meta + iOS input zoom prevention

**Files:**
- Modify: `index.html` (root, or wherever Vite's HTML entry lives)
- Modify: `src/web/index.css` (or tailwind base)

- [ ] Confirm the `<meta name="viewport">` tag includes `viewport-fit=cover`. Add if missing: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`.
- [ ] Add a global mobile-only rule so iOS Safari doesn't auto-zoom on focus of form inputs (anything below 16px triggers zoom). In `index.css` global layer:
  ```css
  @media (max-width: 767px) {
    input, select, textarea {
      font-size: 16px;
    }
  }
  ```
- [ ] Smoke: open Chrome DevTools at 390×844, tap a form input — viewport doesn't zoom. Bigger touch targets confirmed visually.

### Task 1.2: `<MobileAppBar />` + `<StickyActionBar />` primitives

**Files:**
- Create: `src/web/components/mobile-app-bar.tsx`
- Create: `src/web/components/sticky-action-bar.tsx`

- [ ] `MobileAppBar`: sticky top bar, only renders below `md`. Props: `title: string`, `back?: () => void`, `rightSlot?: ReactNode`. Reuse colors from the preview server (matches the existing dark theme). Height 56px, padding 14px sides, single-line truncation on title.
- [ ] `StickyActionBar`: fixed bottom on mobile, hidden on desktop. Children = button(s). Add `padding-bottom: calc(12px + env(safe-area-inset-bottom))`. Subtle backdrop-blur backdrop (the only legitimate glassmorphism — it's covering content that scrolls beneath).
- [ ] Both components export from `src/web/components/index.ts` if that pattern exists; otherwise import from path.
- [ ] Snapshot-test the components if there's a snapshot pattern; otherwise visual confirmation.

### Task 1.3: Mobile drawer nav

**Files:**
- Modify: `src/web/App.tsx`
- Create: `src/web/components/mobile-nav-drawer.tsx`

- [ ] Build `MobileNavDrawer`: Radix Dialog used as a left-aligned sheet (use `data-side="left"` styling). Renders the same `navItems` array currently in `App.tsx`. Clicking a nav item closes the drawer (auto via Link click + onOpenChange).
- [ ] In `App.tsx`:
  - Wrap the layout: above `md` shows the existing sidebar. Below `md` hides the sidebar (currently `hidden md:flex` — keep) and shows a sticky `MobileAppBar` with hamburger as the left slot opening the drawer.
  - The current desktop top header (the "Welcome back" / notification bell / user pill bar) stays as-is above `md`, hides below.
  - The mobile app bar's `title` defaults to the active route's pretty name — but to keep the shell uncoupled from per-page state, default to the matched nav-item label and let pages override later via context if needed (deferred — for now app bar just shows "Finance Hub" or the nav label).
  - NotificationBell + UserPill move into the mobile app bar's `rightSlot` on phone, stay in the desktop header on `md+`.
- [ ] Manual: open the app at 390px wide. Sidebar hidden. Tap hamburger → drawer slides in. Tap a nav item → navigates + drawer closes. Tap overlay → drawer closes.

### Task 1.4: Commit Phase 1

- [ ] Typecheck clean, dev server runs, all existing tests pass.
- [ ] Commit: `feat(web): mobile shell — app bar, hamburger drawer, sticky action bar primitive`.

---

## Phase 2 — Today list view (mobile)

### Task 2.1: Compact `<ShipmentRowMobile />` component

**Files:**
- Create: `src/web/components/invoicing/shipment-row-mobile.tsx`
- Modify: `src/web/pages/invoicing-today.tsx`

- [ ] Component renders a row-card: PO → customer name, total, status pill (Ready / N needs price / Sales receipt), invoice # · carrier. Tap → `navigate({ to: '/invoicing/$gmailId', params: { gmailId } })`.
- [ ] Reuse layout pattern from the preview — match visual exactly. Reuse classes from existing dashboard widget rows as far as possible.
- [ ] Below `md`, the list section renders these rows. Above `md`, the existing `<ShipmentCard>` continues to render inline.

### Task 2.2: Today list page mobile branching

**Files:**
- Modify: `src/web/pages/invoicing-today.tsx`

- [ ] Header: above `md`, current "Today" title + LIVE badge + Refresh button row. Below `md`, the title + LIVE badge live in the `MobileAppBar` (page provides the title); the Refresh icon goes in the app bar's rightSlot.
  - This requires the app bar to be page-overridable. Add a small `MobileAppBarContext` (or pass via a wrapper layout component). Simpler approach: page renders its own `MobileAppBar` at the top of its return (only `md:hidden`), letting `App.tsx`'s default app bar hide when a page renders its own. Avoids context plumbing.
- [ ] Summary cards: stack vertically below `md` (already does — confirm). The current `grid-cols-1 md:grid-cols-3` is correct.
- [ ] TabToggle (Open/Unparseable/Sent/Dismissed/Phone calls): below `md` becomes the horizontal-scroll chip strip from the preview. Above `md` keeps current segmented look.
- [ ] Section "Orders" header: hidden below `md` (the chip strip is sufficient orientation). Section "Returns received" header: kept, with reduced subtitle text on mobile.
- [ ] Below `md`, the `.map((row) => <ShipmentCard …>)` becomes `.map((row) => <ShipmentRowMobile …>)`. The full inline ShipmentCard rendering stays above `md`.

### Task 2.3: Commit Phase 2

- [ ] Commit: `feat(invoicing): mobile list view for Today page`.

---

## Phase 3 — Today detail route + panels (biggest task)

### Task 3.1: Extract shipment-editing logic into a hook

**Files:**
- Create: `src/web/lib/use-shipment-editor.ts`
- Modify: `src/web/pages/invoicing-today.tsx` (refactor `<ShipmentCard>` to consume the hook)

- [ ] Pull the state (`editedActions`, `discountPercent`, `selectedTermId`, `customerMemo`, `docNumberSuffix`, `billEmailTo`, `billEmailCc`, `billEmailBcc`, `emailExpanded`, `txnDate`, `sendResult`) + handlers (`updateLineQty`, `updateAddPrice`, `updateAddQty`, `addQbItemLine`, `removeAddLine`, `updateLinePrice`) + the `sendMutation` / `dismissMutation` / `restoreMutation` definitions into a hook `useShipmentEditor(row, terms, queryClient)`. Returns `{state, handlers, mutations, derived}`.
- [ ] `<ShipmentCard>` now calls the hook and lays out the JSX as before. Behavior unchanged on desktop.
- [ ] Run typecheck + existing tests; manual sanity-check a send flow in dev.

### Task 3.2: Detail page route + scaffolding

**Files:**
- Modify: TanStack Router route tree (where routes are registered — likely `src/web/main.tsx` or a routes file)
- Create: `src/web/pages/invoicing-today-detail.tsx`

- [ ] Register `/invoicing/$gmailId` as a child route under `/invoicing` (or a sibling — match the existing routing pattern). The page receives `gmailId` from path params.
- [ ] On the detail page, fetch the same `/api/invoicing/today` payload, find the row matching `gmailId`. (Could later optimize with a single-row endpoint, but reuse the existing list endpoint for v1.)
- [ ] If the row is missing (already sent / dismissed / never existed), render a friendly empty state with "Back to Today" button.

### Task 3.3: Build the mobile detail page (Option A detail screen)

**Files:**
- Modify: `src/web/pages/invoicing-today-detail.tsx`

- [ ] Above `md`, redirect to `/invoicing` (the desktop never needs the dedicated detail page — desktop continues to use inline expansion). Use `useNavigate` in a `useEffect` checking `window.matchMedia('(min-width: 768px)')`.
- [ ] Below `md`, render: `MobileAppBar` with title = `"PO-{po} → {customer}"`, back action goes to `/invoicing`. Body sections:
  1. **Shipment** panel (read-only): tracking, carrier, ship date.
  2. **Line items** panel (editable): the reconcile editor, mobile-styled per the preview. Reuse the existing line-handling logic via `useShipmentEditor`. Render as the vertical list-of-lines from the preview; price-needed lines highlight warning yellow.
  3. **Add a line** picker: same `<AddLinePicker>` from the desktop, no changes needed.
  4. **Disclosure row: Email recipients** → links to `/invoicing/$gmailId/email`. Right-side preview shows the current "to" address (truncated).
  5. **Disclosure row: Invoice details** → links to `/invoicing/$gmailId/invoice-details`. Right-side preview: `"Net 30 · today"` or whatever the current settings show.
  6. **Total** row: clear, bold.
- [ ] Sticky action bar at the bottom: `[Dismiss]` (ghost) + `[Send to QBO →]` (primary). Both call into the hook's mutations.
- [ ] Send-success state: after a successful send, swap the body for the success panel from the preview (banner + "what happened" panel + "Open invoice in QBO" + "Open sent email in Gmail" disclosure rows). Action bar collapses to a single "Done" primary button → back to list.
- [ ] Send-failure: result-banner.error at the top of the body, action bar stays available.

### Task 3.4: Email recipients sub-route

**Files:**
- Create: `src/web/pages/invoicing-today-detail-email.tsx`
- Register route `/invoicing/$gmailId/email`.

- [ ] Below `md`: full-screen form with three fields (To / Cc / Bcc), styled per the preview. Saves write into the same hook's state — actually, since this is a separate page, state needs to live somewhere that survives navigation. Options:
  - (a) Lift state into a Zustand store keyed by `gmailId`.
  - (b) Mount the editing state at the route layout level (TanStack Router parent route).
  - **Choice:** (b) — register `/invoicing/$gmailId` as a layout route whose component renders `<Outlet />`. The shipment-editor state lives there; child routes (detail body, email panel, invoice-details panel) read/write via React context.
- [ ] Action bar: `[Cancel]` (ghost, back to detail) + `[Save]` (primary, persists to the editor state, back to detail).
- [ ] Above `md`: redirect to `/invoicing` (desktop never lands here).

### Task 3.5: Invoice details sub-route

**Files:**
- Create: `src/web/pages/invoicing-today-detail-invoice.tsx`
- Register route `/invoicing/$gmailId/invoice-details`.

- [ ] Mirror Task 3.4: full-screen form with Terms / Discount / Memo / DocNumber suffix / Issue date / Preview-in-QBO. Save returns to detail.

### Task 3.6: Phase 3 verify + commit

- [ ] Run typecheck + tests. Manual smoke: phone-sized DevTools, walk through list → detail → email panel → invoice details → send.
- [ ] Commits per sub-task (3.1, 3.2+3.3 together, 3.4, 3.5).

---

## Phase 4 — Customers list + bulk edit (mobile)

### Task 4.1: Mobile branching in customers.tsx

**Files:**
- Modify: `src/web/pages/customers.tsx`

- [ ] Above `md`: existing table layout untouched.
- [ ] Below `md`:
  - `MobileAppBar` with title "Customers" + rightSlot = + (new customer) and ⋯ (bulk-edit toggle) icon buttons.
  - Search input as a separate sticky row below the app bar (currently in header).
  - Filter chips become horizontal scrollable row (mirrors the preview).
  - Customer rows: row-card per customer with name + total + at-a-glance pills. Tap → customer detail.
- [ ] Sort dropdown: keep on desktop; on mobile move into a small bottom-sheet behind a "Sort" chip (placeholder this in a follow-up if it adds scope; for v1, sort defaults to current default + a small select in the chip row).

### Task 4.2: Bulk-edit action bar

**Files:**
- Modify: `src/web/pages/customers.tsx` (where the existing sweep-mode bar lives)

- [ ] Wrap the existing sweep-mode bar in a `<StickyActionBar>` below `md` (so it pins to the bottom of the viewport). Above `md` it keeps current placement.
- [ ] The mobile bar shows the most-used three actions (Autopilot Off, Autopilot On, Tag…) directly. The less-used ones go behind a "…" overflow menu (Radix DropdownMenu).
- [ ] Each row shows a 22×22 checkbox at the left when sweep mode is on (matches the preview).

### Task 4.3: Commit Phase 4

- [ ] Commit: `feat(customers): mobile list + bulk-edit action bar`.

---

## Phase 5 — Customer detail (mobile)

### Task 5.1: Status strip + KPI grid

**Files:**
- Modify: `src/web/pages/customer-detail.tsx`

- [ ] Status strip (hold + autopilot + B2B + terms pills): below `md`, render as a horizontal scrollable strip. Above `md`, keep current wrap layout.
- [ ] KPI grid: below `md`, 2-column grid (open balance / overdue / unapplied credit / days since payment). Above `md`, unchanged.
- [ ] Mobile app bar with title = customer.displayName (truncate to ~24 chars), back chevron returns to `/customers`, rightSlot has the sync customer button.

### Task 5.2: Tab strip + emails tab mobile

**Files:**
- Modify: `src/web/pages/customer-detail.tsx`
- Modify: `src/web/components/email-list.tsx` (add `compact` prop)

- [ ] Tab row below `md`: horizontal scrollable strip with the existing tab buttons. Above `md`, current layout.
- [ ] EmailList component grows an optional `compact={true}` prop. When set, each email row uses the new email-row design from the preview (inbound/outbound icon + from + time + subject + preview + unactioned dot). The expanded action bar collapses into inline AI Draft reply chip + Mark actioned chip per row. The action mutations and selection logic are unchanged.
- [ ] customer-detail.tsx passes `compact` to EmailList below `md`.

### Task 5.3: Commit Phase 5

- [ ] Commit: `feat(customers): mobile customer detail page`.

---

## Phase 6 — Compose modal full-screen on mobile

### Task 6.1: Full-screen styling below md

**Files:**
- Modify: `src/web/components/compose-modal.tsx`

- [ ] The slide-over container currently has `max-w-2xl` + `right-0 top-0 h-full w-full`. Update the classes so below `md` it becomes `inset-0 max-w-none w-full h-full`. Above `md`, unchanged.
- [ ] The action footer (Cancel/Send buttons) on mobile becomes a `<StickyActionBar>` (already pinned to bottom but with safe-area padding). The signature picker collapses into a smaller chip-style trigger on mobile so the footer fits.
- [ ] The TipTap editor body grows to fill available vertical space.
- [ ] The AI panel (when `draftReplyForEmailLogId` is set) renders at the top of the form, full-width, matching the preview's panel style.

### Task 6.2: Commit Phase 6

- [ ] Commit: `feat(web): compose modal full-screen on mobile`.

---

## Phase 7 — Verify + ship

### Task 7.1: Full verification

- [ ] `npx tsc -p tsconfig.json --noEmit` clean.
- [ ] `npx vitest run` — full suite, no new regressions.
- [ ] `npm run build` clean.
- [ ] Desktop visual regression: each refactored page at 1440×900 — confirm pixel-identical or near-identical to pre-change main. Take before/after screenshots if anything's ambiguous.
- [ ] Mobile manual smoke at 390×844 via DevTools:
  - App bar + hamburger drawer.
  - Today list → detail → email panel → invoice details panel → send.
  - Customers list → tap a row → customer detail.
  - Customer detail → emails tab → tap "Draft reply" → compose with AI panel.
  - Bulk-edit toggle on customers.
- [ ] On a real device if possible (operator's iPhone + Safari): repeat the above. Particularly check safe-area + input zoom.

### Task 7.2: Commit + PR

- [ ] Push branch.
- [ ] Open PR with summary + test plan.

---

## Self-review checklist

- Every spec decision (1–10) has a task implementing it.
- No placeholders left.
- Routes registered match the spec.
- Desktop layout untouched (verified by Task 7.1 visual regression step).
- Compose modal AI panel still works for the existing dashboard "Draft reply" deep-link.
- StickyActionBar uses safe-area inset, not a hardcoded bottom padding.
