// return-receipt-review-dialog.tsx
//
// Single-dialog flow for reviewing an Extensiv warehouse return receipt.
//
// Layout: an Expected / Received / Discrepancy table comparing what the RMA
// expected against what the warehouse actually received. Operator edits
// received qty per row. The credit-memo step itself runs in the shared
// RmaCreditMemoDialog (sales tax checkbox, PDF auto-attach, etc.) which
// the parent opens after this dialog hands off.
//
// Bottom action bar adapts to matched vs unmatched receipts:
//   Matched:   [Save Receipt Only] / [Continue to credit memo →]
//   Unmatched: [Manual Match] / [Create RMA from receipt] / [Dismiss]

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Plus, Search, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { invalidateAfterRmaChange } from "../lib/invalidate-rma";
import { QboItemPicker, type QbItemHit } from "./qbo-item-picker";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ParsedItem = { sku: string; quantity: number };

type RmaSummary = {
  id: string;
  rmaNumber: string | null;
  customerId: string | null;
  customerName: string | null;
};

export type ReceiptRow = {
  docType: "return_receipt";
  receiptId: string;
  rmaId: string | null;
  matchKind: "exact_tx_number" | "exact_ref_string" | "fuzzy_customer_sku" | "no_match";
  matchConfidence: number | null;
  txNumber: string | null;
  refString: string | null;
  parsedItems: ParsedItem[];
  inferredCustomerName: string | null;
  classifiedAt: string;
  gmailMessageId: string;
  emailSubject: string;
  emailFrom: string;
  emailBody: string;
  rma: RmaSummary | null;
};

type RmaItem = {
  id: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  receivedQuantity: string | null;
};

type RmaDetail = {
  id: string;
  rmaNumber: string | null;
  customerId: string;
  qbCustomerId: string | null;
  returnType: "damage" | "seasonal" | "non_seasonal";
  status: string;
  items: RmaItem[];
};

type RmaListItem = {
  id: string;
  rmaNumber: string | null;
  status: string;
  customerId: string;
};

type RmaListResponse = {
  rmas: RmaListItem[];
};

type QbCustomerHit = {
  id: string;
  name: string;
  displayName: string;
  qbCustomerId: string;
};

// Shape returned by GET /api/customers?q=... — qbCustomerId may be null for
// customers not yet synced from QBO. We surface those in the picker but mark
// them as un-pickable so the operator can see why.
type CustomerSearchHit = {
  id: string;
  qbCustomerId: string | null;
  displayName: string;
  primaryEmail: string | null;
};
type CustomerSearchResponse = { customers: CustomerSearchHit[] };

// Per-item received quantity state key is rma_item_id
type ReceivedQtyMap = Record<string, string>;

// An unexpected item (not on the RMA) that was received. Operator picks
// it via the shared QboItemPicker, which resolves SKU/name/qbItemId from
// QBO. Once picked, we auto-fire /lookup-prices to fill in unitPrice +
// originalInvoiceDocNumber/Date so the credit memo line is fully formed
// without a second click.
type UnexpectedItem = {
  key: string;
  qbItemId: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string | null;
  listUnitPrice: string | null;
  invoiceDiscountPct: string | null;
  originalInvoiceDocNumber: string | null;
  originalInvoiceDate: string | null;
  // Tracks the per-row lookup state so the inline summary can show
  // "looking up…" / errors without each row carrying its own mutation.
  lookupStatus: "idle" | "pending" | "done" | "error";
  lookupError: string | null;
};

export type ReturnReceiptReviewDialogProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  receipt: ReceiptRow;
  onDone: () => void;
  // Fired when the operator clicks "Continue to credit memo" — at this
  // point the received qty has been saved + the receipt confirmed. The
  // parent is responsible for opening the RmaCreditMemoDialog so the
  // operator can pick deductions / sales tax / send the email.
  onContinueToCreditMemo?: (target: {
    rmaId: string;
    customerId: string;
  }) => void;
};

// ---------------------------------------------------------------------------
// Main dialog component
// ---------------------------------------------------------------------------

export default function ReturnReceiptReviewDialog({
  open,
  onOpenChange,
  receipt,
  onDone,
  onContinueToCreditMemo,
}: ReturnReceiptReviewDialogProps) {
  const queryClient = useQueryClient();
  const isMatched = receipt.rmaId !== null;

  // ---- RMA detail (only when matched) -------------------------------------
  const rmaQuery = useQuery<RmaDetail>({
    enabled: open && isMatched,
    queryKey: ["rma", receipt.rmaId],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${receipt.rmaId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 0,
  });

  // ---- Receipt review state -----------------------------------------------
  // receivedQty: keyed by rma_item_id for matched rows, or by sku for unmatched
  const [receivedQty, setReceivedQty] = useState<ReceivedQtyMap>({});
  const [unexpectedItems, setUnexpectedItems] = useState<UnexpectedItem[]>([]);
  const [showAddUnexpected, setShowAddUnexpected] = useState(false);

  // Fires /lookup-prices for an unexpected-item row after the operator
  // picks a QBO item. Updates the row in place with unitPrice + invoice
  // info so the operator doesn't have to type either.
  async function lookupPricesForUnexpected(key: string, qbItemId: string) {
    if (!receipt.rmaId) return;
    setUnexpectedItems((prev) =>
      prev.map((x) =>
        x.key === key
          ? { ...x, lookupStatus: "pending", lookupError: null }
          : x,
      ),
    );
    try {
      const res = await fetch(`/api/rmas/${receipt.rmaId}/lookup-prices`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qbItemId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        unitPrice: string | null;
        listUnitPrice: string | null;
        invoiceDiscountPct: string | null;
        originalInvoiceDocNumber: string | null;
        originalInvoiceDate: string | null;
      };
      setUnexpectedItems((prev) =>
        prev.map((x) =>
          x.key === key
            ? {
                ...x,
                unitPrice: data.unitPrice ?? x.unitPrice,
                listUnitPrice: data.listUnitPrice ?? x.listUnitPrice,
                invoiceDiscountPct:
                  data.invoiceDiscountPct ?? x.invoiceDiscountPct,
                originalInvoiceDocNumber:
                  data.originalInvoiceDocNumber ?? x.originalInvoiceDocNumber,
                originalInvoiceDate:
                  data.originalInvoiceDate ?? x.originalInvoiceDate,
                lookupStatus: "done",
                lookupError: null,
              }
            : x,
        ),
      );
    } catch (err) {
      setUnexpectedItems((prev) =>
        prev.map((x) =>
          x.key === key
            ? {
                ...x,
                lookupStatus: "error",
                lookupError:
                  err instanceof Error ? err.message : "Lookup failed",
              }
            : x,
        ),
      );
    }
  }

  // Seed receivedQty from parsed receipt items when dialog opens
  useEffect(() => {
    if (!open) return;
    const next: ReceivedQtyMap = {};
    if (isMatched && rmaQuery.data) {
      for (const item of rmaQuery.data.items) {
        // Default: parsed quantity for matching SKU, else approved qty
        const parsedItem = receipt.parsedItems.find((p) => p.sku === item.sku);
        next[item.id] = String(parsedItem?.quantity ?? item.quantity);
      }
    } else {
      // Unmatched: key by sku
      for (const p of receipt.parsedItems) {
        next[p.sku] = String(p.quantity);
      }
    }
    setReceivedQty(next);
  }, [open, isMatched, rmaQuery.data, receipt.parsedItems]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setReceivedQty({});
      setUnexpectedItems([]);
      setShowAddUnexpected(false);
      setShowManualMatch(false);
      setShowFromReceipt(false);
      setRmaSearchQ("");
    }
  }, [open]);

  // ---- Unmatched path: manual match dialog --------------------------------
  const [showManualMatch, setShowManualMatch] = useState(false);
  const [rmaSearchQ, setRmaSearchQ] = useState("");

  const rmaListQuery = useQuery<RmaListResponse>({
    enabled: showManualMatch,
    queryKey: ["rmas", "sent_to_warehouse"],
    queryFn: async () => {
      const res = await fetch("/api/rmas?status=sent_to_warehouse&limit=100");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 0,
  });

  const filteredRmas = useMemo(() => {
    const q = rmaSearchQ.toLowerCase();
    if (!q) return rmaListQuery.data?.rmas ?? [];
    return (rmaListQuery.data?.rmas ?? []).filter(
      (r) =>
        r.rmaNumber?.toLowerCase().includes(q) ||
        r.id.toLowerCase().includes(q),
    );
  }, [rmaListQuery.data, rmaSearchQ]);

  // ---- Unmatched path: create from receipt --------------------------------
  const [showFromReceipt, setShowFromReceipt] = useState(false);
  const [frCustomerSearch, setFrCustomerSearch] = useState("");
  const [frCustomer, setFrCustomer] = useState<QbCustomerHit | null>(null);
  const [frReturnType, setFrReturnType] = useState<"damage" | "seasonal" | "non_seasonal">("damage");

  // Customer search for the "Create RMA from receipt" path. Pattern mirrors
  // CustomerPicker in src/web/pages/return-new.tsx — TanStack Query handles
  // caching/dedup; we gate on showFromReceipt + a 2-char minimum to avoid
  // hammering /api/customers with single-letter queries.
  const frCustomerQuery = useQuery<CustomerSearchResponse>({
    enabled:
      showFromReceipt &&
      !frCustomer &&
      frCustomerSearch.trim().length >= 2,
    queryKey: ["customer-search", frCustomerSearch.trim()],
    queryFn: async () => {
      const res = await fetch(
        `/api/customers?q=${encodeURIComponent(frCustomerSearch.trim())}&limit=10`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  // ---- Mutations ----------------------------------------------------------

  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/rmas/extensiv-receipts/${receipt.receiptId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
      // Receipt confirm flips RMA status sent_to_warehouse → received,
      // which the global Returns list / customer profile / chase pill all
      // care about.
      invalidateAfterRmaChange(queryClient, {
        rmaId: receipt.rmaId,
        customerId: receipt.rma?.customerId ?? null,
      });
      onDone();
      onOpenChange(false);
    },
  });

  // "Continue to credit memo" — persists the received-qty edits to each
  // RMA item, confirms the receipt (which moves the RMA to received if it
  // was at sent_to_warehouse), then hands off to the parent so it can open
  // the shared RmaCreditMemoDialog.
  const continueToCmMutation = useMutation({
    mutationFn: async () => {
      if (!receipt.rmaId || !receipt.rma?.customerId || !rmaQuery.data) {
        throw new Error("RMA not loaded yet");
      }
      const rma = rmaQuery.data;
      // PATCH each item's receivedQuantity (only when the operator's edit
      // differs from the current backend value — saves needless writes).
      await Promise.all(
        rma.items.map(async (item) => {
          const next = receivedQty[item.id] ?? item.quantity;
          const current = item.receivedQuantity ?? item.quantity;
          if (parseFloat(next) === parseFloat(current)) return;
          const res = await fetch(
            `/api/rmas/${receipt.rmaId}/items/${item.id}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ receivedQuantity: next }),
            },
          );
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(body.error ?? `HTTP ${res.status}`);
          }
        }),
      );
      // Persist any unexpected items the operator added. We POST these
      // sequentially (not in parallel) because each call hits QBO state
      // through the rmaItem total recompute, and the receipt-review flow
      // produces at most a handful of unexpected rows — sequential keeps
      // error surfacing simple. Classification mirrors the parent RMA's
      // returnType (seasonal RMAs default new lines to seasonal_current).
      const classification: "damage" | "seasonal_current" | "non_seasonal" =
        rma.returnType === "damage"
          ? "damage"
          : rma.returnType === "seasonal"
            ? "seasonal_current"
            : "non_seasonal";
      for (const ui of unexpectedItems) {
        if (!ui.qbItemId) continue;
        const res = await fetch(`/api/rmas/${receipt.rmaId}/items`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            qbItemId: ui.qbItemId,
            sku: ui.sku || ui.qbItemId,
            name: ui.name || ui.sku || ui.qbItemId,
            quantity: ui.quantity || "1",
            unitPrice: ui.unitPrice ?? "0",
            classification,
            listUnitPrice: ui.listUnitPrice,
            invoiceDiscountPct: ui.invoiceDiscountPct,
            originalInvoiceDocNumber: ui.originalInvoiceDocNumber,
            originalInvoiceDate: ui.originalInvoiceDate,
          }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(
            body.error ?? `Failed to add unexpected item (${res.status})`,
          );
        }
      }
      // Confirm the receipt — auto-advances sent_to_warehouse → received.
      const confirmRes = await fetch(
        `/api/rmas/extensiv-receipts/${receipt.receiptId}/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!confirmRes.ok) {
        const body = (await confirmRes.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${confirmRes.status}`);
      }
      return { rmaId: receipt.rmaId, customerId: receipt.rma.customerId };
    },
    onSuccess: (target) => {
      queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
      invalidateAfterRmaChange(queryClient, {
        rmaId: target.rmaId,
        customerId: target.customerId,
      });
      onOpenChange(false);
      onContinueToCreditMemo?.(target);
    },
  });

  const attachMutation = useMutation({
    mutationFn: async (rmaId: string) => {
      const res = await fetch(`/api/rmas/${rmaId}/attach-receipt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receiptId: receipt.receiptId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { rma?: { customerId?: string } };
      return { ...body, rmaId };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
      // Manual-match attaches a receipt to an existing RMA — same status
      // transition as confirm, so invalidate broadly.
      invalidateAfterRmaChange(queryClient, {
        rmaId: data.rmaId,
        customerId: data.rma?.customerId ?? null,
      });
      onDone();
      onOpenChange(false);
    },
  });

  const fromReceiptMutation = useMutation({
    mutationFn: async () => {
      if (!frCustomer) throw new Error("No customer selected");
      const res = await fetch("/api/rmas/from-receipt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          receiptId: receipt.receiptId,
          customerId: frCustomer.id,
          qbCustomerId: frCustomer.qbCustomerId,
          returnType: frReturnType,
          items: receipt.parsedItems.map((p) => ({
            qbItemId: "",
            sku: p.sku,
            name: p.sku,
            quantity: String(p.quantity),
            unitPrice: "0",
            classification: frReturnType === "damage" ? "damage" : "non_seasonal",
          })),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: (data: { rma?: { id?: string } }) => {
      queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
      // from-receipt creates a brand new RMA — global Returns list +
      // customer profile both need refresh.
      invalidateAfterRmaChange(queryClient, {
        rmaId: data.rma?.id ?? null,
        customerId: frCustomer?.id ?? null,
      });
      onDone();
      onOpenChange(false);
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/rmas/extensiv-receipts/${receipt.receiptId}/dismiss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
      onOpenChange(false);
    },
  });

  const isBusy =
    confirmMutation.isPending ||
    continueToCmMutation.isPending ||
    attachMutation.isPending ||
    fromReceiptMutation.isPending ||
    dismissMutation.isPending;

  // ---- Render helpers -----------------------------------------------------

  function matchKindLabel(kind: ReceiptRow["matchKind"]) {
    switch (kind) {
      case "exact_tx_number":
        return "Matched by TX#";
      case "exact_ref_string":
        return "Matched by ref string";
      case "fuzzy_customer_sku":
        return "Fuzzy match";
      case "no_match":
        return "Unmatched";
    }
  }

  // ---- Receipt review section (top) ----------------------------------------

  function ReceiptReviewSection() {
    if (isMatched && rmaQuery.data) {
      const items = rmaQuery.data.items;
      const totalDiscrepancies = items.filter((it) => {
        const approved = parseFloat(it.quantity);
        const received = parseFloat(receivedQty[it.id] ?? it.quantity);
        return Number.isFinite(approved) && Number.isFinite(received) &&
          approved !== received;
      }).length;
      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Receipt review</h3>
            {totalDiscrepancies > 0 ? (
              <Badge tone="high" className="text-xs">
                {totalDiscrepancies}{" "}
                {totalDiscrepancies === 1 ? "discrepancy" : "discrepancies"}
              </Badge>
            ) : (
              <span className="text-xs text-secondary">
                All items match approved qty
              </span>
            )}
          </div>
          <div className="overflow-x-auto rounded-md border border-default">
            <table className="w-full text-sm">
              <thead className="bg-subtle text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Item</th>
                  <th className="px-3 py-2 w-24 text-right">Expected</th>
                  <th className="px-3 py-2 w-28 text-right">Received</th>
                  <th className="px-3 py-2 w-32 text-right">Discrepancy</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {items.map((item) => {
                  const approved = parseFloat(item.quantity);
                  const received = parseFloat(
                    receivedQty[item.id] ?? item.quantity,
                  );
                  const delta =
                    Number.isFinite(approved) && Number.isFinite(received)
                      ? received - approved
                      : 0;
                  const isShort = delta < 0;
                  const isOver = delta > 0;
                  const rowTone =
                    isShort
                      ? "bg-accent-danger/5"
                      : isOver
                        ? "bg-accent-warning/5"
                        : "";
                  return (
                    <tr key={item.id} className={rowTone}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{item.name || "—"}</div>
                        <div className="text-xs text-muted font-mono">
                          {item.sku}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {Number.isFinite(approved)
                          ? approved.toFixed(0)
                          : item.quantity}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          className="w-20 text-sm text-right ml-auto"
                          value={receivedQty[item.id] ?? item.quantity}
                          onChange={(e) =>
                            setReceivedQty((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {isShort ? (
                          <Badge tone="critical" className="text-xs">
                            Short {Math.abs(delta).toFixed(0)}
                          </Badge>
                        ) : isOver ? (
                          <Badge tone="high" className="text-xs">
                            Over {delta.toFixed(0)}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted">
            Edits save when you click "Continue to credit memo" — the next
            dialog inherits these quantities for the credit memo lines.
          </p>

          {/* Unexpected items — each row shows what was picked, the
              looked-up price + original invoice (or a status pill), and
              an editable qty. Removing the row is just a filter. */}
          {unexpectedItems.map((ui) => (
            <div
              key={ui.key}
              className="rounded-md border border-default bg-subtle/30 p-2 space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1 text-sm">
                  <Badge tone="high" className="text-xs mr-1">
                    Unexpected
                  </Badge>
                  <span className="font-mono text-xs">
                    {ui.sku || "(no SKU)"}
                  </span>{" "}
                  <span className="text-secondary">{ui.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    className="w-20 text-sm"
                    value={ui.quantity}
                    onChange={(e) =>
                      setUnexpectedItems((prev) =>
                        prev.map((x) =>
                          x.key === ui.key
                            ? { ...x, quantity: e.target.value }
                            : x,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    className="text-secondary hover:text-current"
                    onClick={() =>
                      setUnexpectedItems((prev) =>
                        prev.filter((x) => x.key !== ui.key),
                      )
                    }
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-1 text-[11px] text-muted">
                {ui.lookupStatus === "pending" && (
                  <span>Looking up price + invoice…</span>
                )}
                {ui.lookupStatus === "error" && (
                  <span className="text-accent-danger">
                    {ui.lookupError ?? "Lookup failed"}
                  </span>
                )}
                {ui.lookupStatus !== "pending" &&
                  ui.lookupStatus !== "error" && (
                    <>
                      <span>
                        Price:{" "}
                        <span className="font-medium text-primary">
                          {ui.unitPrice
                            ? `$${parseFloat(ui.unitPrice).toFixed(2)}`
                            : "—"}
                        </span>
                      </span>
                      {ui.invoiceDiscountPct && (
                        <span className="text-accent-info">
                          {parseFloat(ui.invoiceDiscountPct)}% disc
                        </span>
                      )}
                      <span>
                        Orig. invoice:{" "}
                        <span className="font-medium text-primary">
                          {ui.originalInvoiceDocNumber
                            ? `#${ui.originalInvoiceDocNumber}`
                            : "—"}
                        </span>
                        {ui.originalInvoiceDate && (
                          <span className="ml-1">
                            {ui.originalInvoiceDate}
                          </span>
                        )}
                      </span>
                      {ui.lookupStatus === "done" && (
                        <button
                          type="button"
                          className="text-accent-info hover:underline"
                          onClick={() =>
                            void lookupPricesForUnexpected(
                              ui.key,
                              ui.qbItemId,
                            )
                          }
                        >
                          Re-lookup
                        </button>
                      )}
                    </>
                  )}
              </div>
            </div>
          ))}

          {showAddUnexpected ? (
            <div className="border rounded-md p-3 space-y-2 bg-muted/30">
              <p className="text-xs font-medium text-secondary">
                Add unexpected item
              </p>
              <QboItemPicker
                onPick={(hit: QbItemHit) => {
                  const key = `unexpected-${Date.now()}`;
                  const seedPrice =
                    hit.unitPrice != null ? hit.unitPrice.toFixed(4) : null;
                  setUnexpectedItems((prev) => [
                    ...prev,
                    {
                      key,
                      qbItemId: hit.id,
                      sku: hit.sku ?? "",
                      name: hit.name,
                      quantity: "1",
                      unitPrice: seedPrice,
                      listUnitPrice: seedPrice,
                      invoiceDiscountPct: null,
                      originalInvoiceDocNumber: null,
                      originalInvoiceDate: null,
                      lookupStatus: "idle",
                      lookupError: null,
                    },
                  ]);
                  setShowAddUnexpected(false);
                  // Fire price + invoice lookup so the operator gets the
                  // customer-specific price (with discount) and the most
                  // recent invoice that carried this item.
                  void lookupPricesForUnexpected(key, hit.id);
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAddUnexpected(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => setShowAddUnexpected(true)}
            >
              <Plus size={12} className="mr-1" />
              Add unexpected item
            </Button>
          )}
        </div>
      );
    }

    // Unmatched: show parsed items only
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Receipt Items (unmatched)</h3>
        {receipt.parsedItems.length === 0 ? (
          <p className="text-sm text-secondary italic">No items parsed from this receipt.</p>
        ) : (
          receipt.parsedItems.map((p) => (
            <div key={p.sku} className="flex items-center justify-between text-sm">
              <span className="font-mono text-xs">{p.sku}</span>
              <span className="text-secondary">×{p.quantity}</span>
            </div>
          ))
        )}
      </div>
    );
  }

  // ---- Manual match panel (unmatched) -------------------------------------

  function ManualMatchPanel() {
    if (!showManualMatch) return null;
    return (
      <div className="border rounded-md p-4 space-y-3 bg-muted/20">
        <h4 className="text-sm font-medium">Pick an RMA in "sent to warehouse" status</h4>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-secondary" />
          <Input
            placeholder="Search by RMA#…"
            className="pl-8 text-sm"
            value={rmaSearchQ}
            onChange={(e) => setRmaSearchQ(e.target.value)}
          />
        </div>
        {rmaListQuery.isPending && (
          <p className="text-sm text-secondary">Loading…</p>
        )}
        <div className="max-h-40 overflow-y-auto space-y-1">
          {filteredRmas.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between px-3 py-2 rounded hover:bg-muted cursor-pointer text-sm"
              onClick={() => attachMutation.mutate(r.id)}
            >
              <span className="font-mono">{r.rmaNumber ?? r.id}</span>
              <Badge tone="info" className="text-xs">
                {r.status}
              </Badge>
            </div>
          ))}
          {!rmaListQuery.isPending && filteredRmas.length === 0 && (
            <p className="text-sm text-secondary italic px-3">No matching RMAs found.</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowManualMatch(false)}>
          Cancel
        </Button>
      </div>
    );
  }

  // ---- Create-from-receipt panel (unmatched) --------------------------------

  function FromReceiptPanel() {
    if (!showFromReceipt) return null;
    return (
      <div className="border rounded-md p-4 space-y-3 bg-muted/20">
        <h4 className="text-sm font-medium">Create new RMA from this receipt</h4>

        {/* Return type selector */}
        <div>
          <label className="text-xs font-medium text-secondary">Return type</label>
          <div className="flex gap-2 mt-1">
            {(["damage", "seasonal", "non_seasonal"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`px-3 py-1 rounded text-xs border transition-colors ${
                  frReturnType === t
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-input hover:bg-muted"
                }`}
                onClick={() => setFrReturnType(t)}
              >
                {t === "non_seasonal" ? "Non-seasonal" : t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Customer picker */}
        <div>
          <label className="text-xs font-medium text-secondary">Customer</label>
          {frCustomer ? (
            <div className="flex items-center gap-2 mt-2 text-sm">
              <CheckCircle2 size={14} className="text-green-600" />
              <span>{frCustomer.displayName}</span>
              <button
                type="button"
                className="text-secondary"
                onClick={() => setFrCustomer(null)}
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <>
              <div className="relative mt-1">
                <Input
                  placeholder="Search customers (min 2 chars)…"
                  className="text-sm"
                  value={frCustomerSearch}
                  onChange={(e) => setFrCustomerSearch(e.target.value)}
                />
                {frCustomerSearch.trim().length >= 2 && (
                  <div className="mt-1 max-h-48 overflow-y-auto rounded-md border border-default bg-base">
                    {frCustomerQuery.isPending && (
                      <p className="px-3 py-2 text-xs text-secondary">
                        Searching…
                      </p>
                    )}
                    {!frCustomerQuery.isPending &&
                      (frCustomerQuery.data?.customers ?? []).length === 0 && (
                        <p className="px-3 py-2 text-xs text-secondary italic">
                          No matches.
                        </p>
                      )}
                    {(frCustomerQuery.data?.customers ?? []).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        disabled={!c.qbCustomerId}
                        onClick={() => {
                          if (!c.qbCustomerId) return;
                          setFrCustomer({
                            id: c.id,
                            name: c.displayName,
                            displayName: c.displayName,
                            qbCustomerId: c.qbCustomerId,
                          });
                          setFrCustomerSearch("");
                        }}
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <div className="font-medium">{c.displayName}</div>
                        {c.primaryEmail && (
                          <div className="text-xs text-secondary">
                            {c.primaryEmail}
                          </div>
                        )}
                        {!c.qbCustomerId && (
                          <div className="text-xs text-accent-warning">
                            No QBO customer ID — cannot create RMA
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {receipt.inferredCustomerName && (
                <p className="text-xs text-secondary mt-1">
                  Suggested: {receipt.inferredCustomerName}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!frCustomer || fromReceiptMutation.isPending}
            onClick={() => fromReceiptMutation.mutate()}
          >
            {fromReceiptMutation.isPending ? "Creating…" : "Create RMA"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowFromReceipt(false)}>
            Cancel
          </Button>
        </div>

        {fromReceiptMutation.isError && (
          <p className="text-xs text-red-600">
            {(fromReceiptMutation.error as Error).message}
          </p>
        )}
      </div>
    );
  }

  // ---- Footer buttons ------------------------------------------------------

  function FooterButtons() {
    if (isMatched) {
      const canContinue =
        !!rmaQuery.data &&
        !!receipt.rma?.customerId &&
        !isBusy;
      return (
        <>
          <Button
            variant="secondary"
            disabled={isBusy}
            onClick={() => confirmMutation.mutate()}
          >
            {confirmMutation.isPending ? "Saving…" : "Save receipt only"}
          </Button>
          <Button
            variant="primary"
            disabled={!canContinue}
            onClick={() => continueToCmMutation.mutate()}
          >
            {continueToCmMutation.isPending
              ? "Saving…"
              : "Continue to credit memo →"}
          </Button>
        </>
      );
    }

    return (
      <>
        <Button
          variant="ghost"
          size="sm"
          disabled={isBusy}
          onClick={() => {
            setShowFromReceipt(false);
            setShowManualMatch((prev) => !prev);
          }}
        >
          Manual match
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={isBusy}
          onClick={() => {
            setShowManualMatch(false);
            setShowFromReceipt((prev) => !prev);
          }}
        >
          Create RMA from receipt
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={isBusy}
          onClick={() => dismissMutation.mutate()}
        >
          {dismissMutation.isPending ? "Dismissing…" : "Dismiss — not a return"}
        </Button>
      </>
    );
  }

  // ---- Main render ---------------------------------------------------------

  const title = isMatched
    ? `Receipt — ${receipt.rma?.rmaNumber ?? receipt.rmaId}`
    : "Unmatched Receipt";

  const description = isMatched
    ? `${receipt.rma?.customerName ?? "Unknown customer"} · ${matchKindLabel(receipt.matchKind)}`
    : `${receipt.inferredCustomerName ?? "Unknown"} · ${receipt.txNumber ?? receipt.refString ?? "no ref"} · ${receipt.parsedItems.length} item(s)`;

  const mutationError =
    confirmMutation.error ??
    continueToCmMutation.error ??
    attachMutation.error ??
    dismissMutation.error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Match confidence badge */}
        <div className="flex items-center gap-2 text-xs">
          <Badge
            tone={
              receipt.matchKind === "exact_tx_number" || receipt.matchKind === "exact_ref_string"
                ? "success"
                : receipt.matchKind === "fuzzy_customer_sku"
                  ? "high"
                  : "neutral"
            }
          >
            {matchKindLabel(receipt.matchKind)}
          </Badge>
          {receipt.txNumber && (
            <span className="text-secondary font-mono">TX# {receipt.txNumber}</span>
          )}
          {receipt.refString && (
            <span className="text-secondary">Ref: {receipt.refString}</span>
          )}
          <span className="text-secondary">
            Classified {new Date(receipt.classifiedAt).toLocaleDateString()}
          </span>
        </div>

        {/* Top section: receipt review.
            Note: invoked as a function call ({ReceiptReviewSection()}),
            not as a JSX component (<ReceiptReviewSection />). The
            functions are defined inside this component's body and
            close over local state — every parent re-render produces a
            new function reference. As JSX components React would
            reconcile each as a brand-new element type, unmount + remount
            the subtree, and inputs would lose focus on every keystroke
            (operator-reported: "Add unexpected item" needed a click
            after each character). Calling them as functions keeps the
            returned JSX inline with the parent's render tree so element
            identity stays stable. Same fix applies to all four panels.
        */}
        <div className="mt-4">{ReceiptReviewSection()}</div>

        {/* Manual match / from-receipt panels (unmatched path) */}
        {!isMatched && (
          <div className="mt-4 space-y-3">
            {ManualMatchPanel()}
            {FromReceiptPanel()}
          </div>
        )}

        {/* Error display */}
        {mutationError && (
          <div className="flex items-center gap-2 text-sm text-red-600 mt-2">
            <AlertCircle size={14} />
            {(mutationError as Error).message}
          </div>
        )}

        <DialogFooter className="mt-6 flex flex-wrap gap-2">
          {FooterButtons()}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
