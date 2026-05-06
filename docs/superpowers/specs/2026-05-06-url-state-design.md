# URL State + Scroll Restoration — Design Spec

**Date:** 2026-05-06
**Status:** Approved, ready for implementation plan
**Scope:** Path 2 — URL state + scroll restoration only. Modal-in-URL and form-draft persistence deferred to separate projects after the AI agent ships.

---

## Problem

When a user filters a list (e.g., Customers), clicks into a detail page, and hits the browser back button, the list resets to defaults. All filter state lives in `useState` inside list components, so the component remounts on back-navigation with no memory of what was set. Same problem on every list page in the app and on customer-detail's internal tabs.

## Goal

Browser back button restores "exactly where I was" on any list page in the app: filters, search, sort, tab, pagination, and scroll position. Filters also persist across sessions (per-user) so clicking a nav link returns to the user's last-used filter set.

**Out of scope (Path 2):**
- Modal-in-URL (deep-linkable / back-button-closeable dialogs)
- Form-draft persistence (autosave for in-progress forms)
- Multi-select / sweep mode state
- Open dropdowns, hover, inline-edit state

These are additive on top of this design and can be layered in later without rework.

## Approach

Selected approach: **TanStack Router native + tiny shared helper (Approach C).**

Per-route Zod `validateSearch` schema for type safety + URL hygiene. One shared `useFilterNavigate` helper to wrap the merge-and-navigate dance with sensible push-vs-replace defaults. Per-user persistence to `localStorage` via a `beforeLoad` redirect that runs only when the URL is empty. TanStack Router's `<ScrollRestoration />` mounted once at the root for app-wide scroll restoration.

Rejected alternatives:
- **A. Direct, no abstraction** — too much per-page boilerplate (merge-prev navigate repeated ~14 times).
- **B. Custom `useFilterState` hook** — hides too much (push/replace semantics, selection-reset on filter change become invisible). Reviewers and AI agents have to learn a project-specific abstraction.

## Architecture

### Single source of truth: the URL

All filter / search / sort / tab / pagination state lives in URL search params. Each route declares a Zod schema via `validateSearch`. The schema uses `.catch(default)` on every field so invalid or missing params fall back silently — bookmarks and stale URLs never crash the page.

### Persistence layer

`localStorage`, keyed by `${userId}:${routePath}` so users sharing a browser don't pollute each other. Storage holds only the most recent search-param object for that route.

### Redirect-on-empty (the "sticky filters" behavior)

Each list route's `beforeLoad` runs the `restoreSearchOnEmpty(routePath)` helper:

- If URL has search params → no-op. URL wins (back button, bookmark, shared link).
- If URL is empty AND storage has saved state → `throw redirect({ search: stored, replace: true })`.

The redirect happens before the component mounts, so there's no visible flicker and history is not polluted (`replace: true`).

### Storage write

A `useFilterPersistence(routePath)` hook mounted in each list page subscribes to `useSearch()` and debounce-writes to `localStorage` 200ms after change. No-op if logged out.

### Scroll restoration

`<ScrollRestoration />` mounted once at the root. TanStack Router's built-in implementation saves scroll per history entry, so back-from-detail puts you at the exact pixel offset. Nav-click → fresh redirect URL → scroll 0 (matches "I just clicked the nav" expectation).

### Net behavior

- Filter list → click row → back: land filtered, scrolled to where you were.
- Click nav while away: arrive on last filtered state.
- Bookmark `/customers?tab=b2b`: opens to that state.
- Open `/customers` cleanly in a new tab: redirects to your last state.

## Helpers

Three small modules in `src/web/lib/`:

### `useFilterNavigate(routeId)`

Write side. Wraps merge-prev-and-navigate.

```ts
const { setFilter, setFilters, resetFilters } = useFilterNavigate("/customers");

setFilter("search", "ezekiel");                      // replace=true (text input default)
setFilter("tab", "b2b", { history: "push" });        // push=true (toggles, pagination)
setFilters({ tab: "house", page: 1 });               // batch update
resetFilters();                                      // back to schema defaults
```

Default `history: "replace"` means typing in a search box does not pollute browser history.

### `useFilterPersistence(routePath)`

Storage side. Mounted once per list page.

```ts
useFilterPersistence("/customers");
```

Reads current `useSearch()`, debounce-writes to `localStorage["finance-hub:filters:${userId}:${routePath}"]` 200ms after change.

### `restoreSearchOnEmpty(routePath)`

Used in each route's `beforeLoad`.

```ts
beforeLoad: restoreSearchOnEmpty("/customers"),
```

Logic: if URL has search params → no-op. If URL is empty AND storage has saved state → `throw redirect({ search: stored, replace: true })`.

### Root setup

Mount once in `App.tsx`:

```tsx
<ScrollRestoration />
```

## Conversion checklist

| Page | URL params | Stays as `useState` |
|---|---|---|
| `customers.tsx` | tab, search, sort, dir, hideZero, hasOverdue, onHold, missingTerms, hasUnactionedEmail | sweepMode, selectedIds, shopifyTag, shopifyPreview |
| `returns.tsx` | view (kanban/list), status, type, customerId, search, sort, dir | dialog state |
| `tasks.tsx` | status, search, assignee, sort, dir | drawer/dialog state |
| `invoicing-today.tsx` | filter chips, search | dialog stack |
| `chase.tsx` | filters, sort, dir | dialog state |
| `statements.tsx` | filters, sort | send dialog |
| `seasons.tsx` | filters | edit dialog |
| `shopify-b2b-audit.tsx` | filters | preview state |
| `customer-detail.tsx` | tab + per-tab namespaced (`inv*`, `tasks*`, `email*`) | all dialogs, drafts, edit-mode flags |

Approximately 50-60 `useState` calls migrate to URL state across the app. The other ~40+ stay as transient UI state.

## Customer-detail tab handling

Search params with namespace prefixes, not sub-routes. Single route, single schema, additive change.

```ts
const customerDetailSearch = z.object({
  tab: z.enum(["activity","emails","invoices","orders","tasks","notes","returns"]).catch("activity"),
  // Invoices tab
  invStatus: z.enum(["all","open","paid","overdue"]).catch("all"),
  invType: z.enum(["all","invoice","credit"]).catch("all"),
  invSearch: z.string().catch(""),
  invSort: z.enum(["issueDate","amount","docNumber"]).catch("issueDate"),
  invDir: z.enum(["asc","desc"]).catch("desc"),
  // Tasks tab
  tasksStatus: z.string().catch("open"),
  tasksQ: z.string().catch(""),
  // Other tabs as needed
});
```

Switching tabs preserves the other tabs' filter state in the URL — switching back to Invoices brings you to your prior filter state on Invoices.

Sub-routes (`/customers/$id/tasks`, etc.) were rejected as the diff would be much larger (split component, refactor internal links, break existing bookmarks).

## Edge cases

### Search input debouncing

Text inputs (search, free-text filters) use `setFilter("search", value)` with default `replace: true` and the storage write is debounced 200ms. Per-keystroke history pollution is the main concern; replace-mode prevents it.

### Stale storage after schema change

Zod `.catch(default)` on every field means a stored object missing a newly-added field falls back to default rather than crashing. A stored object with a removed field is also fine — Zod strips unknown keys with `.parse`.

### "Reset filters" button

The `resetFilters()` helper navigates to the route with empty search. The `beforeLoad` redirect would then re-fill from storage — to actually reset, also clear the storage entry:

```ts
function resetAndClearStorage(routePath: string, userId: string) {
  localStorage.removeItem(`finance-hub:filters:${userId}:${routePath}`);
  // then navigate
}
```

This will be exposed as a `clearFilterStorage(routePath)` helper alongside `useFilterPersistence`.

### TanStack Query queryKey

The `useSearch()` object IS the queryKey input — destructure it the same way the existing `useState` values are destructured. No queryKey changes needed beyond renaming the source.

### Auto-flip behaviors (e.g., `hideZero` on tab change)

Currently expressed as `useEffect(() => setHideZero(...), [tab])`. Becomes an explicit batch update in the setter:

```ts
const setTab = (next) => setFilters({ tab: next, hideZero: next === "b2b" }, { history: "push" });
```

Cleaner — no render-bouncing effect, no surprise mutation on URL load.

### ScrollRestoration with TanStack Query refetch

When navigating back to a list, TanStack Query may show cached data immediately (instant) or refetch (loading state). ScrollRestoration restores scroll on initial paint regardless. If the data height changes after refetch, scroll position may shift slightly — acceptable trade-off; tuning is possible later if it becomes a real complaint.

### Logged-out / no userId

`useFilterPersistence` and `restoreSearchOnEmpty` both no-op when there's no current user. URL state still works; persistence just isn't engaged.

## File structure

New files:
- `src/web/lib/use-filter-navigate.ts`
- `src/web/lib/use-filter-persistence.ts`
- `src/web/lib/restore-search-on-empty.ts`
- `src/web/lib/search-schemas/customers.ts`
- `src/web/lib/search-schemas/returns.ts`
- `src/web/lib/search-schemas/tasks.ts`
- `src/web/lib/search-schemas/invoicing-today.ts`
- `src/web/lib/search-schemas/chase.ts`
- `src/web/lib/search-schemas/statements.ts`
- `src/web/lib/search-schemas/seasons.ts`
- `src/web/lib/search-schemas/shopify-b2b-audit.ts`
- `src/web/lib/search-schemas/customer-detail.ts`

Modified files:
- `src/web/App.tsx` — add `<ScrollRestoration />`
- `src/web/main.tsx` — add `validateSearch` + `beforeLoad` to each route
- Each list page (9) — swap `useState` for `useSearch` + `setFilter`, mount `useFilterPersistence`
- `src/web/pages/customer-detail.tsx` — swap tab + per-tab filters

## Rollout order

The implementation plan should sequence as:

1. Foundation: helpers + ScrollRestoration setup (no behavior change yet).
2. Customers page (canonical example, validates the pattern end-to-end).
3. Remaining list pages (parallelizable across subagents).
4. Customer-detail tabs (most complex due to namespaced sub-tab params).

Each phase is independently shippable. Foundation phase alone has no user-visible effect; the rest layer in real value page-by-page.

## Future extensibility

Both deferred Path 1 features add cleanly on top of this foundation:

**Modal-in-URL** — additive Zod field per route (`dialog?: z.enum(...)`), `setFilter("dialog", "add-item")` to open. ~20-50 lines per modal converted. Mostly mechanical.

**Form-draft persistence** — independent feature reusing the storage helper pattern but keyed by form ID rather than route path. ~50-100 lines per form. Doesn't touch URL-state code.

The `useFilterNavigate` helper's merge-with-prev semantics generalize to modal state. The persistence helper's debounced-write pattern reuses for form drafts. No painful retrofits.

---

## Implementation handoff

Next: invoke `superpowers:writing-plans` skill to break this design into a task-by-task implementation plan suitable for subagent-driven execution.
