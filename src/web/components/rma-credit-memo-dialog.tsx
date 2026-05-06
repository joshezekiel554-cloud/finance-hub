// RmaCreditMemoDialog — credit memo editor + email send dialog.
// Opened from [Issue Credit Memo] on the RMA detail action panel.
//
// Flow:
//   1. Fetch RMA + items (GET /api/rmas/:id)
//   2. Operator reviews items, edits receivedQuantity per row
//   3. Enters shipping deduction + restocking fee
//   4. Live-computed goodsSubtotal + totalCreditAmount shown
//   5. Preview email (POST /api/rmas/:id/preview-credit-memo-email) feeds
//      editable subject + body
//   6. Send: POST /api/rmas/:id/issue-credit-memo, then POST /api/send

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, AlertCircle } from "lucide-react";
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
import { cn } from "../lib/cn";
import { invalidateAfterRmaChange } from "../lib/invalidate-rma";

// ---- Types ------------------------------------------------------------------

type RmaItem = {
  id: string;
  qbItemId: string;
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

type SourceInvoiceTaxStatus = {
  hadTax: boolean;
  ratePercent: number;
  taxCodeRef: string | null;
};

// Per-row override for received quantity
type ReceivedQtyMap = Record<string, string>;

export type RmaCreditMemoDialogProps = {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  rmaId: string;
  customerId: string;
  onIssued: () => void;
};

export default function RmaCreditMemoDialog({
  open,
  onOpenChange,
  rmaId,
  customerId,
  onIssued,
}: RmaCreditMemoDialogProps) {
  const queryClient = useQueryClient();

  // Fetch RMA + items
  const rmaQuery = useQuery<RmaDetail>({
    enabled: open,
    queryKey: ["rma", rmaId],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 0,
  });

  // --- CM editor state ---
  const [receivedQty, setReceivedQty] = useState<ReceivedQtyMap>({});
  const [shippingDeduction, setShippingDeduction] = useState("0.00");
  const [restockingFee, setRestockingFee] = useState("0.00");
  // Sales tax. Defaulted from the source invoice lookup — checked when any
  // source invoice was taxed, unchecked otherwise. Operator can override.
  // applyTaxTouched gates the auto-default so we don't fight the operator
  // after they manually toggle the box.
  const [applyTax, setApplyTax] = useState(false);
  const [applyTaxTouched, setApplyTaxTouched] = useState(false);

  // Look up whether the source invoice(s) for this RMA were taxed in QBO.
  // The dialog uses this to seed the checkbox + show the rate in the totals.
  const taxStatusQuery = useQuery<SourceInvoiceTaxStatus>({
    enabled: open,
    queryKey: ["rma-source-invoice-tax", rmaId],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/source-invoice-tax`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
  });

  // Auto-seed applyTax from the lookup until the operator manually toggles.
  useEffect(() => {
    if (applyTaxTouched) return;
    const status = taxStatusQuery.data;
    if (!status) return;
    setApplyTax(status.hadTax);
  }, [taxStatusQuery.data, applyTaxTouched]);

  // Seed received quantities from item data when dialog opens
  useEffect(() => {
    if (!open) return;
    const items = rmaQuery.data?.items ?? [];
    if (items.length === 0) return;
    setReceivedQty((prev) => {
      const next: ReceivedQtyMap = {};
      for (const item of items) {
        // Default: use stored receivedQuantity, fall back to quantity
        next[item.id] =
          prev[item.id] ??
          item.receivedQuantity ??
          item.quantity;
      }
      return next;
    });
  }, [open, rmaQuery.data?.items]);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setReceivedQty({});
      setShippingDeduction("0.00");
      setRestockingFee("0.00");
      setApplyTax(false);
      setApplyTaxTouched(false);
      setEdited(false);
    }
  }, [open]);

  // Computed totals
  const goodsSubtotal = useMemo(() => {
    const items = rmaQuery.data?.items ?? [];
    return items.reduce((sum, item) => {
      const qty = parseFloat(receivedQty[item.id] ?? item.quantity) || 0;
      const price = parseFloat(item.unitPrice) || 0;
      return sum + qty * price;
    }, 0);
  }, [rmaQuery.data?.items, receivedQty]);

  // Sales tax applied to the post-deduction taxable base. The rate comes
  // from the source invoice lookup; QBO will recompute the exact amount
  // server-side from the tax code's current rate when the CM is created.
  const ratePercent = taxStatusQuery.data?.ratePercent ?? 0;
  const salesTaxAmount = useMemo(() => {
    if (!applyTax) return 0;
    const ship = parseFloat(shippingDeduction) || 0;
    const restock = parseFloat(restockingFee) || 0;
    const taxableBase = Math.max(0, goodsSubtotal - ship - restock);
    return taxableBase * (ratePercent / 100);
  }, [applyTax, ratePercent, goodsSubtotal, shippingDeduction, restockingFee]);

  const totalCreditAmount = useMemo(() => {
    const ship = parseFloat(shippingDeduction) || 0;
    const restock = parseFloat(restockingFee) || 0;
    return Math.max(0, goodsSubtotal - ship - restock + salesTaxAmount);
  }, [goodsSubtotal, shippingDeduction, restockingFee, salesTaxAmount]);

  // --- Email preview ---
  const itemOverrides = useMemo(() => {
    return Object.entries(receivedQty).map(([itemId, qty]) => ({
      itemId,
      receivedQuantity: qty,
    }));
  }, [receivedQty]);

  const previewQuery = useQuery<PreviewResponse>({
    enabled: open && !!rmaQuery.data,
    queryKey: [
      "rma-credit-memo-preview",
      rmaId,
      shippingDeduction,
      restockingFee,
      applyTax,
      ratePercent,
      JSON.stringify(itemOverrides),
    ],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/preview-credit-memo-email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shippingDeduction: shippingDeduction || undefined,
          restockingFee: restockingFee || undefined,
          itemOverrides,
          applyTax,
          salesTaxRatePercent: ratePercent,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        let parsed: { error?: string } | null = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not json */
        }
        throw new Error(parsed?.error ?? text ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    staleTime: 0,
  });

  // --- Editable email fields ---
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [edited, setEdited] = useState(false);

  useEffect(() => {
    if (edited) return;
    const d = previewQuery.data;
    if (!d) return;
    setSubject(d.subject);
    setBody(d.body);
    setTo(d.recipients.to);
    setCc(d.recipients.cc);
    setBcc(d.recipients.bcc);
  }, [previewQuery.data, edited]);

  // --- Send mutation ---
  const sendMutation = useMutation<unknown, Error, void>({
    mutationFn: async () => {
      if (!to.trim()) throw new Error("TO recipient is required");

      // Step 1: issue the credit memo in QBO + complete RMA. The route
      // returns the updated Rma, including qboCreditMemoId + creditMemoDocNumber
      // which we need to fetch the PDF for the email attachment.
      const issueRes = await fetch(`/api/rmas/${rmaId}/issue-credit-memo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shippingDeduction: shippingDeduction || undefined,
          restockingFee: restockingFee || undefined,
          itemOverrides,
          applyTax,
          taxCodeRef: taxStatusQuery.data?.taxCodeRef ?? null,
        }),
      });
      if (!issueRes.ok) {
        // Server's error envelope is { error: <code>, message: <reason> }.
        // Prefer the underlying message — "bad_request" alone tells the
        // operator nothing about what to fix.
        const data = (await issueRes
          .json()
          .catch(() => ({}))) as { error?: string; message?: string };
        const reason =
          data.message ?? data.error ?? `HTTP ${issueRes.status}`;
        throw new Error(`Issue CM failed: ${reason}`);
      }
      const issued = (await issueRes.json()) as {
        qboCreditMemoId?: string | null;
        creditMemoDocNumber?: string | null;
      };

      // Step 2: fetch the QBO credit memo PDF so we can attach it to the
      // email. Skip silently if the issue route didn't return a qbo id (this
      // shouldn't happen on the happy path, but we'd rather send the email
      // without an attachment than 502 the whole flow).
      let attachments: Array<{
        filename: string;
        mimeType: string;
        dataBase64: string;
      }> | undefined;
      if (issued.qboCreditMemoId) {
        const pdfRes = await fetch(
          `/api/qb-pdf/creditmemo/${encodeURIComponent(issued.qboCreditMemoId)}`,
        );
        if (!pdfRes.ok) {
          throw new Error(`Failed to fetch credit memo PDF (HTTP ${pdfRes.status})`);
        }
        const pdfBlob = await pdfRes.blob();
        const dataBase64 = await blobToBase64(pdfBlob);
        const docNum = issued.creditMemoDocNumber ?? issued.qboCreditMemoId;
        attachments = [
          {
            filename: `credit-memo-${docNum}.pdf`,
            mimeType: "application/pdf",
            dataBase64,
          },
        ];
      }

      // Step 3: send the email with the PDF attached.
      const sendRes = await fetch("/api/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          to,
          cc: cc.trim() || undefined,
          bcc: bcc.trim() || undefined,
          subject,
          body,
          customerId,
          refType: "rma",
          refId: rmaId,
          attachments,
        }),
      });
      if (!sendRes.ok) {
        const text = await sendRes.text();
        let parsed: { error?: string } | null = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not json */
        }
        throw new Error(parsed?.error ?? text ?? `HTTP ${sendRes.status}`);
      }
      return sendRes.json();
    },
    onSuccess: () => {
      invalidateAfterRmaChange(queryClient, { rmaId, customerId });
      onIssued();
      onOpenChange(false);
    },
  });

  const rma = rmaQuery.data;
  const items = rma?.items ?? [];

  // Items imported from the desktop app have an empty qbItemId because the
  // old data only carried SKU. QBO will reject any CreditMemo payload whose
  // line is missing ItemRef.value, so we have to block submission here and
  // tell the operator how to fix it (revert to draft, walk the items step
  // to pick the real QBO item, then come back).
  const unresolvedItems = items.filter((it) => !it.qbItemId);
  const hasUnresolvedItems = unresolvedItems.length > 0;

  const canSend =
    !sendMutation.isPending &&
    !rmaQuery.isPending &&
    !hasUnresolvedItems &&
    to.trim().length > 0 &&
    subject.trim().length > 0 &&
    body.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Issue credit memo — RMA {rma?.rmaNumber ?? rmaId}
          </DialogTitle>
          <DialogDescription>
            Review items and deductions, then send the credit memo email.
          </DialogDescription>
        </DialogHeader>

        {rmaQuery.isPending ? (
          <div className="py-6 text-center text-sm text-muted">
            Loading RMA data…
          </div>
        ) : rmaQuery.isError ? (
          <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {(rmaQuery.error as Error)?.message ?? "Failed to load RMA"}
          </div>
        ) : (
          <div className="mt-2 space-y-5">
            {/* ---- Section 1: Items review ---- */}
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Items
              </h3>

              {hasUnresolvedItems && (
                <div className="mb-2 flex items-start gap-2 rounded-md border border-accent-warning/40 bg-accent-warning/5 px-3 py-2 text-xs">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-accent-warning" />
                  <div className="flex-1 space-y-1">
                    <div className="font-medium text-accent-warning">
                      {unresolvedItems.length}{" "}
                      {unresolvedItems.length === 1 ? "item" : "items"} not
                      linked to QBO yet
                    </div>
                    <div className="text-secondary">
                      Imported RMAs have items with SKU only. QBO needs a
                      proper Item link before a credit memo can be created.
                      To fix: close this dialog → click <em>Edit (revert to
                      draft)</em> on the right rail → walk through the wizard
                      Items step (the picker will appear pre-filled with the
                      SKU) → resolve each item → re-approve.
                    </div>
                    <ul className="ml-3 list-disc text-muted">
                      {unresolvedItems.map((it) => (
                        <li key={it.id}>
                          <span className="font-mono">{it.sku || "—"}</span>
                          {it.name ? ` · ${it.name}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              <div className="overflow-x-auto rounded-md border border-default">
                <table className="w-full text-sm">
                  <thead className="border-b border-default bg-subtle text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-2">Item</th>
                      <th className="px-3 py-2 w-20 text-right">Ordered</th>
                      <th className="px-3 py-2 w-24 text-right">Received</th>
                      <th className="px-3 py-2 w-28 text-right">Unit price</th>
                      <th className="px-3 py-2 w-28 text-right">Line total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-default">
                    {items.map((item) => {
                      const ordered = parseFloat(item.quantity) || 0;
                      const rcvd = parseFloat(receivedQty[item.id] ?? item.quantity) || 0;
                      const price = parseFloat(item.unitPrice) || 0;
                      const lineTotal = rcvd * price;
                      // Over-receipt warning: operator typed a received qty
                      // larger than what was approved. Soft warning (not a
                      // block) — there are legitimate reasons (replacement
                      // sent back as well as the original) but it's almost
                      // always a typo, and crediting more than approved is
                      // a real money risk.
                      const overReceived = rcvd > ordered;
                      return (
                        <tr key={item.id}>
                          <td className="px-3 py-2">
                            <div className="font-medium">{item.name}</div>
                            <div className="text-xs text-muted">{item.sku}</div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {ordered.toFixed(0)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              min="0"
                              max={ordered}
                              step="0.0001"
                              value={receivedQty[item.id] ?? item.quantity}
                              onChange={(e) =>
                                setReceivedQty((prev) => ({
                                  ...prev,
                                  [item.id]: e.target.value,
                                }))
                              }
                              className={cn(
                                "w-20 rounded-md border bg-base px-2 py-1 text-right text-sm",
                                overReceived
                                  ? "border-accent-warning"
                                  : "border-default",
                              )}
                              aria-invalid={overReceived || undefined}
                            />
                            {overReceived && (
                              <div
                                className="mt-0.5 text-[10px] text-accent-warning text-right"
                                title={`Received ${rcvd} > approved ${ordered}`}
                              >
                                &gt; approved
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            ${price.toFixed(2)}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums font-medium">
                            ${lineTotal.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                    {items.length === 0 && (
                      <tr>
                        <td
                          className="p-4 text-center text-sm text-muted"
                          colSpan={5}
                        >
                          No items on this RMA
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* ---- Section 2: CM editor / deductions ---- */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Credit memo
              </h3>

              <div className="rounded-md border border-default bg-subtle p-3 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-secondary">Goods subtotal</span>
                  <span className="tabular-nums font-medium">
                    ${goodsSubtotal.toFixed(2)}
                  </span>
                </div>

                <div className="flex items-center justify-between">
                  <label className="text-secondary">
                    Return shipping deducted
                  </label>
                  <div className="flex items-center gap-1">
                    <span className="text-muted">−$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={shippingDeduction}
                      onChange={(e) => setShippingDeduction(e.target.value)}
                      className="w-24 rounded-md border border-default bg-base px-2 py-1 text-right text-sm"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <label className="text-secondary">Restocking fee</label>
                  <div className="flex items-center gap-1">
                    <span className="text-muted">−$</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={restockingFee}
                      onChange={(e) => setRestockingFee(e.target.value)}
                      className="w-24 rounded-md border border-default bg-base px-2 py-1 text-right text-sm"
                    />
                  </div>
                </div>

                {/* Sales tax checkbox + computed amount. The default is set
                    from the source-invoice-tax lookup; operator can override.
                    The amount shown is an estimate from the source rate —
                    QBO recomputes the exact amount on the credit memo. */}
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-secondary">
                    <input
                      type="checkbox"
                      checked={applyTax}
                      onChange={(e) => {
                        setApplyTax(e.target.checked);
                        setApplyTaxTouched(true);
                      }}
                      disabled={taxStatusQuery.isPending}
                    />
                    <span>
                      Sales tax
                      {ratePercent > 0 && (
                        <span className="ml-1 text-xs text-muted">
                          (≈{ratePercent.toFixed(2)}%)
                        </span>
                      )}
                    </span>
                  </label>
                  <span
                    className={
                      applyTax
                        ? "tabular-nums"
                        : "tabular-nums text-muted"
                    }
                  >
                    {applyTax ? `$${salesTaxAmount.toFixed(2)}` : "—"}
                  </span>
                </div>

                <div className="border-t border-default pt-2 flex items-center justify-between font-semibold">
                  <span>Total credit</span>
                  <span className="tabular-nums text-success">
                    ${totalCreditAmount.toFixed(2)}
                  </span>
                </div>
              </div>
            </section>

            {/* ---- Section 3: Email preview ---- */}
            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Email
              </h3>

              {previewQuery.isPending ? (
                <div className="py-2 text-center text-sm text-muted">
                  Loading email preview…
                </div>
              ) : previewQuery.isError ? (
                <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  {(previewQuery.error as Error)?.message ?? "Preview failed"}
                </div>
              ) : (
                <>
                  <RecipientField
                    label="TO"
                    value={to}
                    onChange={(v) => { setTo(v); setEdited(true); }}
                    required
                  />
                  <RecipientField
                    label="CC"
                    value={cc}
                    onChange={(v) => { setCc(v); setEdited(true); }}
                  />
                  <RecipientField
                    label="BCC"
                    value={bcc}
                    onChange={(v) => { setBcc(v); setEdited(true); }}
                  />

                  {previewQuery.data && previewQuery.data.bccReasons.length > 0 && (
                    <div className="rounded-md border border-default bg-subtle px-2 py-1 text-[11px] text-secondary">
                      <div className="text-accent-info">
                        Tag-derived BCC{" "}
                        <span className="text-muted">(in BCC list above)</span>
                      </div>
                      <ul className="ml-3 list-disc">
                        {previewQuery.data.bccReasons.map((r, i) => (
                          <li key={i}>
                            {r.address}{" "}
                            <span className="text-muted">({r.tag})</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <label className="block">
                    <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">
                      Subject
                    </span>
                    <input
                      type="text"
                      value={subject}
                      onChange={(e) => { setSubject(e.target.value); setEdited(true); }}
                      className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
                    />
                  </label>

                  <label className="block">
                    <span className="mb-0.5 block text-[11px] uppercase tracking-wide text-muted">
                      Body
                    </span>
                    <textarea
                      value={body}
                      onChange={(e) => { setBody(e.target.value); setEdited(true); }}
                      rows={10}
                      className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
                    />
                  </label>
                </>
              )}
            </section>

            {sendMutation.isError && (
              <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                {(sendMutation.error as Error).message}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={sendMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canSend}
            loading={sendMutation.isPending}
            onClick={() => sendMutation.mutate()}
          >
            <Send className="size-3.5" />
            Issue CM &amp; send email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- Helpers ---------------------------------------------------------------

// Read a Blob as a base64 string (no data: URL prefix). Used to encode the
// QBO credit memo PDF for the /api/send attachments payload.
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // FileReader.readAsDataURL returns "data:<mime>;base64,<payload>".
      // Strip the prefix so the backend gets just the base64 payload.
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

// ---- Shared recipient field -------------------------------------------------

function RecipientField({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-0.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
        {label}
        {required && !value.trim() && (
          <Badge tone="critical">required</Badge>
        )}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm"
        placeholder={`${label} address(es), comma-separated`}
      />
    </label>
  );
}
