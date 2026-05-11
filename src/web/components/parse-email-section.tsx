// Paste-customer-email + Parse with AI section. Used on both the damage
// and seasonal create forms. POSTs the email body to /api/rmas/parse-email,
// gets back proposed items, and hands them to the parent form via
// onItemsParsed.

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sparkles, AlertCircle } from "lucide-react";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Button } from "./ui/button";

export type ParsedItem = {
  sku?: string;
  name?: string;
  quantity: number;
  reason?: string;
};

type ParseResponse = {
  proposedItems: ParsedItem[];
  customerInferred?: { name?: string; email?: string };
  confidence: number;
};

type ParseEmailSectionProps = {
  onItemsParsed: (items: ParsedItem[]) => void;
  /** Called with whatever raw email body was pasted (operator may want to save it on the RMA). */
  onEmailChanged?: (body: string) => void;
  disabled?: boolean;
};

export function ParseEmailSection({
  onItemsParsed,
  onEmailChanged,
  disabled = false,
}: ParseEmailSectionProps) {
  const [emailBody, setEmailBody] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);

  const parseMutation = useMutation<ParseResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch("/api/rmas/parse-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emailBody }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as ParseResponse;
    },
    onSuccess: (data) => {
      setConfidence(data.confidence);
      if (data.proposedItems.length > 0) {
        onItemsParsed(data.proposedItems);
      }
    },
  });

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium">Customer email (optional)</h2>
        <p className="mt-0.5 text-xs text-muted">
          Paste the customer's return-request email. Click "Parse with AI" to
          auto-fill the items table. You can still edit any line afterwards.
        </p>
      </CardHeader>
      <CardBody className="space-y-3">
        <textarea
          value={emailBody}
          disabled={disabled}
          onChange={(e) => {
            setEmailBody(e.target.value);
            onEmailChanged?.(e.target.value);
            setConfidence(null);
          }}
          placeholder="Paste the customer's email here…"
          rows={6}
          className="w-full rounded-md border border-default bg-base px-3 py-2 text-sm disabled:opacity-60"
        />

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={
              disabled || emailBody.trim().length < 10 || parseMutation.isPending
            }
            onClick={() => parseMutation.mutate()}
          >
            <Sparkles className="size-4" />
            {parseMutation.isPending ? "Parsing…" : "Parse with AI"}
          </Button>

          {confidence !== null && !parseMutation.isError && (
            <span className="text-xs text-muted">
              {parseMutation.data?.proposedItems.length === 0
                ? "No items detected. Try a longer email or add items manually."
                : `${parseMutation.data?.proposedItems.length} item(s) added · confidence ${(confidence * 100).toFixed(0)}%`}
            </span>
          )}

          {parseMutation.isError && (
            <span className="flex items-center gap-1 text-xs text-accent-danger">
              <AlertCircle className="size-3" />
              {(parseMutation.error as Error).message}
            </span>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

export default ParseEmailSection;
