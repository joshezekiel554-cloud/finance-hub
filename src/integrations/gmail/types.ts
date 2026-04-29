// Public surface of the Gmail integration. Imported by callers (poller, send)
// and downstream modules (activity ingestion). Keep this file dependency-free
// so it can be referenced from anywhere without pulling googleapis.

export type ParsedEmail = {
  id: string;
  threadId: string;
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
