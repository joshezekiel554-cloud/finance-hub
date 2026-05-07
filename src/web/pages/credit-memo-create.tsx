// src/web/pages/credit-memo-create.tsx
//
// Task 4.2 — unified Credit Memo create screen, line-items table.
// Task 4.3 — totals strip, notes/memo textareas, recipients block,
//            action buttons (Send + create / Save without sending /
//            Cancel), submit mutation against
//            POST /api/rmas/:id/process-return (endpoint ships Task 4.4).
//
// Replaces the inline RmaCreditMemoDialog flow with a full-page editor.
// Operator lands here from "Continue to credit memo" on the receipt-review
// card, or from a direct deep link (`/returns/$rmaId/credit-memo`). The
// page is the QBO-mirror form: header strip with customer + issue date,
// editable items table, totals strip, notes + memo textareas, recipients,
// and three action buttons.
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
// Scope added in Task 4.3:
//   - Subtotal / Tax / Total strip (rate driven by the existing
//     /api/rmas/:id/source-invoice-tax lookup, same module the legacy
//     RmaCreditMemoDialog used).
//   - Notes textarea (internal, persisted via process-return endpoint;
//     never appears on the credit memo).
//   - Memo textarea, seeded once from a returnType phrase + the RMA's
//     damages_note (per Task 1.3 — CustomerMemo is what shows up on the
//     statement).
//   - Email recipients (To / CC / BCC), seeded once from the customer's
//     invoice* JSON arrays (Task 1.2 finding: returns flow uses the
//     invoice channel, not chase). A warning banner shows when the
//     customer has no invoice TO addresses configured.
//   - Three action buttons. "Send + create in QB" is disabled while
//     emailTo is empty or any line is unexpected without a qbItemId
//     (QBO requires Item ref on every line).

import { useEffect, useMemo, useState } from "react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AlertCircle, Plus, Send, Trash2 } from "lucide-react";
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
  // damages_note is the operator's free-text "what was wrong" written in
  // the damage wizard. Used to seed the memo textarea (CustomerMemo on
  // the credit memo) so the customer/statement reader sees context
  // without the operator having to re-type.
  damagesNote: string | null;
  items: RmaItemDto[];
};

type CustomerDto = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  // Per-channel recipient lists. The returns flow uses the invoice
  // channel (Task 1.2 finding) — credit memos are billing docs, so
  // they're sent to the same inbox as the original invoice, not the
  // chase BCC list.
  invoiceToEmails: string[] | null;
  invoiceCcEmails: string[] | null;
  invoiceBccEmails: string[] | null;
};

type CustomerDetailResponse = {
  customer: CustomerDto;
};

// /api/rmas/:id/source-invoice-tax response — the same endpoint the
// legacy RmaCreditMemoDialog uses. `hadTax` reflects whether any of the
// original invoices for this RMA's items were taxed; `ratePercent` is
// the rate to apply (e.g. 11 for 11%). QBO recomputes the exact tax
// server-side from the tax code at submit time, so this rate is for the
// totals-strip preview only.
type SourceInvoiceTaxDto = {
  hadTax: boolean;
  ratePercent: number;
  taxCodeRef: string | null;
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();

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

  // Source-invoice tax lookup. Drives the totals strip's tax rate. The
  // server reads the tax code off each line's original invoice in QBO
  // and reports `hadTax=true` when any of them were taxed. Cached for a
  // minute since invoice tax codes don't change.
  const taxStatusQuery = useQuery<SourceInvoiceTaxDto>({
    queryKey: ["rma-source-invoice-tax", rmaId],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/source-invoice-tax`);
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
    const hasParsedData = parsedItems.length > 0;

    // Lookup table by SKU for quick override + match-tracking.
    const parsedBySku = new Map<string, number>();
    for (const p of parsedItems) parsedBySku.set(p.sku, p.quantity);
    const matchedSkus = new Set<string>();

    const rmaLines: Line[] = rma.items.map((item) => {
      const parsedQty = parsedBySku.get(item.sku);
      if (parsedQty !== undefined) matchedSkus.add(item.sku);
      // Precedence for receivedQty (updated 2026-05):
      //   1. freshly parsed receipt quantity — operator's most recent
      //      signal about what the warehouse actually scanned. When they
      //      re-paste a receipt on this page the new qty must win, even
      //      if a prior receivedQuantity was set by the legacy review
      //      dialog or a desktop import.
      //   2. parsed data exists but THIS sku is not in it — the warehouse
      //      didn't return this item, so received is 0. (Without this
      //      branch we'd fall through to the legacy receivedQuantity or
      //      the approved qty, which would silently credit items the
      //      warehouse never received.)
      //   3. no parsed data at all — fall back to the operator's prior
      //      receivedQuantity edit, then the approved RMA qty as the
      //      safest seed.
      const receivedQty =
        parsedQty !== undefined
          ? String(parsedQty)
          : hasParsedData
            ? "0"
            : (item.receivedQuantity ?? item.quantity);
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
  // Re-seed strategy. Two cases must seed:
  //   (a) first load — `lines` empty and `initialLines` has rows.
  //   (b) operator pastes a fresh receipt on this page — the parsed-
  //       receipts query is invalidated, refetched, dataUpdatedAt
  //       advances, and we must replace local state so the new qty
  //       (and any new unexpected SKUs) reflect on the table.
  // Background refetches that return identical data don't bump
  // dataUpdatedAt's relevance — we record the last-seen value and only
  // re-seed when it advances past a non-null baseline (i.e., not the
  // very first arrival of parsed data, which is already covered by (a)).
  // This means an operator's mid-edit description / unit-price tweaks
  // survive idle refetches but get clobbered on a deliberate paste —
  // which is what they asked for by re-pasting.
  const [lastParsedSeen, setLastParsedSeen] = useState<number | null>(null);
  useEffect(() => {
    const dataUpdatedAt = parsedReceiptsQuery.dataUpdatedAt ?? 0;
    const isFirstSeed = lines.length === 0 && initialLines.length > 0;
    const isFreshPaste =
      lastParsedSeen !== null && dataUpdatedAt > lastParsedSeen;

    if (isFirstSeed || isFreshPaste) {
      setLines(initialLines);
      if (dataUpdatedAt > 0) setLastParsedSeen(dataUpdatedAt);
    } else if (lastParsedSeen === null && dataUpdatedAt > 0) {
      // First arrival of parsed data — record the baseline without
      // re-seeding (initial seed already happened or will happen via
      // (a) when initialLines becomes non-empty).
      setLastParsedSeen(dataUpdatedAt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLines, parsedReceiptsQuery.dataUpdatedAt]);

  // Issue date defaults to today. Stored as YYYY-MM-DD so the date
  // <input> binds cleanly without timezone surprises.
  const [issueDate, setIssueDate] = useState<string>(() => {
    const d = new Date();
    const yyyy = d.getFullYear().toString().padStart(4, "0");
    const mm = (d.getMonth() + 1).toString().padStart(2, "0");
    const dd = d.getDate().toString().padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  });

  // ---- Memo / notes / recipients state -----------------------------------
  //
  // Notes — internal-only commentary for the activity timeline. Never
  // appears on the credit memo or the email body.
  const [notes, setNotes] = useState("");
  // Memo — becomes CustomerMemo on the QBO credit memo (per Task 1.3,
  // CustomerMemo is the field that surfaces on customer statements,
  // unlike PrivateNote which only appears in QBO's UI). Seeded once
  // from a returnType phrase + the RMA's damages_note.
  const [memo, setMemo] = useState("");
  // Recipients are independent inputs (comma-separated). Seeded once
  // from the customer's invoice* arrays, then operator-editable. The
  // submit mutation forwards them as-is — the server splits and
  // validates.
  const [emailTo, setEmailTo] = useState("");
  const [emailCc, setEmailCc] = useState("");
  const [emailBcc, setEmailBcc] = useState("");

  // Paste-receipt UI state (moved from ProcessReturnPanel). Operator
  // pastes the warehouse email body, server parses + persists, parsed-
  // receipts query is invalidated, and the line table re-seeds via the
  // re-seed effect above.
  const [showPasteForm, setShowPasteForm] = useState(false);
  const [pasteDraft, setPasteDraft] = useState("");
  const [pasteResult, setPasteResult] = useState<{
    receiptId: string;
    parsedItemCount: number;
  } | null>(null);

  // Damages note (moved from ProcessReturnPanel). Free-text field
  // composed into CustomerMemo server-side at submit, and persisted to
  // rmas.damages_note in the same DB transaction so the value sticks
  // across reloads even before submit (via a separate save path TBD).
  const [damagesDraft, setDamagesDraft] = useState("");

  // Seed damages-draft once from rma.damagesNote on initial load.
  useEffect(() => {
    if (damagesDraft !== "") return;
    if (rmaQuery.data?.damagesNote) {
      setDamagesDraft(rmaQuery.data.damagesNote);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rmaQuery.data?.damagesNote]);

  const pasteMutation = useMutation({
    mutationFn: async (pastedText: string) => {
      const res = await fetch(`/api/rmas/${rmaId}/paste-receipt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pastedText }),
      });
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{
        receiptId: string;
        parsedItemCount: number;
      }>;
    },
    onSuccess: (data) => {
      setPasteResult(data);
      setPasteDraft("");
      setShowPasteForm(false);
      // Invalidating parsed-receipts triggers the re-seed effect above
      // so the line table refreshes with the freshly parsed quantities.
      queryClient.invalidateQueries({
        queryKey: ["rma", rmaId, "parsed-receipts"],
      });
      queryClient.invalidateQueries({
        queryKey: ["rma", rmaId, "linked-emails"],
      });
    },
  });

  // Memo seed-once. We don't react to subsequent rma refetches because
  // the operator may have edited the memo mid-flow and we'd clobber it.
  // The damages note is now its own field on this page (composed into
  // CustomerMemo server-side at submit), so we no longer append it here.
  useEffect(() => {
    const rma = rmaQuery.data;
    if (!rma) return;
    if (memo !== "") return;
    const standardMemo =
      rma.returnType === "damage"
        ? "damaged items"
        : rma.returnType === "seasonal"
          ? "seasonal returns"
          : "returns";
    setMemo(standardMemo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rmaQuery.data]);

  // Recipients seed-once. Same rationale as memo: only fill while the
  // field is empty so an operator who already typed isn't reset by a
  // background customer refetch.
  useEffect(() => {
    const customer = customerQuery.data?.customer;
    if (!customer) return;
    if (!emailTo) {
      setEmailTo((customer.invoiceToEmails ?? []).join(", "));
    }
    if (!emailCc) {
      setEmailCc((customer.invoiceCcEmails ?? []).join(", "));
    }
    if (!emailBcc) {
      setEmailBcc((customer.invoiceBccEmails ?? []).join(", "));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerQuery.data?.customer]);

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

  // ---- Totals -------------------------------------------------------------
  //
  // Subtotal sums every line; taxableTotal sums only the lines the
  // operator marked taxable. The rate from source-invoice-tax is used
  // for preview math only — QBO recomputes from the actual TaxCode at
  // submit time, so a rounding delta vs. what QBO posts is expected.
  const subtotal = useMemo(
    () => lines.reduce((sum, l) => sum + lineTotal(l), 0),
    [lines],
  );
  const taxableTotal = useMemo(
    () =>
      lines
        .filter((l) => l.taxable)
        .reduce((sum, l) => sum + lineTotal(l), 0),
    [lines],
  );
  const taxRatePercent = taxStatusQuery.data?.ratePercent ?? 0;
  const tax = useMemo(
    () => taxableTotal * (taxRatePercent / 100),
    [taxableTotal, taxRatePercent],
  );
  const total = subtotal + tax;

  // ---- Submit guards ------------------------------------------------------
  //
  // QBO requires an Item ref on every credit memo line. Unexpected
  // lines (operator added via "Add blank line" or via the QboItemPicker
  // and never picked an item) are flagged with isUnexpected=true and
  // qbItemId="". They block "Send + create in QB" until resolved —
  // either pick an item or delete the line.
  const incompleteLines = lines.filter((l) => l.isUnexpected && !l.qbItemId);
  const canSend =
    emailTo.trim().length > 0 &&
    incompleteLines.length === 0 &&
    lines.length > 0;
  const noInvoiceRecipients =
    !!customerQuery.data?.customer &&
    (customerQuery.data.customer.invoiceToEmails ?? []).length === 0;

  // ---- Submit mutation ---------------------------------------------------
  //
  // POST /api/rmas/:id/process-return is the single endpoint that
  // creates the QBO credit memo, optionally sends the email, writes
  // activities, and advances the RMA status. Body shape lines up with
  // the Task 4.4 server contract — kept narrow (only what the server
  // needs) so a contract drift surfaces here as a 400.
  const submitMutation = useMutation({
    mutationFn: async ({ send }: { send: boolean }) => {
      const res = await fetch(`/api/rmas/${rmaId}/process-return`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lines: lines.map((l) => ({
            qbItemId: l.qbItemId,
            sku: l.sku,
            description: l.description,
            quantity: l.receivedQty,
            unitPrice: l.unitPrice,
            taxable: l.taxable,
          })),
          notes,
          memo,
          damagesNote: damagesDraft.trim() || undefined,
          sendEmail: send,
          emailTo,
          emailCc,
          emailBcc,
          issueDate,
        }),
      });
      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data: {
      creditMemoId: string;
      qboCreditMemoId: string;
      emailSent?: boolean;
      emailError?: string;
    }) => {
      // Invalidate everything that may now show this RMA in a new
      // status: detail page, Today tab, the RMA list itself.
      queryClient.invalidateQueries({ queryKey: ["rma", rmaId] });
      queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
      queryClient.invalidateQueries({ queryKey: ["rmas"] });

      // Partial success: credit memo created in QBO but email send failed.
      // Don't auto-navigate away — surface the error so the operator can
      // retry the send from the customer detail page.
      if (data.emailSent === false && data.emailError) {
        // eslint-disable-next-line no-alert
        alert(
          `Credit memo created in QBO (doc# ${data.qboCreditMemoId}), but the email failed to send:\n\n${data.emailError}\n\nYou can retry the send from the customer detail page.`,
        );
      }

      void navigate({ to: "/returns/$rmaId", params: { rmaId } });
    },
  });

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

      {/* Parse warehouse receipt (paste). Sits above the table because
          a paste re-seeds the table — operator's mental model is
          "drop receipt in here, then review the lines below." */}
      <Card>
        <CardBody className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Parse warehouse receipt</h3>
            {!showPasteForm && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowPasteForm(true)}
              >
                Paste receipt
              </Button>
            )}
          </div>
          {showPasteForm && (
            <>
              <p className="text-xs text-secondary">
                Paste the warehouse receipt body. We'll extract SKU + qty
                entries and merge them into the lines below.
              </p>
              <textarea
                value={pasteDraft}
                onChange={(e) => setPasteDraft(e.target.value)}
                placeholder="Paste the email body or transaction report..."
                rows={6}
                className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm font-mono"
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!pasteDraft.trim() || pasteMutation.isPending}
                  onClick={() => pasteMutation.mutate(pasteDraft)}
                >
                  {pasteMutation.isPending ? "Parsing…" : "Parse + merge"}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowPasteForm(false);
                    setPasteDraft("");
                  }}
                >
                  Cancel
                </Button>
                {pasteMutation.isError && (
                  <span className="text-xs text-accent-danger">
                    {(pasteMutation.error as Error).message}
                  </span>
                )}
                {pasteResult && (
                  <span className="text-xs text-secondary">
                    Parsed {pasteResult.parsedItemCount} item(s) — merged
                    into lines.
                  </span>
                )}
              </div>
            </>
          )}
        </CardBody>
      </Card>

      {/* Damages note. Placed directly under the paste card per
          operator request — paste, then describe what was wrong, then
          review the lines. Composed into CustomerMemo server-side at
          submit. */}
      <Card>
        <CardBody className="space-y-1">
          <label className="text-sm font-semibold">
            Damages reported by warehouse
          </label>
          <p className="text-xs text-secondary">
            Free-text — appears on the credit memo memo. Mention damaged
            SKUs and reason.
          </p>
          <textarea
            value={damagesDraft}
            onChange={(e) => setDamagesDraft(e.target.value)}
            placeholder="e.g., MMCSL03G x2 cracked"
            rows={3}
            className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
          />
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
                    <th className="px-3 py-2 w-24 text-right">Discrepancy</th>
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

      {/* Totals strip — sits below the items table, right-aligned in
          the QBO credit-memo footer style. The tax row notes that QBO
          recomputes server-side, so the operator knows this number is
          a preview, not the authoritative figure. */}
      <Card>
        <CardBody>
          <div className="flex justify-end">
            <div className="w-full max-w-xs space-y-1.5 text-sm">
              <TotalRow
                label="Subtotal"
                value={`$${subtotal.toFixed(2)}`}
              />
              <TotalRow
                label={
                  taxRatePercent > 0
                    ? `Tax (≈${taxRatePercent.toFixed(2)}%)`
                    : "Tax"
                }
                value={`$${tax.toFixed(2)}`}
                hint={
                  taxStatusQuery.isPending
                    ? "Looking up source-invoice tax…"
                    : taxRatePercent === 0
                      ? "QBO will compute server-side"
                      : null
                }
              />
              <div className="border-t border-default pt-1.5">
                <TotalRow
                  label="Total"
                  value={`$${total.toFixed(2)}`}
                  bold
                />
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Notes (internal) + memo (CustomerMemo on QBO). Two textareas
          stacked so the difference is obvious to the operator. */}
      <Card>
        <CardBody className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="cm-notes"
              className="text-xs font-medium text-secondary"
            >
              Notes
            </label>
            <textarea
              id="cm-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Internal notes — not on credit memo"
              className="w-full rounded-md border border-default bg-elevated px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-strong focus:outline-none"
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="cm-memo"
              className="text-xs font-medium text-secondary"
            >
              Memo
            </label>
            <textarea
              id="cm-memo"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              rows={3}
              placeholder="Memo — appears on credit memo + customer statement"
              className="w-full rounded-md border border-default bg-elevated px-3 py-2 text-sm text-primary placeholder:text-muted focus:border-strong focus:outline-none"
            />
          </div>
        </CardBody>
      </Card>

      {/* Email recipients block. Comma-separated strings — server
          splits + validates. Pre-filled from the customer's invoice*
          arrays since CMs are billing docs (Task 1.2). */}
      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Email recipients</h2>
            <span className="text-xs text-muted">
              Comma-separated; the credit memo PDF is attached
            </span>
          </div>

          {noInvoiceRecipients && (
            <div className="flex items-start gap-2 rounded-md border border-accent-warning/40 bg-accent-warning/5 px-3 py-2 text-xs text-secondary">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-accent-warning" />
              <div>
                No invoice recipients set on this customer. Add To
                addresses below before sending, or set them on the
                customer profile to avoid this every time.
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-[80px_1fr] sm:gap-x-3 sm:gap-y-2 sm:items-center">
            <label
              htmlFor="cm-email-to"
              className="text-xs font-medium text-secondary sm:text-right"
            >
              To
            </label>
            <Input
              id="cm-email-to"
              type="text"
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              placeholder="recipient@example.com"
            />
            <label
              htmlFor="cm-email-cc"
              className="text-xs font-medium text-secondary sm:text-right"
            >
              CC
            </label>
            <Input
              id="cm-email-cc"
              type="text"
              value={emailCc}
              onChange={(e) => setEmailCc(e.target.value)}
              placeholder="optional"
            />
            <label
              htmlFor="cm-email-bcc"
              className="text-xs font-medium text-secondary sm:text-right"
            >
              BCC
            </label>
            <Input
              id="cm-email-bcc"
              type="text"
              value={emailBcc}
              onChange={(e) => setEmailBcc(e.target.value)}
              placeholder="optional"
            />
          </div>
        </CardBody>
      </Card>

      {/* Action buttons. "Send + create in QB" is the primary action;
          "Save without sending" is the escape hatch when the operator
          wants the credit memo in QBO but isn't ready to email yet
          (e.g. wants to attach a hand-written note in QBO first). */}
      <div className="space-y-2">
        {submitMutation.isError && (
          <p className="text-right text-sm text-accent-danger">
            {(submitMutation.error as Error).message}
          </p>
        )}
        {incompleteLines.length > 0 && (
          <p className="text-right text-xs text-accent-warning">
            {incompleteLines.length}{" "}
            {incompleteLines.length === 1 ? "line is" : "lines are"}{" "}
            missing a QBO item — pick one or delete the line before
            sending.
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="ghost"
            disabled={submitMutation.isPending}
            onClick={() =>
              navigate({ to: "/returns/$rmaId", params: { rmaId } })
            }
          >
            Cancel
          </Button>
          <Button
            variant="secondary"
            loading={
              submitMutation.isPending && submitMutation.variables?.send === false
            }
            disabled={
              submitMutation.isPending ||
              lines.length === 0 ||
              incompleteLines.length > 0
            }
            onClick={() => submitMutation.mutate({ send: false })}
          >
            Save without sending
          </Button>
          <Button
            variant="primary"
            loading={
              submitMutation.isPending && submitMutation.variables?.send === true
            }
            disabled={submitMutation.isPending || !canSend}
            onClick={() => submitMutation.mutate({ send: true })}
          >
            <Send className="size-4" />
            Send + create in QB
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Totals row -------------------------------------------------------------
//
// Small helper so the strip stays terse. `hint` renders as a smaller
// muted line under the value — used for the "QBO will compute
// server-side" note when no source-invoice tax was found.
function TotalRow({
  label,
  value,
  bold,
  hint,
}: {
  label: string;
  value: string;
  bold?: boolean;
  hint?: string | null;
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3 tabular-nums",
        bold && "font-semibold",
      )}
    >
      <span className={cn("text-secondary", bold && "text-primary")}>
        {label}
      </span>
      <div className="text-right">
        <div className={cn(bold ? "text-base text-primary" : "text-primary")}>
          {value}
        </div>
        {hint && <div className="text-xs text-muted">{hint}</div>}
      </div>
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

      {/* Discrepancy — received minus expected. Negative (short ship)
          is the common case and renders danger; positive (over ship)
          renders warning so the operator notices a likely typo or a
          co-shipped item that should be its own line. Manual lines
          have no expectedQty, so they render an em-dash. */}
      {(() => {
        const exp = parseFloat(line.expectedQty ?? "0");
        const rec = parseFloat(line.receivedQty);
        const delta =
          Number.isFinite(exp) && Number.isFinite(rec) ? rec - exp : 0;
        return (
          <td className="px-3 py-2 text-right align-top tabular-nums">
            {line.expectedQty == null ? (
              <span className="text-muted">—</span>
            ) : delta < 0 ? (
              <span className="text-accent-danger font-medium">{delta}</span>
            ) : delta > 0 ? (
              <span className="text-accent-warning font-medium">+{delta}</span>
            ) : (
              <span className="text-muted">0</span>
            )}
          </td>
        );
      })()}

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
