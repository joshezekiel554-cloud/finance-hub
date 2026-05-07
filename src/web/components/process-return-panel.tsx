// ProcessReturnPanel — manages the "process return" workflow for a single RMA.
// Three sections:
//   1. Linked emails (read-only ReturnReceiptCard list)
//   2. Action buttons (check for emails, navigate to credit-memo page)
//   3. Damages note textarea (PATCH on blur)

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { RefreshCw, ArrowRight } from "lucide-react";
import { Card, CardBody } from "./ui/card";
import { Button } from "./ui/button";
import { ReturnReceiptCard } from "./return-receipt-card";
import { cn } from "../lib/cn";

type LinkedEmail = {
  gmailMessageId: string;
  subject: string | null;
  fromAddress: string | null;
  bodyText: string | null;
  bodyHtml?: string | null;
  receivedAt: string;
  receiptId?: string | null;
  dismissedAt?: string | null;
  linkSource: "auto" | "manual";
};

type ProcessReturnPanelProps = {
  rmaId: string;
  damagesNote: string | null;
};

export function ProcessReturnPanel({ rmaId, damagesNote }: ProcessReturnPanelProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(damagesNote ?? "");
  const [scanResult, setScanResult] = useState<string | null>(null);

  const linkedQuery = useQuery<{ emails: LinkedEmail[] }>({
    queryKey: ["rma", rmaId, "linked-emails"],
    queryFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/linked-emails`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const checkMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/refresh-email-links`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ scanned: number; newLinks: number }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["rma", rmaId, "linked-emails"] });
      setScanResult(`Scanned ${data.scanned} email(s), ${data.newLinks} new link(s)`);
    },
    onError: (err: Error) => {
      setScanResult(`Scan failed: ${err.message}`);
    },
  });

  const damagesMutation = useMutation({
    mutationFn: async (next: string) => {
      const res = await fetch(`/api/rmas/${rmaId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ damagesNote: next || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const emails = linkedQuery.data?.emails ?? [];

  return (
    <Card>
      <CardBody className="space-y-4">
        {/* Header + action buttons */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Process Return</h3>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={checkMutation.isPending}
              onClick={() => checkMutation.mutate()}
            >
              <RefreshCw
                className={cn("size-3.5 mr-1", checkMutation.isPending && "animate-spin")}
              />
              Check for emails
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() =>
                navigate({ to: "/returns/$rmaId/credit-memo", params: { rmaId } })
              }
            >
              Parse warehouse return
              <ArrowRight className="size-3.5 ml-1" />
            </Button>
          </div>
        </div>

        {scanResult && (
          <p className="text-xs text-secondary">{scanResult}</p>
        )}

        {/* Linked emails */}
        <div className="space-y-2">
          {linkedQuery.isPending ? (
            <p className="text-sm text-secondary">Loading linked emails…</p>
          ) : emails.length === 0 ? (
            <p className="text-sm text-secondary italic">
              No linked emails yet. Click "Check for emails" to scan Gmail for this
              RMA's number.
            </p>
          ) : (
            emails.map((email) => (
              <ReturnReceiptCard
                key={email.gmailMessageId}
                receipt={{
                  receiptId: email.receiptId ?? email.gmailMessageId,
                  gmailMessageId: email.gmailMessageId,
                  emailSubject: email.subject ?? "(no subject)",
                  emailFrom: email.fromAddress ?? "",
                  emailBodyHtml: email.bodyHtml,
                  emailBodyText: email.bodyText,
                  classifiedAt: email.receivedAt,
                }}
                linkedRmas={[]}
                // No onDismiss → read-only mode
              />
            ))
          )}
        </div>

        {/* Damages note */}
        <div className="space-y-1">
          <label className="text-xs font-medium text-secondary">
            Damages reported by warehouse — appears on credit memo memo
          </label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft !== (damagesNote ?? "")) {
                damagesMutation.mutate(draft);
              }
            }}
            placeholder="Items the warehouse reported as damaged, e.g., MMCSL03G ×2 cracked"
            rows={3}
            className="w-full rounded-md border border-default bg-base px-2 py-1 text-sm text-primary"
          />
          {damagesMutation.isPending && (
            <p className="text-xs text-muted">Saving…</p>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
