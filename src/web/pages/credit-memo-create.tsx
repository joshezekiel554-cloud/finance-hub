// src/web/pages/credit-memo-create.tsx
//
// Task 4.2 — unified Credit Memo create screen, line-items table.
//
// Replaces the inline RmaCreditMemoDialog flow with a full-page editor.
// Operator lands here from "Continue to credit memo" on the receipt-review
// card, or from a direct deep link (`/returns/$rmaId/credit-memo`). The
// page is the QBO-mirror form: header strip with customer + issue date,
// editable items table, and "Add line" / "Add blank line" controls.
//
// Scope of this task (4.2):
//   - Fetch RMA detail (items in RMA order via orderBy(position) on the
//     server) and customer (separate /api/customers/:id call).
//   - Build the editable Line[] state from rma.items. Parsed-receipt
//     merge (linked_emails for email_kind='return_receipt') is deferred
//     until Task 3.1 ships the linked-emails endpoint — RMA items are
//     enough for the day-1 cutover since received_quantity already
//     reflects the receipt.
//   - Render the table: SKU / Description / Expected / Received / Unit
//     price / Tax / Total / Delete. Inline edits via updateLine().
//   - "Add line" via QboItemPicker (lookup-prices not wired yet — Task
//     4.3 may layer that on top, mirroring receipt-review).
//   - "Add blank line" — empty row with isUnexpected=true so Task 4.3 /
//     Task 4.4 can reject submission until the operator picks an item.
//
// Out of scope (Task 4.3): memo textarea, recipients chips, totals
// strip with sales-tax/shipping/restocking, action buttons, submit.

import { useEffect, useMemo, useState } from "react";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, AlertCircle, Plus, Trash2 } from "lucide-react";
import { Card, CardBody } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { QboItemPicker, type QbItemHit } from "../components/qbo-item-picker";
import { cn } from "../lib/cn";

const creditMemoCreateRouteApi = getRouteApi("/returns/$rmaId/credit-memo");

// ---- Types ------------------------------------------------------------------

// Mirrors the RMA detail GET response — kept narrow (only the fields the
// page reads) so a server-side shape drift surfaces here as a TS error.
type RmaItemDto = {
  id: string;
  qbItemId: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  receivedQuantity: string | null;
  originalInvoiceDocNumber: string | null;
  originalInvoiceDate: string | null;
};

type RmaDetailDto = {
  id: string;
  rmaNumber: string | null;
  customerId: string;
  qbCustomerId: string | null;
  returnType: "damage" | "seasonal" | "non_seasonal";
  status: string;
  totalValue: string;
  items: RmaItemDto[];
};

type CustomerDto = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
};

type CustomerDetailResponse = {
  customer: CustomerDto;
};

// One row of the editable table. `key` is a stable React identity even
// when rows shift around or the operator deletes from the middle —
// using array index as key would re-key adjacent rows on every delete
// and lose focus mid-edit.
type Line = {
  key: string;
  qbItemId: string;
  sku: string;
  description: string;
  // null when the line was added manually (no expected quantity to
  // compare against). Stored as string for easy `<input>` binding,
  // converted on demand for arithmetic.
  expectedQty: string | null;
  receivedQty: string;
  unitPrice: string;
  taxable: boolean;
  isUnexpected: boolean;
};

// ---- Helpers ----------------------------------------------------------------

// Description seed: SKU + the item name + a parenthetical pointing to
// the original invoice when known. Operator can edit inline before
// submit, but this is a sensible default that tells the customer which
// shipment is being credited.
function formatDescription(item: RmaItemDto): string {
  const trimmedName = item.name?.trim() ?? "";
  const head = trimmedName && trimmedName !== item.sku
    ? `${item.sku} — ${trimmedName}`
    : item.sku;
  if (item.originalInvoiceDocNumber) {
    const dateRef = item.originalInvoiceDate
      ? `, ${item.originalInvoiceDate}`
      : "";
    return `${head} (invoice ${item.originalInvoiceDocNumber}${dateRef})`;
  }
  return head;
}

function lineTotal(line: Line): number {
  const qty = parseFloat(line.receivedQty);
  const price = parseFloat(line.unitPrice);
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return 0;
  return qty * price;
}

// ---- Page -------------------------------------------------------------------

export default function CreditMemoCreatePage() {
  const { rmaId } = creditMemoCreateRouteApi.useParams();

  // ---- Data fetching ------------------------------------------------------

  const rmaQuery = useQuery<RmaDetailDto>({
    queryKey: ["rma", rmaId],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 0,
  });

  const customerQuery = useQuery<CustomerDetailResponse>({
    enabled: !!rmaQuery.data?.customerId,
    queryKey: ["customer", rmaQuery.data?.customerId],
    queryFn: async () => {
      const res = await fetch(`/api/customers/${rmaQuery.data!.customerId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });

  // Pulls aggregated parsed-items rows across every undismissed
  // extensiv_receipt linked to this RMA. The server returns SKUs in
  // first-seen order with quantities summed across receipts, so we can
  // (a) override receivedQty for matching RMA items and (b) append
  // unexpected SKUs as new lines.
  const parsedReceiptsQuery = useQuery<{
    receiptCount: number;
    items: Array<{ sku: string; quantity: number }>;
  }>({
    queryKey: ["rma", rmaId, "parsed-receipts"],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/parsed-receipts`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  // ---- Initial line-state derivation --------------------------------------

  // Lines derive from RMA items (in server position order) merged with
  // parsed-receipt aggregates per Section 4 of the returns-redesign spec:
  //   1. RMA items first, in RMA order.
  //   2. receivedQty for matching SKUs is overridden by the parsed
  //      receipt quantity (sum across all undismissed receipts), so the
  //      column reflects what the warehouse actually scanned even when
  //      the operator never opened the legacy review dialog.
  //   3. Parsed SKUs not on the RMA append as new lines marked
  //      isUnexpected — Task 4.4's submit validator must reject these
  //      until the operator picks a QBO item and sets a unit price.
  const initialLines = useMemo<Line[]>(() => {
    const rma = rmaQuery.data;
    if (!rma) return [];
    const parsedItems = parsedReceiptsQuery.data?.items ?? [];

    // Lookup table by SKU for quick override + match-tracking.
    const parsedBySku = new Map<string, number>();
    for (const p of parsedItems) parsedBySku.set(p.sku, p.quantity);
    const matchedSkus = new Set<string>();

    const rmaLines: Line[] = rma.items.map((item) => {
      const parsedQty = parsedBySku.get(item.sku);
      if (parsedQty !== undefined) matchedSkus.add(item.sku);
      // Precedence for receivedQty:
      //   1. operator's prior receivedQuantity edit (legacy review-dialog
      //      flow may already have populated it),
      //   2. parsed receipt quantity if the warehouse classified it,
      //   3. approved qty as the safest fallback.
      const receivedQty =
        item.receivedQuantity ??
        (parsedQty !== undefined ? String(parsedQty) : item.quantity);
      return {
        key: `rma-${item.id}`,
        qbItemId: item.qbItemId,
        sku: item.sku,
        description: formatDescription(item),
        expectedQty: item.quantity,
        receivedQty,
        unitPrice: item.unitPrice,
        // Spec default: tax OFF. The decision lives on the totals strip
        // (Task 4.3) — per-line taxable is a hint that flows into the
        // server-side credit memo build.
        taxable: false,
        isUnexpected: false,
      };
    });

    // Unexpected lines — parsed SKUs that don't match any RMA item.
    // qbItemId="" and unitPrice="0" are explicit "operator must touch
    // these" markers; Task 4.4's submit guard rejects them.
    const unexpectedLines: Line[] = parsedItems
      .filter((p) => !matchedSkus.has(p.sku))
      .map((p, idx) => ({
        key: `unexpected-${p.sku}-${idx}`,
        qbItemId: "",
        sku: p.sku,
        description: p.sku,
        expectedQty: null,
        receivedQty: String(p.quantity),
        unitPrice: "0",
        taxable: false,
        isUnexpected: true,
      }));

    return [...rmaLines, ...unexpectedLines];
  }, [rmaQuery.data, parsedReceiptsQuery.data]);

  const [lines, setLines] = useState<Line[]>([]);
  // Seed-once pattern: react-query may refetch the RMA / parsed receipts
  // in the background (focus, mutation invalidations from Task 4.3). If
  // we re-ran setLines on every initialLines identity change, the
  // operator's mid-edit description / unit-price tweaks would be wiped.
  // We therefore only seed when local state is empty — subsequent
  // refetches are observable via the queries' loading flags but don't
  // clobber edits.
  useEffect(() => {
    if (lines.length === 0 && initialLines.length > 0) {
      setLines(initialLines);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLines]);

  // Issue date defaults to today. Stored as YYYY-MM-DD so the date
  // <input> binds cleanly without timezone surprises.
  const [issueDate, setIssueDate] = useState<string>(() => {
    const d = new Date();
    const yyyy = d.getFullYear().toString().padStart(4, "0");
    const mm = (d.getMonth() + 1).toString().padStart(2, "0");
    const dd = d.getDate().toString().padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });

  // ---- Line editors -------------------------------------------------------

  function updateLine(idx: number, patch: Partial<Line>) {
    setLines((prev) =>
      prev.map((line, i) => (i === idx ? { ...line, ...patch } : line)),
    );
  }

  function deleteLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function addPickedLine(hit: QbItemHit) {
    const seedPrice = hit.unitPrice != null ? hit.unitPrice.toFixed(4) : "0";
    setLines((prev) => [
      ...prev,
      {
        key: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        qbItemId: hit.id,
        sku: hit.sku ?? hit.id,
        description: hit.name || (hit.sku ?? hit.id),
        expectedQty: null,
        receivedQty: "1",
        unitPrice: seedPrice,
        taxable: false,
        isUnexpected: true,
      },
    ]);
    // TODO Task 4.3: optionally fire /api/rmas/:id/lookup-prices to
    // auto-fill price + invoice info, mirroring receipt-review's
    // unexpected-item flow.
  }

  function addBlankLine() {
    setLines((prev) => [
      ...prev,
      {
        key: `blank-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        qbItemId: "",
        sku: "",
        description: "",
        expectedQty: null,
        receivedQty: "1",
        unitPrice: "0",
        taxable: false,
        isUnexpected: true,
      },
    ]);
  }

  // ---- Render: loading / error gates --------------------------------------

  if (rmaQuery.isPending) {
    return (
      <div className="space-y-4">
        <BackLink rmaId={rmaId} />
        <div className="py-12 text-center text-sm text-muted">
          Loading credit memo…
        </div>
      </div>
    );
  }

  if (rmaQuery.isError || !rmaQuery.data) {
    return (
      <div className="space-y-4">
        <BackLink rmaId={rmaId} />
        <div className="flex items-center gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-4 py-3 text-sm text-accent-danger">
          <AlertCircle className="size-4 shrink-0" />
          {(rmaQuery.error as Error)?.message ?? "Failed to load RMA"}
        </div>
      </div>
    );
  }

  const rma = rmaQuery.data;
  const customer = customerQuery.data?.customer ?? null;
  const displayNumber = rma.rmaNumber ?? `Draft ${rma.id.slice(0, 6)}…`;

  // ---- Render: page -------------------------------------------------------

  return (
    <div className="space-y-6">
      <BackLink rmaId={rmaId} />

      {/* Header strip — customer + RMA pointer + issue date. The doc
          number lands in Task 4.3 once submit-side wiring picks it. */}
      <Card>
        <CardBody>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-xl font-semibold">Create credit memo</h1>
              <div className="text-sm text-secondary">
                {customer ? (
                  <Link
                    to="/customers/$customerId"
                    params={{ customerId: rma.customerId }}
                    className="text-accent-primary hover:underline"
                  >
                    {customer.displayName}
                  </Link>
                ) : customerQuery.isPending ? (
                  <span className="text-muted">Loading customer…</span>
                ) : (
                  <span className="text-muted">Customer unavailable</span>
                )}
                <span className="mx-2 text-muted">·</span>
                <span className="font-mono">{displayNumber}</span>
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label
                htmlFor="cm-issue-date"
                className="text-xs font-medium text-secondary"
              >
                Issue date
              </label>
              <Input
                id="cm-issue-date"
                type="date"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                className="w-40"
              />
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Items table */}
      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Line items</h2>
            <span className="text-xs text-muted">
              {lines.length} {lines.length === 1 ? "line" : "lines"}
            </span>
          </div>

          {lines.length === 0 ? (
            <p className="rounded-md border border-dashed border-default px-3 py-4 text-center text-sm text-muted">
              No lines yet. Add one with the controls below.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-default">
              <table className="w-full text-sm">
                <thead className="bg-subtle text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-3 py-2 w-32">SKU</th>
                    <th className="px-3 py-2">Description</th>
                    <th className="px-3 py-2 w-20 text-right">Expected</th>
                    <th className="px-3 py-2 w-24 text-right">Received</th>
                    <th className="px-3 py-2 w-28 text-right">Unit price</th>
                    <th className="px-3 py-2 w-12 text-center">Tax</th>
                    <th className="px-3 py-2 w-28 text-right">Total</th>
                    <th className="px-3 py-2 w-12 text-center" aria-label="Delete" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-default">
                  {lines.map((line, idx) => (
                    <LineRow
                      key={line.key}
                      line={line}
                      onChange={(patch) => updateLine(idx, patch)}
                      onDelete={() => deleteLine(idx)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Add-line controls. The QboItemPicker auto-resets its
              query on pick (see component), so consecutive adds work
              without remounting. */}
          <div className="flex flex-wrap items-end gap-3 pt-2">
            <div className="min-w-[260px] flex-1">
              <label className="mb-1 block text-xs font-medium text-secondary">
                Add line (search QBO items)
              </label>
              <QboItemPicker onPick={addPickedLine} />
            </div>
            <Button variant="secondary" onClick={addBlankLine}>
              <Plus className="size-4" />
              Add blank line
            </Button>
          </div>
        </CardBody>
      </Card>

      {/* Totals strip + memo + recipients + action buttons land in Task 4.3. */}
      <p className="text-xs text-muted">
        Memo, recipients, totals, and submit land in Task 4.3.
      </p>
    </div>
  );
}

// ---- Line row ---------------------------------------------------------------

function LineRow({
  line,
  onChange,
  onDelete,
}: {
  line: Line;
  onChange: (patch: Partial<Line>) => void;
  onDelete: () => void;
}) {
  // Discrepancy colouring: red when received < expected (short ship,
  // common case) and amber when received > expected (warehouse logged
  // more than the operator approved — usually a typo or a co-shipped
  // item that should be a separate line). Manual lines have no
  // expectedQty, so they always render in the default colour.
  const expected = line.expectedQty != null ? parseFloat(line.expectedQty) : null;
  const received = parseFloat(line.receivedQty);
  let receivedTone = "";
  if (expected != null && Number.isFinite(received) && Number.isFinite(expected)) {
    if (received < expected) receivedTone = "text-accent-danger";
    else if (received > expected) receivedTone = "text-accent-warning";
  }

  const total = lineTotal(line);

  return (
    <tr>
      {/* SKU — read-only. For unexpected/blank rows the operator picks
          via the row's QboItemPicker (planned for 4.3 if needed). */}
      <td className="px-3 py-2 align-top">
        <span className="font-mono text-xs">
          {line.sku || <span className="text-muted">—</span>}
        </span>
      </td>

      {/* Description — inline edit. The seeded value already includes
          the original-invoice reference; operator can rewrite. */}
      <td className="px-3 py-2 align-top">
        <Input
          type="text"
          value={line.description}
          onChange={(e) => onChange({ description: e.target.value })}
          className="w-full"
          placeholder="Description"
        />
      </td>

      {/* Expected — read-only display. Manual lines render an em-dash. */}
      <td className="px-3 py-2 text-right align-top tabular-nums">
        {line.expectedQty == null
          ? <span className="text-muted">—</span>
          : line.expectedQty}
      </td>

      {/* Received — editable, with discrepancy tone. */}
      <td className="px-3 py-2 align-top">
        <Input
          type="number"
          min="0"
          step="1"
          value={line.receivedQty}
          onChange={(e) => onChange({ receivedQty: e.target.value })}
          className={cn("w-full text-right tabular-nums", receivedTone)}
        />
      </td>

      {/* Unit price — editable, 4dp to match QBO precision. */}
      <td className="px-3 py-2 align-top">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={line.unitPrice}
          onChange={(e) => onChange({ unitPrice: e.target.value })}
          className="w-full text-right tabular-nums"
        />
      </td>

      {/* Tax — native checkbox. We don't have a styled <Checkbox>
          component in src/web/components/ui yet; a native input lined
          up with the form's spacing is fine for this row density and
          avoids a one-off component. */}
      <td className="px-3 py-2 text-center align-top">
        <input
          type="checkbox"
          checked={line.taxable}
          onChange={(e) => onChange({ taxable: e.target.checked })}
          className="size-4 cursor-pointer rounded border-default"
          aria-label="Taxable"
        />
      </td>

      {/* Total — computed display. */}
      <td className="px-3 py-2 text-right align-top tabular-nums">
        ${total.toFixed(2)}
      </td>

      {/* Delete */}
      <td className="px-3 py-2 text-center align-top">
        <button
          type="button"
          onClick={onDelete}
          aria-label="Delete line"
          className="text-secondary transition-colors hover:text-accent-danger"
        >
          <Trash2 className="size-4" />
        </button>
      </td>
    </tr>
  );
}

// ---- Back nav ---------------------------------------------------------------

function BackLink({ rmaId }: { rmaId: string }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <Link
        to="/returns/$rmaId"
        params={{ rmaId }}
        className="inline-flex items-center gap-1 text-secondary hover:text-primary"
      >
        <ArrowLeft className="size-4" />
        Back to RMA
      </Link>
    </div>
  );
}
