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
  snippet: string;
  labelIds: string[];
};

export type SendEmailInput = {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  // Either pass an explicit alias, or leave undefined to use the account's
  // primary send-as. Outbound context can be resolved separately via
  // resolveAliasFromContext() → sendEmail({ alias }).
  alias?: string;
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
