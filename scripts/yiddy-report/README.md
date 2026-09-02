# Yiddy roster sales report — regenerate & iterate

Interactive standalone-HTML sales report over every `yiddy`-tagged
customer, for salesman Yiddy. Spec:
`docs/superpowers/specs/2026-09-01-yiddy-roster-sales-report-design.md`.
First shipped 2026-09-01.

## Pipeline

```
gather (ON VPS, read-only)  →  scripts/yiddy-report-out/gathered.json
compute (local, pure)       →  report-data.json + notes-input.json
render (local)              →  yiddy-roster-report-YYYY-MM.html
```

All working data lives in `scripts/yiddy-report-out/` — **gitignored,
contains customer data, never commit it**.

## Regenerate (fresh numbers)

```bash
# 1. Gather on the VPS (dist-only box, hence the sed rewrite).
#    Set GEN_DATE to today; all windows (TTM, prior year, season) key off it.
scp scripts/yiddy-report-gather.ts finance-vps:finance-hub/scripts/
ssh finance-vps "cd finance-hub && sed 's|\.\./src/|../dist/|g' scripts/yiddy-report-gather.ts > scripts/.tmp-yg.ts && GEN_DATE=2026-09-01 npx dotenv-cli -e .env.production -- npx tsx scripts/.tmp-yg.ts > /tmp/yg.json && rm scripts/.tmp-yg.ts scripts/yiddy-report-gather.ts"
scp finance-vps:/tmp/yg.json scripts/yiddy-report-out/gathered.json
ssh finance-vps "rm /tmp/yg.json"

# 2. Compute + render
npx tsx scripts/yiddy-report/compute.ts --gen-date 2026-09-01
npx tsx scripts/yiddy-report/render.ts
```

Sanity-check stderr from gather: roster ≈ 119, sales receipts > 0,
shopify tagged skus > 0. Then spot-reconcile one store's TTM
spend/count against prod SQL before handing anything over.

### Sanitized notes (required review gate)

`compute` writes `notes-input.json` (raw internal notes — sensitive).
Claude drafts one neutral sentence per relevant store into
`notes-reviewed.json` (`{ [storeId]: sentence }`); **Josh approves
before the final render goes out**. The 2026-09-01 approved set is in
`scripts/yiddy-report-out/notes-reviewed.json` — reuse/extend it, but
re-review whenever notes-input changes. `render` bakes it in
automatically when present.

## Iterating on the look/behaviour

Edit `scripts/yiddy-report/template.html` (committed), re-run
`render.ts`, verify in a browser (file:// is blocked in the MCP
browser — serve `scripts/yiddy-report-out/` on localhost). Data shape
is `ReportData` in `types.ts`; metric logic in `metrics.ts` has tests:
`npx vitest run scripts/yiddy-report/metrics.test.ts`.

Josh's private review artifact (republish by URL to keep the link):
`https://claude.ai/code/artifact/dcc2e1ad-9a53-46b5-8f33-b093623fd996`
— strip the `<!doctype>/<html>/<head>/<body>` wrappers before
publishing (see the artifact copy step in session history; the
rendered file is a full document, artifacts want a fragment).

## Definitions that matter

- **Order** = non-voided QBO Invoice OR SalesReceipt (prepaid). SRs are
  NOT in the local DB — gather pulls them live from QBO (private
  `queryAll` reached at runtime). Voided SRs have TotalAmt 0.
- **New products** = Shopify tag **"new arrivals july 26"** (the
  operator says "new july26"; check the store's productTags for the
  current season's tag before regenerating — a "New arrivals RH 26"
  tag also exists). Fallback: QBO Item CreateTime heuristic.
- **Books**: one QBO realm; feldart vs tj by DocNumber prefix (1/2).

## Data landmines (learned the hard way)

- `invoice_lines.sku` holds the item NAME and `description` the SKU
  CODE for ~93% of rows (sync writes them swapped). Gather
  canonicalizes against the QBO Item Sku set — do not "simplify" this
  away.
- Nine stores have placeholder invoices dated **2030-01-01** in QBO;
  compute excludes future-dated docs from recency/cadence.
- Prod `products` table is EMPTY — QBO Items are the catalog; Service
  items are shipping/admin junk and are filtered out.
