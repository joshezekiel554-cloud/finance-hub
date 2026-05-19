import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type CustomerRow = {
  id: string;
  displayName: string;
  primaryEmail: string | null;
  customerType: "b2b" | "b2c" | null;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromAddress?: string | null;
  saving?: boolean;
  // Called with the chosen customerId + whether to remember the sender
  // address (append to billing_emails so future emails auto-link).
  onSelect: (customerId: string, rememberAddress: boolean) => Promise<void>;
};

export function CustomerPickerDialog({
  open,
  onOpenChange,
  fromAddress,
  saving,
  onSelect,
}: Props) {
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [picked, setPicked] = useState<CustomerRow | null>(null);
  const [remember, setRemember] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) {
      setQ("");
      setDebouncedQ("");
      setPicked(null);
      setRemember(true);
    }
  }, [open]);

  const { data, isPending } = useQuery<{ rows: CustomerRow[] }>({
    queryKey: ["dashboard", "customer-picker", debouncedQ],
    queryFn: async () => {
      const params = new URLSearchParams({ q: debouncedQ, limit: "10" });
      const res = await fetch(`/api/customers?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    enabled: open && debouncedQ.length >= 2,
    staleTime: 30_000,
  });

  const rows = data?.rows ?? [];

  const handleSave = async () => {
    if (!picked) return;
    await onSelect(picked.id, remember);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Link email to customer</DialogTitle>
          <DialogDescription>
            {fromAddress
              ? `Searching for the customer who owns ${fromAddress}.`
              : "Pick the customer this email belongs to."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search customer by name or email…"
          />

          <div className="max-h-64 overflow-y-auto rounded border border-default">
            {debouncedQ.length < 2 ? (
              <div className="px-3 py-4 text-xs text-muted">
                Type at least 2 characters to search.
              </div>
            ) : isPending ? (
              <div className="px-3 py-4 text-xs text-muted">Searching…</div>
            ) : rows.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted">
                No customers match.
              </div>
            ) : (
              <ul className="divide-y divide-default">
                {rows.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setPicked(c)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-subtle ${
                        picked?.id === c.id ? "bg-subtle" : ""
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-primary truncate">
                          {c.displayName}
                        </div>
                        <div className="text-xs text-muted truncate">
                          {c.primaryEmail ?? "no email"}
                        </div>
                      </div>
                      {c.customerType && (
                        <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">
                          {c.customerType}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-primary">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={!fromAddress}
            />
            <span>
              Remember <code className="font-mono">{fromAddress ?? "(no address)"}</code>{" "}
              — future emails from this address auto-link to this customer.
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!picked || saving}
          >
            {saving ? "Linking…" : "Link"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
