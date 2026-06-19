// Public surface of the Gmail integration. Imported by callers (poller, send)
// and downstream modules (activity ingestion). Keep this file dependency-free
// so it can be referenced from anywhere without pulling googleapis.

export type ParsedEmail = {
  id: string;
  threadId: string;
  // RFC 5322 Message-ID header value, including angle brackets. Empty
  // string when the header is missing — separate from `id` (the Gmail
  // API's internal message id). Used as the In-Reply-To value on
  // outbound replies so non-Gmail recipients thread correctly.
  messageIdHeader: string;
  from: string;
  to: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  date: string;
  emailDate: Date | null;
  body: string;
  // Optional text/html body extracted alongside the text body. Only
  // populated by formatMessage when an HTML part exists; consumers like
  // the B2B invoicing parser can use it directly without a second
  // messages.get round-trip.
  htmlBody: string;
  snippet: string;
  labelIds: string[];
};

export type EmailAttachment = {
  filename: string;
  mimeType: string;
  // Raw bytes. Caller passes a Buffer; we base64-encode in the MIME builder.
  // Keep memory bounded: typical statement send is 5-15 invoice PDFs ~50-200KB
  // each, so a few MB worst case — fine for a single send.
  data: Buffer;
};

// The kind of Finance-originated send, stamped into the
// `X-Feldart-Finance-Send` header so the sibling Inbox app can (1) tag the
// thread "Sent from Finance" + apply its hide filter, and (2) route by type
// (chase→Waiting, statement→Done, unknown→Waiting). Presence of the header =
// "originated in Finance"; absence = a human Inbox send. See spec
// 2026-06-16-inbox-integration-design §3.3.
export type FinanceSendType =
  | "chase"
  | "statement"
  | "check-in"
  | "dispute-bookkeeper"
  | "rma"
  // Order-hold alert: an order came through for a customer on hold, OR a
  // payment-upfront customer's order is still unpaid. Inbox routes this to
  // To-Do with a loud "⚠ HOLD ORDER" badge + always-on team ping.
  | "hold-alert"
  // Customer-facing hold chase (Day-0 notice + Day-7 final warning). Inbox →
  // Waiting (a customer reply auto-reopens).
  | "hold-chase"
  // Internal Day-10 "cancel this order, return to stock" notice. Inbox →
  // Waiting + a distinct "Cancelled" chip.
  | "hold-cancel"
  // "Good to send" release, sent as a reply on the hold-alert thread. Inbox →
  // Done + drops the ⚠ treatment.
  | "hold-release"
  // Customer-facing "your order has been cancelled" confirmation, sent
  // best-effort from the operator Cancel button after the Shopify cancel + QBO
  // void + state flip succeed. Customer-facing → Inbox routes to Waiting (a
  // customer reply auto-reopens). NOTE for Inbox: new send type to recognise.
  | "order-cancelled";

export type SendEmailInput = {
  // Comma-separated list of addresses; we don't split, Gmail does.
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  // Either pass an explicit alias, or leave undefined to use the account's
  // primary send-as.
  alias?: string;
  attachments?: EmailAttachment[];
  // Reply threading: when set, Gmail puts the new message in the same
  // thread as the parent. inReplyTo also gets written into the
  // In-Reply-To + References headers so non-Gmail clients render the
  // thread correctly.
  threadId?: string;
  inReplyTo?: string;
  // When set, emits `X-Feldart-Finance-Send: <type>` on the message so Inbox
  // recognizes it as a Finance-originated send. Omit for sends that should NOT
  // be tagged as from Finance.
  financeSendType?: FinanceSendType;
  // When set, emits `X-Feldart-Finance-Customer-Id: <id>` so Inbox can link the
  // thread to that finance customer even when the email never touches the
  // customer's own address (e.g. a hold-alert sent to the warehouse). Inbox's
  // per-customer embed includes threads linked by this id. Same id finance
  // passes to the embed (`?customer=<id>`).
  financeCustomerId?: string;
};

export type SendEmailResult = {
  messageId: string;
  threadId: string;
  from: string;
};

export type GmailTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  externalAccountId: string;
};

export type MailAlias = {
  sendAsEmail: string;
  displayName: string | null;
  isPrimary: boolean;
  isDefault: boolean;
  replyToAddress: string | null;
  verificationStatus: string | null;
};

// Stored as JSON in oauth_tokens.meta for provider='gmail'. Persists the
// incremental polling cursor so the next run picks up where the last left off.
export type GmailProviderMeta = {
  lastPollAt?: string; // ISO timestamp of newest message processed
};

export type AliasContext =
  | "chase"
  | "order"
  | "general"
  | "sales"
  | "accounts"
  | "support";

export type PollResult = {
  fetched: number;
  inserted: number;
  matched: number;
  activitiesCreated: number;
  cursorAdvancedTo: string | null;
};
