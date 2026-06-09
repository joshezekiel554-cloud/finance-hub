import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardBody, CardHeader } from "../components/ui/card";
import { cn } from "../lib/cn";

type Origin = "feldart" | "tj";

type NeedsReviewCreditMemo = {
  id: string;
  qbCreditMemoId: string;
  docNumber: string | null;
  balance: string;
  total: string;
  origin: Origin;
  customerId: string;
  customerName: string | null;
};

type NeedsReviewResponse = { creditMemos: NeedsReviewCreditMemo[] };

const NEEDS_REVIEW_KEY = ["origin-review", "needs-review"] as const;

function formatAmount(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
  }).format(n);
}

export default function OriginReviewPage() {
  const queryClient = useQueryClient();

  const { data, isPending, isError, error } = useQuery<NeedsReviewResponse>({
    queryKey: NEEDS_REVIEW_KEY,
    queryFn: async () => {
      const res = await fetch("/api/origin-review/needs-review");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const overrideMutation = useMutation({
    mutationFn: async (input: {
      kind: "invoice" | "credit_memo";
      id: string;
      origin: Origin;
    }) => {
      const res = await fetch("/api/origin-review/override", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as { ok: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NEEDS_REVIEW_KEY });
    },
  });

  // Track which credit-memo row is mid-flight so we can show a per-row
  // saving state without blocking the whole table.
  const savingId =
    overrideMutation.isPending &&
    overrideMutation.variables?.kind === "credit_memo"
      ? overrideMutation.variables.id
      : null;

  const creditMemos = data?.creditMemos ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Origin review</h1>
        <p className="mt-1 text-sm text-secondary">
          These credit memos couldn&rsquo;t be auto-classified — tell us whether
          each belongs to the Feldart book or the Torah Judaica wind-down book.
        </p>
      </div>

      {isError ? (
        <Card>
          <CardBody>
            <div className="text-sm text-accent-danger">
              {(error as Error)?.message ?? "Failed to load."}
            </div>
          </CardBody>
        </Card>
      ) : isPending ? (
        <Card>
          <CardBody>
            <div className="text-sm text-muted">Loading…</div>
          </CardBody>
        </Card>
      ) : creditMemos.length === 0 ? (
        <Card>
          <CardBody>
            <div className="rounded-md border border-dashed border-default bg-subtle p-8 text-center">
              <div className="text-sm font-medium text-primary">
                Nothing to review
              </div>
              <p className="mt-1 text-xs text-muted">
                All credit memos are classified.
              </p>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-medium">
              Credit memos needing classification
              <span className="ml-2 text-xs font-normal text-muted">
                {creditMemos.length}
              </span>
            </h2>
          </CardHeader>
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-default text-[10px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Customer</th>
                  <th className="px-4 py-2 text-left font-medium">Doc #</th>
                  <th className="px-4 py-2 text-right font-medium">Balance</th>
                  <th className="px-4 py-2 text-right font-medium">Origin</th>
                </tr>
              </thead>
              <tbody>
                {creditMemos.map((cm) => (
                  <tr
                    key={cm.id}
                    className="border-b border-default last:border-0"
                  >
                    <td className="px-4 py-2.5">
                      <span className="text-primary">
                        {cm.customerName ?? (
                          <span className="text-muted">Unknown customer</span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-secondary">
                      {cm.docNumber ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-secondary">
                      {formatAmount(cm.balance)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-2">
                        <OriginToggle
                          value={cm.origin}
                          disabled={overrideMutation.isPending}
                          onChange={(origin) =>
                            overrideMutation.mutate({
                              kind: "credit_memo",
                              id: cm.id,
                              origin,
                            })
                          }
                        />
                        <SaveState
                          saving={savingId === cm.id}
                          saved={
                            overrideMutation.isSuccess &&
                            overrideMutation.variables?.kind === "credit_memo" &&
                            overrideMutation.variables.id === cm.id
                          }
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {overrideMutation.isError ? (
              <div className="border-t border-default px-4 py-2 text-xs text-accent-danger">
                {(overrideMutation.error as Error)?.message ?? "Save failed."}
              </div>
            ) : null}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

// Two-button segmented control. Feldart = subtle indigo, TJ = subtle amber.
function OriginToggle({
  value,
  disabled,
  onChange,
}: {
  value: Origin;
  disabled?: boolean;
  onChange: (origin: Origin) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-default bg-base p-0.5">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value === "feldart"}
        onClick={() => value !== "feldart" && onChange("feldart")}
        className={cn(
          "rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          value === "feldart"
            ? "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300"
            : "text-muted hover:text-primary",
        )}
      >
        Feldart
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={value === "tj"}
        onClick={() => value !== "tj" && onChange("tj")}
        className={cn(
          "rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          value === "tj"
            ? "bg-amber-500/15 text-amber-600 dark:text-amber-300"
            : "text-muted hover:text-primary",
        )}
      >
        TJ
      </button>
    </div>
  );
}

function SaveState({ saving, saved }: { saving: boolean; saved: boolean }) {
  if (saving) {
    return <span className="w-10 text-[10px] text-muted">Saving…</span>;
  }
  if (saved) {
    return <span className="w-10 text-[10px] text-accent-success">Saved</span>;
  }
  return <span className="w-10" />;
}
