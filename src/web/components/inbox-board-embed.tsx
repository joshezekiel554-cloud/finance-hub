// Embedded Inbox board for a single customer (Inbox↔Finance integration,
// Improvement 2). Frames the REAL Inbox app's chrome-free board view, scoped
// to this customer, so the operator manages that customer's email workflow
// (the Unassigned/To do/In progress/Waiting/Done columns + linked tasks)
// without leaving Finance.
//
// Same-site (finance.* + inbox.* share feldart.com), so the operator's Inbox
// Google session carries into the frame; the user is themselves, not a robot.
// Inbox sets `Content-Security-Policy: frame-ancestors https://finance.feldart.com`
// to allow this framing. We pass ONLY the Finance customer id — Inbox resolves
// that customer's address set from its synced Customer model (no PII in the URL).
//
// Rendered only when the `inbox_integration_enabled` flag is on; otherwise the
// customer page falls back to Finance's own EmailList. See spec
// docs/superpowers/specs/2026-06-16-inbox-integration-design.md §3.4.

// Inbox lives at a fixed subdomain on the same VPS. Kept as a constant rather
// than a setting — the URL is stable; promote to an app_setting only if a
// non-prod target is ever needed.
const INBOX_BASE_URL = "https://inbox.feldart.com";

export function InboxBoardEmbed({
  customerId,
}: {
  customerId: string;
}): React.ReactElement {
  const src = `${INBOX_BASE_URL}/board?customer=${encodeURIComponent(
    customerId,
  )}&embed=1`;
  return (
    <div className="flex flex-col">
      <iframe
        title="Customer emails (Inbox)"
        src={src}
        className="h-[70vh] w-full rounded-md border border-default bg-surface-1"
      />
      <p className="mt-2 text-xs text-secondary">
        Emails for this customer, live from Inbox. Open a thread to reply, or
        drag between columns.
      </p>
    </div>
  );
}
