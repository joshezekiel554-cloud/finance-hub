# Mobile redesign — live progress

**Branch:** `feat/mobile-redesign`
**Started:** 2026-05-27
**Spec:** `docs/superpowers/specs/2026-05-27-mobile-redesign-design.md`
**Plan:** `docs/superpowers/plans/2026-05-27-mobile-redesign.md`
**Preview:** http://localhost:3940 (design reference)
**Tracker:** http://localhost:3939 (this page, live)

## Status: Phases 1+2+3 complete · dispatching Phase 4+5+6 in parallel

## Phase 1 — Mobile shell ✓

- [x] **Task 1.1** — Viewport meta + iOS input-zoom prevention
- [x] **Task 1.2** — `<MobileAppBar />` + `<StickyActionBar />` primitives
- [x] **Task 1.3** — Mobile drawer nav (hamburger + left drawer in App.tsx)
- [x] **Task 1.4** — Commit Phase 1

## Phase 2 — Today list view ✓

- [x] **Task 2.1** — `<ShipmentRowMobile />` component
- [x] **Task 2.2** — Today list page mobile branching
- [x] **Task 2.3** — Commit Phase 2

## Phase 3 — Today detail route + panels ✓

- [x] **Decision:** parallel implementation (mobile detail page) rather than extracting a shared hook from the desktop ShipmentCard. Documented in commit. Lower regression risk on the desktop send path.
- [x] **Tasks 3.1–3.5 done** — `/invoicing/$gmailId` route + full-screen detail page with line-item editor, Email recipients overlay, Invoice details overlay, Dismiss overlay, send/dismiss/restore mutations, success + error banners.
- [x] **Task 3.6** — 589/589 tests pass; build clean; typecheck clean.

## Phase 4 — Customers list + bulk-edit mobile ✓

- [x] **Task 4.1** — Mobile branching in customers.tsx (CustomerRowMobile + md:hidden list, desktop table preserved behind hidden md:block)
- [x] **Task 4.2** — Bulk-edit sticky action bar (count + Autopilot Off/On + Tag prompt)
- [x] **Task 4.3** — Committed

## Phase 5 — Customer detail mobile ✓

- [x] **Status strip + KPI grid** — already responsive (flex-wrap + grid-cols-2 sm:grid-cols-3 md:grid-cols-6). No change.
- [x] **Tab strip** — horizontal scrollable with -mx-4/px-4 bleed. Always-visible whitespace-nowrap.
- [x] **h1** — text-xl on mobile, text-2xl on md+.
- [x] **EmailList compact prop** — deferred. Existing list works on mobile due to flex-wrap; revisit if operator feedback suggests otherwise.
- [x] **Committed.**

## Phase 6 — Compose modal full-screen mobile ✓

- [x] **Task 6.1** — DialogContent inset-0/no-border/no-max-width on mobile; md:right-edge slide-over preserved.
- [x] **Task 6.2** — Footer with safe-area-inset-bottom + backdrop-blur. Committed.

## Phase 7 — Verify + ship

- [ ] **Task 7.1** — Full verification (typecheck, tests, build, manual smoke)
- [ ] **Task 7.2** — Push + open PR

---

## Recent commits

_(populated as work lands)_

## Decisions in flight

_(populated as decisions arise)_
