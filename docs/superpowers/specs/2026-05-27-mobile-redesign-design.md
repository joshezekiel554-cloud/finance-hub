# Mobile redesign — design spec

**Date:** 2026-05-27
**Status:** locked direction (Option A inbox-style across pages); awaiting implementation plan approval
**Branch:** `feat/mobile-redesign` (TBD at execution)
**Preview:** `scripts/mobile-preview-server.mjs` → `http://localhost:3940`

## Problem

App was built desktop-first. Below 768px the sidebar is hidden but there's no replacement — phone users lose all navigation. Desktop layouts compress poorly on phones: the Today page's ShipmentCard is a 6-section inline form built for a 1000px+ viewport, the Customers list is a wide table, Customer detail packs status strip + AI cards + KPIs + tabs vertically and never lets the operator focus on one thing. Compose modal opens as an 800px slide-over that goes off the side of a phone screen.

Result: the operator can't comfortably do mobile work, especially "send invoices on the go" which is the primary mobile workflow.

## Goal

A phone-first redesign of the four highest-leverage surfaces, keeping the desktop experience intact:

1. **Today** (`/invoicing`) — primary target. Send invoices comfortably from a phone.
2. **Customers** (`/customers`) — list view with thumb-friendly rows + bulk edit footer.
3. **Customer detail** (`/customers/:id`) — AI summary card first, KPIs, scrollable tab strip, restructured emails list.
4. **Compose modal** — full-screen on phone, slide-over on desktop. AI draft panel surfaces well.

Plus a mobile app shell: a sticky top app bar with a hamburger button that opens the existing nav as a left drawer.

## Out of scope (deferred)

- `/autopilot`, `/chase`, `/returns`, `/tasks`, `/statements`, `/ai-training` page mobile passes. These pages mostly use list patterns we'll have built by then, so future passes are cheaper.
- PWA / install to home screen / service worker / pull-to-refresh / swipe-to-action. (Level 3 per the prior conversation.)
- Tablet-specific layouts. Tablets get the desktop layout via the `md:` (≥768px) breakpoint.
- Bottom tab bar replacing the drawer. We keep the drawer pattern; bottom-tab is a Level 3 ask.
- iOS-specific safe-area handling beyond `env(safe-area-inset-bottom)` on the action bar.

## Decisions (locked)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Breakpoint at Tailwind `md` (768px).** | Phones < 768px get mobile layout; tablets + desktop get current desktop. Single split, single code path. |
| 2 | **Option A (inbox-style)** for the Today page and any list-with-detail pattern. | List on top, tap a row → full-screen detail with a sticky bottom action bar. Familiar mental model, primary action always in thumb zone. |
| 3 | **Mobile nav: hamburger + left drawer.** | Reuses existing nav items 1:1. Bottom-tab bar deferred. |
| 4 | **TanStack Router routes for "panels"** (Today detail, Email recipients, Invoice details, AI draft reply). | Native back-button works, deep-linkable (e.g. dashboard "Draft reply" already deep-links via query param). |
| 5 | **Card-of-cards anti-pattern banned.** | Where the desktop renders 5 nested cards on one page, mobile uses sectioned panels with no outer card wrapper. |
| 6 | **Tabs and filter chips: horizontal scroll, never wrap.** | Wrapping causes vertical sprawl above the fold. |
| 7 | **Compose modal full-screen on phone.** | Today opens as a fixed right-edge slide-over (`max-w-2xl`). At < 768px it becomes a full-screen route-style modal. |
| 8 | **Reconcile editor stays inline on the Today detail page** (not behind a disclosure). | It's the primary work surface — putting it behind a tap would add friction to the core workflow. Email recipients + Invoice details, both lower frequency, go behind disclosures. |
| 9 | **No new design tokens.** Reuse existing CSS variables (`--bg-*`, `--text-*`, `--accent-*`). The mobile preview confirmed they work. | Avoids drift between dark themes. |
| 10 | **Sticky bottom action bar** for any page with a primary commit action. Reusable component. | Predictable thumb-zone for Send / Save / Done. |

## Architecture

### Mobile shell

`src/web/App.tsx` becomes responsive:

- Below `md`: sidebar is hidden, a sticky top app bar replaces the desktop "Welcome back" header. App bar carries: hamburger button (opens drawer), page title (slot fed by the active route or page component), and 0–2 action icons (notification bell, user pill, page-specific actions).
- Hamburger opens a left drawer (use Radix's existing Dialog primitives or a small custom Sheet) with the same nav items as the sidebar.
- Above `md`: unchanged — keeps the current sidebar visible.

### Page-level layout primitives

Two new shared components:

- `<MobileAppBar />` — sticky top bar. Props: `title`, `back?: () => void` (renders chevron when set), `rightSlot?: ReactNode`.
- `<StickyActionBar />` — pinned to viewport bottom on mobile, only renders below `md`. Props: children. Adds `padding-bottom: calc(12px + env(safe-area-inset-bottom))`.

Existing pages keep their current desktop layout; mobile-specific layout branches inside the page component via `<div className="md:hidden">` / `<div className="hidden md:block">` blocks where the difference is structural.

### Today page

`src/web/pages/invoicing-today.tsx` splits into:

- **List path** (current page, mobile-restyled): compact row-cards instead of full inline forms. Tab chips become horizontal scrollable strip. Summary stacks vertically.
- **Detail path** (new route `/invoicing/$gmailId`): full-screen view with the editing logic from the desktop `<ShipmentCard>` extracted into a hook + a mobile-shaped component. Reconcile editor + line items + disclosure rows for Email/Invoice details + total + sticky action bar.
- Two sub-routes for the disclosure-row panels: `/invoicing/$gmailId/email` and `/invoicing/$gmailId/invoice-details`. Each is a full-screen form with Save / Cancel sticky action bar.

Desktop continues to render the existing inline ShipmentCard.

### Customers page

`src/web/pages/customers.tsx`:

- Below `md`: row-card per customer with name + total + pills (CRITICAL/HIGH tier, HOLD, autopilot-off, B2B/B2C). Tap → customer detail.
- Search input above the chip filter row (search currently lives in a header position — move to its own sticky row on mobile).
- Bulk-edit mode: same selection model, but the action toolbar becomes a `<StickyActionBar>` at the bottom carrying the three most-used actions (Autopilot Off, Autopilot On, Tag…). Less-used actions go behind a "…" menu.

Above `md`: existing table layout untouched.

### Customer detail page

`src/web/pages/customer-detail.tsx`:

- Status strip (hold/autopilot/B2B/terms pills): horizontal scroll on mobile, wrap on desktop.
- AI summary card: same component (`<CustomerAiCard>` — already mobile-friendly per the preview), no change.
- AiContextCard: stays where it is (lower priority on mobile, can be collapsed in a later polish pass).
- KPI grid: 2-column on mobile, 4-column on desktop. Reuse a new compact `<Kpi>` component.
- Tab strip: horizontal scrollable on mobile, current row layout on desktop.
- Email tab: card-list with `<EmailRow>` (already similar to the preview); the existing `<EmailList>` component takes a `compact` prop, branches on it.

### Compose modal

`src/web/components/compose-modal.tsx`:

- Below `md`: full-screen — strip the slide-over framing, occupy 100vw / 100vh, sticky save action bar at bottom, back chevron in the top app bar.
- Above `md`: current slide-over layout untouched.
- AI draft panel (current implementation) re-styles for the new form layout — same logic, looser padding on mobile.

### Viewport + meta

`index.html` (or wherever the root HTML is): add `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` if missing. Required for `env(safe-area-inset-bottom)` and to prevent iOS Safari zoom on form-input focus.

## Testing

- Unit tests on extracted hooks (`useShipmentCardLogic`, etc.) — same logic, no behavior change.
- Existing route tests stay green (no API changes).
- Manual smoke: each of Today / Customers / Customer detail at 390px wide via DevTools, plus on at least one real iOS Safari and one Android Chrome session.
- Visual regression risk on desktop: each refactored page (especially Today) must still render the desktop layout identically. Take before/after screenshots at 1440×900.

## Risks

1. **Reconcile editor extraction.** The Today detail page extracts ~400 lines of state + handlers out of `<ShipmentCard>`. Risk of a subtle regression on the desktop send path. Mitigation: extract to a hook, leave the desktop component using it unchanged; build the mobile version on top.
2. **TanStack Router schema changes.** Two new routes (`/invoicing/$gmailId`, plus nested panels). Search schema for `/invoicing` is unchanged.
3. **iOS zoom on focus** of fields with `font-size < 16px`. We use 0.92rem (~14.7px) inputs. Need to bump to `font-size: 16px` on mobile inputs OR add the viewport `maximum-scale=1` (latter hurts accessibility — prefer the former).
4. **`env(safe-area-inset-bottom)` requires viewport-fit=cover.** If we add it without testing on iOS, content can sit under the home indicator.
5. **Drawer overlay z-index conflicts** with the existing `<ComposeModal>` slide-over (z-index 50). Need to coordinate stacking.

## Phasing

- Phase 1 — Mobile shell (app bar + hamburger drawer + viewport meta + StickyActionBar component) — ~3h.
- Phase 2 — Today list-view mobile rewrite — ~2h.
- Phase 3 — Today detail route + email/invoice panels (extract shipment-card logic) — ~6h (biggest).
- Phase 4 — Customers list + bulk-edit mobile — ~2h.
- Phase 5 — Customer detail mobile (KPI grid + tab strip + email rows) — ~3h.
- Phase 6 — Compose modal full-screen on mobile — ~2h.
- Phase 7 — Verify pass: typecheck/tests/build + manual smoke on real devices + before/after desktop screenshots — ~2h.

**Total: ~20h.** Matches the Level 2 estimate.

## Open follow-ups (post-merge)

- Pages not covered (`/autopilot`, `/chase`, `/returns`, `/tasks`, `/statements`, `/ai-training`) — apply the same row-card + drawer patterns.
- Bottom tab bar variant of the drawer for the most-used 4 destinations.
- PWA manifest + service worker + install-to-home.
- Pull-to-refresh on list pages.
- Swipe-to-actioned on the Emails tab + dashboard Emails widget.
