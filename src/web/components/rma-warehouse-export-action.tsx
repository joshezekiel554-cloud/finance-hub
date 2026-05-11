// RmaWarehouseExportAction — "Send to Warehouse" affordance.
// Calls POST /api/rmas/:id/generate-warehouse-export, decodes the
// base64 file content, triggers a browser download, and refetches the RMA
// (status moves approved → awaiting_warehouse_number).

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, AlertCircle } from "lucide-react";
import { Button } from "./ui/button";
import { invalidateAfterRmaChange } from "../lib/invalidate-rma";

type ExportResponse = {
  rma: { id: string; status: string };
  exportFile: {
    filename: string;
    content: string; // base64
    mimeType: string;
  };
};

export default function RmaWarehouseExportAction({
  rmaId,
  onDone,
}: {
  rmaId: string;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const exportMutation = useMutation<ExportResponse, Error, void>({
    mutationFn: async () => {
      const res = await fetch(`/api/rmas/${rmaId}/generate-warehouse-export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setError(null);
      // Trigger browser download
      const { filename, content, mimeType } = data.exportFile;
      const bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);

      // Mutation response only includes minimal rma fields, so fall back to
      // the rma detail cache for customerId.
      const cached = queryClient.getQueryData<{ customerId?: string }>([
        "rma",
        rmaId,
      ]);
      invalidateAfterRmaChange(queryClient, {
        rmaId,
        customerId: cached?.customerId ?? null,
      });
      onDone();
    },
    onError: (err) => setError(err.message),
  });

  return (
    <div className="space-y-2">
      <Button
        variant="primary"
        size="sm"
        className="w-full"
        loading={exportMutation.isPending}
        onClick={() => { setError(null); exportMutation.mutate(); }}
      >
        <Download className="size-3.5" />
        Send to Warehouse
      </Button>
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-accent-danger/30 bg-accent-danger/10 px-3 py-2 text-xs text-accent-danger">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      )}
    </div>
  );
}
