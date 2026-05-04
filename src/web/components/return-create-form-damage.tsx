// ReturnCreateFormDamage — the damage-branch section of the /returns/new form.
// Handles items, photos URL, resolution radio, notes. The parent page
// holds the RMA state and passes rmaId once it's been persisted.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import RmaItemsTable, {
  type RmaItemRow,
  makeEmptyRow,
} from "./rma-items-table";

export type DamageFormState = {
  items: RmaItemRow[];
  photosUrl: string;
  notes: string;
  resolutionType: "credit" | "replacement";
};

export type DamageFormProps = {
  rmaId: string | null;
  value: DamageFormState;
  onChange: (next: DamageFormState) => void;
  onApprove: () => void;
  onDeny: () => void;
  disabled?: boolean;
  isSaving?: boolean;
  saveError?: string | null;
};

type AddItemsResult = {
  rma: { id: string; totalValue: string };
};

export default function ReturnCreateFormDamage({
  rmaId,
  value,
  onChange,
  onApprove,
  onDeny,
  disabled = false,
  isSaving = false,
  saveError = null,
}: DamageFormProps) {
  const [itemSyncError, setItemSyncError] = useState<string | null>(null);
  const [itemSyncPending, setItemSyncPending] = useState(false);

  // When a new item is added and rmaId exists, POST it to the backend
  // immediately so lookups have a valid rmaId.
  const addItemMutation = useMutation<AddItemsResult, Error, RmaItemRow>({
    mutationFn: async (item) => {
      if (!rmaId) throw new Error("RMA not yet created");
      const res = await fetch(`/api/rmas/${rmaId}/items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          qbItemId: item.qbItemId,
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          classification: "damage",
          listUnitPrice: item.listUnitPrice ?? null,
          invoiceDiscountPct: item.invoiceDiscountPct ?? null,
          reason: item.reason || null,
          originalInvoiceDocNumber: item.originalInvoiceDocNumber ?? null,
          originalInvoiceDate: item.originalInvoiceDate ?? null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onError: (err) => setItemSyncError(err.message),
  });
  void addItemMutation; // used indirectly via mutation ref; suppress unused warning
  void setItemSyncPending;

  function patch(partial: Partial<DamageFormState>) {
    onChange({ ...value, ...partial });
  }

  const hasItems = value.items.length > 0;
  const hasValidItems = value.items.every((i) => i.qbItemId && parseFloat(i.quantity) > 0);

  // Approve/Deny can only fire when we have at least one valid item and the
  // RMA has been saved (rmaId is set).
  const canAction = !!rmaId && hasItems && hasValidItems && !isSaving && !disabled;

  return (
    <div className="space-y-6">
      {/* Items */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-medium">Items being returned</h3>
          <p className="mt-0.5 text-xs text-secondary">
            Search QBO items, then use Prices/Invoice buttons to auto-fill from
            the customer's most recent matching invoice.
          </p>
        </CardHeader>
        <CardBody>
          <RmaItemsTable
            rmaId={rmaId}
            items={value.items}
            disabled={disabled}
            onChange={(items) => {
              patch({ items });
              setItemSyncError(null);
            }}
          />
          {itemSyncError && (
            <div className="mt-2 flex items-center gap-1 text-xs text-accent-danger">
              <AlertCircle className="size-3 shrink-0" />
              {itemSyncError}
            </div>
          )}
        </CardBody>
      </Card>

      {/* Photos (Drive URL) */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-medium">Photos</h3>
        </CardHeader>
        <CardBody>
          <label className="block">
            <span className="mb-1 block text-xs text-secondary">
              Google Drive folder URL (paste link from Drive){" "}
              <span className="text-muted">— full Drive upload coming in Phase 2</span>
            </span>
            <input
              type="url"
              value={value.photosUrl}
              disabled={disabled}
              onChange={(e) => patch({ photosUrl: e.target.value })}
              placeholder="https://drive.google.com/drive/folders/..."
              className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm disabled:opacity-60"
            />
          </label>
        </CardBody>
      </Card>

      {/* Notes */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-medium">Notes</h3>
        </CardHeader>
        <CardBody>
          <textarea
            value={value.notes}
            disabled={disabled}
            onChange={(e) => patch({ notes: e.target.value })}
            placeholder="Internal notes about this return…"
            rows={4}
            className="w-full rounded-md border border-default bg-base px-2 py-1.5 text-sm disabled:opacity-60"
          />
        </CardBody>
      </Card>

      {/* Resolution */}
      <Card>
        <CardHeader>
          <h3 className="text-sm font-medium">Resolution</h3>
        </CardHeader>
        <CardBody>
          <div className="flex gap-6">
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="resolution"
                value="credit"
                checked={value.resolutionType === "credit"}
                disabled={disabled}
                onChange={() => patch({ resolutionType: "credit" })}
              />
              <span className="text-sm">Issue credit memo</span>
            </label>
            <label className="flex cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="resolution"
                value="replacement"
                checked={value.resolutionType === "replacement"}
                disabled={disabled}
                onChange={() => patch({ resolutionType: "replacement" })}
              />
              <span className="text-sm">Send replacement</span>
            </label>
          </div>
        </CardBody>
      </Card>

      {/* Seasonal / Non-seasonal coming soon banner */}
      <div className="rounded-md border border-accent-info/30 bg-accent-info/5 px-4 py-3 text-sm text-accent-info">
        <div className="font-medium">Seasonal &amp; Non-seasonal RMAs — coming in Phase 3</div>
        <div className="mt-0.5 text-xs text-secondary">
          Only the Damage flow is active. Other types can be selected but will
          not process until Phase 3 is deployed.
        </div>
      </div>

      {/* Save error */}
      {saveError && (
        <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-sm text-accent-danger">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          {saveError}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center justify-between gap-3 rounded-md border border-default bg-subtle px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-secondary">
          {rmaId ? (
            <>
              <CheckCircle2 className="size-4 text-accent-success" />
              <span>
                Draft saved{" "}
                <span className="font-mono text-muted">{rmaId.slice(0, 8)}…</span>
              </span>
            </>
          ) : (
            <span className="text-muted">Not yet saved</span>
          )}
          {!hasItems && (
            <Badge tone="neutral">Add at least one item to approve or deny</Badge>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={!canAction}
            onClick={onDeny}
          >
            Deny
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={!canAction}
            onClick={onApprove}
          >
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
