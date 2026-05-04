// return-receipt-review-dialog.tsx
//
// Single-dialog flow for reviewing an Extensiv warehouse return receipt.
//
// Two scroll sections:
//   TOP: Receipt review — side-by-side approved (RMA items) vs received (editable).
//   BOTTOM: Credit memo editor (only when matched to an RMA).
//
// Bottom action bar adapts to matched vs unmatched receipts:
//   Matched:   [Save Receipt Only] / [Send Credit Memo & Email]
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ParsedItem = { sku: string; quantity: number };

type RmaSummary = {
  id: string;
  rmaNumber: string | null;
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
  returnType: string;
  status: string;
  items: RmaItem[];
};

type PreviewResponse = {
  subject: string;
  body: string;
  recipients: { to: string; cc: string; bcc: string };
  bccReasons: Array<{ tag: string; address: string }>;
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

// Per-item received quantity state key is rma_item_id
type ReceivedQtyMap = Record<string, string>;

// An unexpected item (not on the RMA) that was received
type UnexpectedItem = {
  key: string;
  sku: string;
  name: string;
  quantity: string;
};

export type ReturnReceiptReviewDialogProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  receipt: ReceiptRow;
  onDone: () => void;
};

// ---------------------------------------------------------------------------
// Main dialog component
// ---------------------------------------------------------------------------

export default function ReturnReceiptReviewDialog({
  open,
  onOpenChange,
  receipt,
  onDone,
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
  const [newItemSku, setNewItemSku] = useState("");
  const [newItemName, setNewItemName] = useState("");
  const [newItemQty, setNewItemQty] = useState("1");

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
      setShippingDeduction("0.00");
      setRestockingFee("0.00");
      setEdited(false);
      setShowManualMatch(false);
      setShowFromReceipt(false);
      setRmaSearchQ("");
    }
  }, [open]);

  // ---- CM editor state (matched receipts) ---------------------------------
  const [shippingDeduction, setShippingDeduction] = useState("0.00");
  const [restockingFee, setRestockingFee] = useState("0.00");
  const [edited, setEdited] = useState(false);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");

  const itemOverrides = useMemo(() => {
    if (!rmaQuery.data) return [];
    return rmaQuery.data.items.map((item) => ({
      itemId: item.id,
      receivedQuantity: receivedQty[item.id] ?? item.quantity,
    }));
  }, [rmaQuery.data, receivedQty]);

  const goodsSubtotal = useMemo(() => {
    if (!rmaQuery.data) return 0;
    return rmaQuery.data.items.reduce((sum, item) => {
      const qty = parseFloat(receivedQty[item.id] ?? item.quantity) || 0;
      const price = parseFloat(item.unitPrice) || 0;
      return sum + qty * price;
    }, 0);
  }, [rmaQuery.data, receivedQty]);

  const totalCreditAmount = useMemo(() => {
    const ship = parseFloat(shippingDeduction) || 0;
    const restock = parseFloat(restockingFee) || 0;
    return Math.max(0, goodsSubtotal - ship - restock);
  }, [goodsSubtotal, shippingDeduction, restockingFee]);

  // Email preview query (when matched + CM section visible)
  const previewQuery = useQuery<PreviewResponse>({
    enabled: open && isMatched && !!rmaQuery.data,
    queryKey: [
      "rma-credit-memo-preview",
      receipt.rmaId,
      shippingDeduction,
      restockingFee,
      JSON.stringify(itemOverrides),
    ],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${receipt.rmaId}/preview-credit-memo-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shippingDeduction: shippingDeduction || undefined,
          restockingFee: restockingFee || undefined,
          itemOverrides,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 0,
  });

  // Sync email subject/body from preview
  useEffect(() => {
    if (previewQuery.data && !edited) {
      setEmailSubject(previewQuery.data.subject);
      setEmailBody(previewQuery.data.body);
    }
  }, [previewQuery.data, edited]);

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
      onDone();
      onOpenChange(false);
    },
  });

  const issueCmMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/rmas/${receipt.rmaId}/issue-credit-memo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shippingDeduction: shippingDeduction || undefined,
          restockingFee: restockingFee || undefined,
          itemOverrides,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Also confirm the receipt so it disappears from /today
      await fetch(`/api/rmas/extensiv-receipts/${receipt.receiptId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
      queryClient.invalidateQueries({ queryKey: ["rma", receipt.rmaId] });
      onDone();
      onOpenChange(false);
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
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invoicing", "today"] });
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
    issueCmMutation.isPending ||
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
      return (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Receipt Review</h3>
          <div className="grid grid-cols-2 gap-2 text-xs text-secondary font-medium pb-1 border-b">
            <span>Approved (RMA)</span>
            <span>Received (edit if different)</span>
          </div>
          {items.map((item) => {
            const approved = parseFloat(item.quantity);
            const received = parseFloat(receivedQty[item.id] ?? item.quantity);
            const discrepancy = received !== approved;
            return (
              <div key={item.id} className="grid grid-cols-2 gap-2 items-center">
                <div className="text-sm">
                  <span className="font-mono text-xs">{item.sku}</span>{" "}
                  <span className="text-secondary">{item.name}</span>
                  <span className="ml-2 text-secondary">×{item.quantity}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    className="w-20 text-sm"
                    value={receivedQty[item.id] ?? item.quantity}
                    onChange={(e) =>
                      setReceivedQty((prev) => ({ ...prev, [item.id]: e.target.value }))
                    }
                  />
                  {discrepancy && (
                    <Badge tone="high" className="text-xs">
                      {received < approved ? `Short ${approved - received}` : `Over ${received - approved}`}
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}

          {/* Unexpected items */}
          {unexpectedItems.map((ui) => (
            <div key={ui.key} className="grid grid-cols-2 gap-2 items-center">
              <div className="text-sm">
                <Badge tone="high" className="text-xs mr-1">Unexpected</Badge>
                <span className="font-mono text-xs">{ui.sku || "(no SKU)"}</span>
                {" "}<span className="text-secondary">{ui.name}</span>
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
                      prev.map((x) => (x.key === ui.key ? { ...x, quantity: e.target.value } : x)),
                    )
                  }
                />
                <button
                  type="button"
                  className="text-secondary hover:text-current"
                  onClick={() =>
                    setUnexpectedItems((prev) => prev.filter((x) => x.key !== ui.key))
                  }
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}

          {showAddUnexpected ? (
            <div className="border rounded-md p-3 space-y-2 bg-muted/30">
              <p className="text-xs font-medium text-secondary">Add unexpected item</p>
              <div className="flex gap-2">
                <Input
                  placeholder="SKU"
                  className="w-28 text-sm"
                  value={newItemSku}
                  onChange={(e) => setNewItemSku(e.target.value)}
                />
                <Input
                  placeholder="Name"
                  className="flex-1 text-sm"
                  value={newItemName}
                  onChange={(e) => setNewItemName(e.target.value)}
                />
                <Input
                  type="number"
                  min="1"
                  placeholder="Qty"
                  className="w-16 text-sm"
                  value={newItemQty}
                  onChange={(e) => setNewItemQty(e.target.value)}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setUnexpectedItems((prev) => [
                      ...prev,
                      {
                        key: `unexpected-${Date.now()}`,
                        sku: newItemSku,
                        name: newItemName,
                        quantity: newItemQty,
                      },
                    ]);
                    setNewItemSku("");
                    setNewItemName("");
                    setNewItemQty("1");
                    setShowAddUnexpected(false);
                  }}
                >
                  Add
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAddUnexpected(false)}
                >
                  Cancel
                </Button>
              </div>
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

  // ---- Credit memo section (bottom, matched only) -------------------------

  function CreditMemoSection() {
    if (!isMatched || !rmaQuery.data) return null;
    return (
      <div className="space-y-4 pt-4 border-t">
        <h3 className="text-sm font-semibold">Credit Memo</h3>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium text-secondary">Shipping deduction ($)</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              className="mt-1"
              value={shippingDeduction}
              onChange={(e) => {
                setShippingDeduction(e.target.value);
                setEdited(true);
              }}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-secondary">Restocking fee ($)</label>
            <Input
              type="number"
              min="0"
              step="0.01"
              className="mt-1"
              value={restockingFee}
              onChange={(e) => {
                setRestockingFee(e.target.value);
                setEdited(true);
              }}
            />
          </div>
        </div>

        <div className="rounded-md bg-muted/40 px-4 py-3 text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-secondary">Goods subtotal</span>
            <span>${goodsSubtotal.toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-secondary">
            <span>Shipping deduction</span>
            <span>−${(parseFloat(shippingDeduction) || 0).toFixed(2)}</span>
          </div>
          <div className="flex justify-between text-secondary">
            <span>Restocking fee</span>
            <span>−${(parseFloat(restockingFee) || 0).toFixed(2)}</span>
          </div>
          <div className="flex justify-between font-semibold border-t pt-1 mt-1">
            <span>Total credit</span>
            <span>${totalCreditAmount.toFixed(2)}</span>
          </div>
        </div>

        {/* Email preview */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-secondary">Email subject</label>
          <Input
            value={emailSubject}
            onChange={(e) => {
              setEmailSubject(e.target.value);
              setEdited(true);
            }}
          />
          <label className="text-xs font-medium text-secondary">Email body</label>
          <textarea
            className="w-full min-h-[120px] rounded-md border border-input bg-background px-3 py-2 text-sm resize-y"
            value={emailBody}
            onChange={(e) => {
              setEmailBody(e.target.value);
              setEdited(true);
            }}
          />
          {previewQuery.data && (
            <div className="text-xs text-secondary">
              To: {previewQuery.data.recipients.to}
              {previewQuery.data.recipients.cc && ` · CC: ${previewQuery.data.recipients.cc}`}
            </div>
          )}
        </div>
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
          <div className="flex gap-2 mt-1">
            <Input
              placeholder="Search customers…"
              className="flex-1 text-sm"
              value={frCustomerSearch}
              onChange={(e) => setFrCustomerSearch(e.target.value)}
            />
          </div>
          {frCustomer && (
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
          )}
          {receipt.inferredCustomerName && !frCustomer && (
            <p className="text-xs text-secondary mt-1">
              Suggested: {receipt.inferredCustomerName}
            </p>
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
      return (
        <>
          <Button
            variant="secondary"
            disabled={isBusy}
            onClick={() => confirmMutation.mutate()}
          >
            {confirmMutation.isPending ? "Saving…" : "Save Receipt Only"}
          </Button>
          <Button
            variant="primary"
            disabled={isBusy || !rmaQuery.data}
            onClick={() => issueCmMutation.mutate()}
          >
            {issueCmMutation.isPending ? "Sending…" : "Send Credit Memo & Email"}
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
    issueCmMutation.error ??
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

        {/* Top section: receipt review */}
        <div className="mt-4">
          <ReceiptReviewSection />
        </div>

        {/* Manual match / from-receipt panels (unmatched path) */}
        {!isMatched && (
          <div className="mt-4 space-y-3">
            <ManualMatchPanel />
            <FromReceiptPanel />
          </div>
        )}

        {/* Bottom section: CM editor (matched path) */}
        {isMatched && (
          <div className="mt-2">
            <CreditMemoSection />
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
          <FooterButtons />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
