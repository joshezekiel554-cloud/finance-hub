// On-hold banner. Renders nothing when the customer is active; when on
// hold, paints a prominent red strip across the top of the customer
// detail page with a "Release hold" affordance. Confirm dialog gates the
// release so the user can't accidentally re-add the b2b tag with one
// stray click.
//
// The banner intentionally lives outside customer-detail.tsx so the same
// component can be reused on any customer-scoped page (e.g. a future
// invoice editor that needs the same loud signal). All it needs is the
// customerId + the customer's holdStatus + display name.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Octagon } from "lucide-react";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

type HoldBannerProps = {
  customerId: string;
  customerName: string;
  // payment_upfront is also a valid status now, but doesn't trigger
  // this banner — only true holds do. Accept it in the type so the
  // caller can pass it through without narrowing.
  holdStatus: "active" | "hold" | "payment_upfront";
};

export function HoldBanner({
  customerId,
  customerName,
  holdStatus,
}: HoldBannerProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryClient = useQueryClient();

  const toggleMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/customers/${customerId}/hold-toggle`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetState: "active" }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      return res.json() as Promise<{
        holdStatus: "active" | "hold" | "payment_upfront";
        tagsAfter: string[];
      }>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer", customerId] });
      queryClient.invalidateQueries({ queryKey: ["shopify-tags", customerId] });
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setConfirmOpen(false);
    },
  });

  if (holdStatus !== "hold") return null;

  return (
    <>
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 rounded-md border border-accent-danger/40 bg-accent-danger/10 px-4 py-3 text-sm"
      >
        <Octagon className="size-5 shrink-0 text-accent-danger" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-accent-danger">
            On hold — removed from the B2B program.
          </div>
          <div className="text-secondary">
            Shopify tag &lsquo;b2b&rsquo; has been removed from this customer.
          </div>
        </div>
        <Button
          variant="danger"
          size="sm"
          onClick={() => setConfirmOpen(true)}
          disabled={toggleMutation.isPending}
        >
          Release hold
        </Button>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Release hold?</DialogTitle>
            <DialogDescription>
              This will restore {customerName} to the B2B program by re-adding
              the &lsquo;b2b&rsquo; Shopify tag. Continue?
            </DialogDescription>
          </DialogHeader>
          {toggleMutation.isError && (
            <div className="mt-2 text-sm text-accent-danger">
              {(toggleMutation.error as Error)?.message ?? "Toggle failed"}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmOpen(false)}
              disabled={toggleMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => toggleMutation.mutate()}
              disabled={toggleMutation.isPending}
              loading={toggleMutation.isPending}
            >
              Release hold
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
