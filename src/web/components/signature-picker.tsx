// src/web/components/signature-picker.tsx
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

export type SignatureChoice = string | null; // signature id, or null = "None"

type Props = {
  value: SignatureChoice;
  onChange: (next: SignatureChoice) => void;
  className?: string;
};

type UserSignatureRow = {
  id: string;
  name: string;
  isDefault: boolean;
};

export function SignaturePicker({ value, onChange, className }: Props) {
  const { data, isPending } = useQuery<{ rows: UserSignatureRow[] }>({
    queryKey: ["me-signatures"],
    queryFn: async () => {
      const res = await fetch("/api/me/signatures");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  const rows = data?.rows ?? [];

  // Auto-select default on first load
  useEffect(() => {
    if (value !== undefined && value !== null) return;
    if (rows.length === 0) {
      onChange(null);
      return;
    }
    const def = rows.find((r) => r.isDefault) ?? rows[0];
    onChange(def?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.length]);

  const disabled = isPending || rows.length === 0;

  return (
    <select
      className={
        className ??
        "h-8 rounded border border-default bg-base px-2 text-xs disabled:opacity-50"
      }
      value={value ?? "__none__"}
      onChange={(e) =>
        onChange(e.target.value === "__none__" ? null : e.target.value)
      }
      disabled={disabled}
    >
      {rows.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
          {r.isDefault ? " (default)" : ""}
        </option>
      ))}
      <option value="__none__">None (skip personal signature)</option>
    </select>
  );
}
