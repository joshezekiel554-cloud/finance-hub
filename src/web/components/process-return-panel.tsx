// ProcessReturnPanel — slim "process return" entry point on the RMA detail page.
// Three things only:
//   1. Linked emails list (read-only ReturnReceiptCard)
//   2. "Check for emails" button (refresh Gmail link scan)
//   3. "Parse warehouse return" button (navigate to credit-memo create page)
//
// Paste-receipt UI and damages-note textarea moved to CreditMemoCreatePage so
// the operator drives both from a single screen — paste, then damages, then
// review the line table. See src/web/pages/credit-memo-create.tsx.

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
};

export function ProcessReturnPanel({ rmaId }: ProcessReturnPanelProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
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
      </CardBody>
    </Card>
  );
}
