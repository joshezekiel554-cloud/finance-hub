// Mobile-only full-screen detail page for a single shipment from the
// Today queue. Desktop renders inline ShipmentCard on /invoicing — a
// useEffect here redirects md+ viewports back to the list so the
// surfaces don't drift apart.
//
// Phase 2: placeholder body. Phase 3 builds the real editing surface
// using the extracted useShipmentEditor hook.

import { useEffect } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { MobileAppBar } from "../components/mobile-app-bar";

export default function InvoicingTodayDetailPage() {
  const { gmailId } = useParams({ from: "/invoicing/$gmailId" });
  const navigate = useNavigate();

  // Desktop users land on this URL by accident → bounce back to the list.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => {
      if (mq.matches) void navigate({ to: "/invoicing" });
    };
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [navigate]);

  return (
    <div className="-m-4 md:-m-6">
      <MobileAppBar
        title="Shipment detail"
        subtitle={gmailId}
        back={() => void navigate({ to: "/invoicing" })}
      />
      <div className="p-4 text-sm text-secondary">
        Building this detail page in Phase 3.
      </div>
    </div>
  );
}
