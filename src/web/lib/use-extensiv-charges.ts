// Extensiv (Blue Chip) warehouse charges per shipment, fetched in one batch
// for the rows on screen. Reference only. Returns an empty map when finance
// has no Extensiv credentials or the lookup fails (the card just omits it).

import { useQuery } from "@tanstack/react-query";
import type { ShipmentChargesView } from "../components/invoicing/extensiv-shipment";

export function useExtensivCharges(transactionNumbers: string[]): {
  charges: Map<string, ShipmentChargesView>;
  isLoading: boolean;
} {
  const key = transactionNumbers.slice(0, 300);
  const q = useQuery({
    queryKey: ["invoicing", "extensiv-charges", key],
    enabled: key.length > 0,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async (): Promise<Record<string, ShipmentChargesView>> => {
      const res = await fetch("/api/invoicing/extensiv-charges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transactionNumbers: key }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { charges?: Record<string, ShipmentChargesView> };
      return body.charges ?? {};
    },
  });
  return {
    charges: new Map(Object.entries(q.data ?? {})),
    isLoading: q.isLoading && key.length > 0,
  };
}
