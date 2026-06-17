// Embedded Inbox board for a single customer (Inbox↔Finance integration,
// Improvement 2). Frames the REAL Inbox app's chrome-free board view, scoped
// to this customer, so the operator works that customer's email workflow
// (Unassigned / To do / In progress / Waiting / Done + linked tasks) without
// leaving Finance.
//
// Same-site (finance.* + inbox.* share feldart.com), so the operator's Inbox
// Google session carries into the frame; the user is themselves, not a robot.
// Inbox sets `Content-Security-Policy: frame-ancestors https://finance.feldart.com`
// to allow framing. We pass ONLY the Finance customer id — Inbox resolves the
// customer's address set from its synced record (no PII in the URL).
//
// Rendered only when `inbox_integration_enabled` is on; otherwise the customer
// page falls back to Finance's own EmailList. See spec
// docs/superpowers/specs/2026-06-16-inbox-integration-design.md §3.4.

import { useState } from "react";

// Inbox lives at a fixed subdomain on the same VPS. Constant rather than a
// setting: the URL is stable; promote to an app_setting only if a non-prod
// target is ever needed.
const INBOX_BASE_URL = "https://inbox.feldart.com";

export function InboxBoardEmbed({
  customerId,
}: {
  customerId: string;
}): React.ReactElement {
  const [loaded, setLoaded] = useState(false);
  const src = `${INBOX_BASE_URL}/board?customer=${encodeURIComponent(
    customerId,
  )}&embed=1`;

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-[calc(100dvh-6rem)] min-h-[720px] overflow-hidden rounded-lg border border-default bg-white">
        {!loaded ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-white">
            <div className="h-6 w-6 rounded-full border-2 border-default border-t-accent-primary motion-safe:animate-spin" />
            <p className="text-sm text-muted">Loading emails…</p>
          </div>
        ) : null}
        {/* White to match the embedded Inbox board exactly (board is pure
            white) so the iframe seam is invisible — overrides the app's
            faintly-tinted bg-base only at this integration boundary. */}
        <iframe
          title="Customer emails (Inbox)"
          src={src}
          onLoad={() => setLoaded(true)}
          className="h-full w-full border-0 bg-white"
        />
      </div>
      <p className="px-0.5 text-xs text-muted">
        This customer&rsquo;s full email history, live from Inbox. Click a card
        to read or reply; drag between columns to change status.
      </p>
    </div>
  );
}
