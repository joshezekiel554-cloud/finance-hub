import { createLogger } from "~/lib/logger.js";
import {
  getInternalGmailClient,
  getProfileEmail,
  withRetry,
} from "./client.js";
import { listAliases } from "./aliases.js";
import type {
  EmailAttachment,
  SendEmailInput,
  SendEmailResult,
} from "./types.js";

const log = createLogger({ module: "gmail.send" });

// Build an RFC 822 MIME message Gmail accepts as users.messages.send `raw`.
//
// MIME structure depends on whether attachments are present:
//   - No attachments: top-level multipart/alternative (text + html parts)
//   - With attachments: multipart/mixed
//       part 1: multipart/alternative (text + html)
//       parts 2..N: each attachment as base64
//
// Reply threading: if `inReplyTo` is supplied, we write the In-Reply-To
// AND References headers so non-Gmail clients render the thread. The
// message is also tagged with `threadId` at the API call site (not the
// MIME layer) — that's how Gmail itself groups it.
export function buildRawMessage(input: {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  inReplyTo?: string;
  attachments?: EmailAttachment[];
}): string {
  const {
    from,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    replyTo,
    inReplyTo,
    attachments,
  } = input;
  const hasAttachments = (attachments?.length ?? 0) > 0;

  // Outer boundary (multipart/mixed) used only when attachments exist.
  // Inner boundary (multipart/alternative) always wraps text + html.
  const altBoundary =
    "----=_Alt_" + Math.random().toString(36).slice(2);
  const mixedBoundary = hasAttachments
    ? "----=_Mixed_" + Math.random().toString(36).slice(2)
    : null;

  const headerLines: string[] = [
    `From: ${from}`,
    `To: ${to}`,
  ];
  if (cc) headerLines.push(`Cc: ${cc}`);
  if (bcc) headerLines.push(`Bcc: ${bcc}`);
  headerLines.push(`Subject: ${subject}`, "MIME-Version: 1.0");
  if (replyTo) headerLines.push(`Reply-To: ${replyTo}`);
  if (inReplyTo) {
    // RFC 5322: angle-bracketed Message-ID. We accept either a bare id
    // or one already wrapped, and normalize.
    const wrapped = inReplyTo.startsWith("<") ? inReplyTo : `<${inReplyTo}>`;
    headerLines.push(`In-Reply-To: ${wrapped}`);
    headerLines.push(`References: ${wrapped}`);
  }
  headerLines.push(
    `Content-Type: ${
      hasAttachments
        ? `multipart/mixed; boundary="${mixedBoundary}"`
        : `multipart/alternative; boundary="${altBoundary}"`
    }`,
  );
  const headers = headerLines.join("\r\n");

  // multipart/alternative payload — always present.
  const altPart = [
    `--${altBoundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    text ?? "",
    `--${altBoundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    html ?? "",
    `--${altBoundary}--`,
  ].join("\r\n");

  let body: string;
  if (hasAttachments) {
    const parts: string[] = [
      `--${mixedBoundary}`,
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      altPart,
    ];
    for (const att of attachments!) {
      parts.push(`--${mixedBoundary}`);
      parts.push(`Content-Type: ${att.mimeType}; name="${att.filename}"`);
      parts.push("Content-Transfer-Encoding: base64");
      parts.push(
        `Content-Disposition: attachment; filename="${att.filename}"`,
      );
      parts.push("");
      // Base64 with line-wraps every 76 chars per RFC 2045.
      const b64 = att.data.toString("base64");
      const wrapped = b64.match(/.{1,76}/g)?.join("\r\n") ?? b64;
      parts.push(wrapped);
    }
    parts.push(`--${mixedBoundary}--`);
    body = parts.join("\r\n");
  } else {
    body = altPart;
  }

  const message = headers + "\r\n\r\n" + body;
  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// If `alias` is provided, validate it against the live sendAs list before
// attempting send — Gmail rejects (403 / failedPrecondition) if you try to send
// as an unverified address, and the surfaced error is nicer if we catch it
// upstream. If no alias is given, the account's primary email is used.
export async function sendEmail(
  input: SendEmailInput,
  externalAccountId?: string,
): Promise<SendEmailResult> {
  const {
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    replyTo,
    alias,
    attachments,
    threadId,
    inReplyTo,
  } = input;

  let from: string;
  if (alias) {
    const aliases = await listAliases(externalAccountId);
    const match = aliases.find(
      (a) => a.sendAsEmail.toLowerCase() === alias.toLowerCase(),
    );
    if (!match) {
      throw new Error(
        `Alias "${alias}" not configured on the connected Gmail account. Available: ${aliases
          .map((a) => a.sendAsEmail)
          .join(", ")}`,
      );
    }
    if (match.verificationStatus && match.verificationStatus !== "accepted") {
      throw new Error(
        `Alias "${alias}" is not verified (status: ${match.verificationStatus}).`,
      );
    }
    from = match.displayName
      ? `${match.displayName} <${match.sendAsEmail}>`
      : match.sendAsEmail;
  } else {
    from = await getProfileEmail(externalAccountId);
  }

  const raw = buildRawMessage({
    from,
    to,
    cc,
    bcc,
    subject,
    html,
    text,
    replyTo,
    inReplyTo,
    attachments,
  });

  const gmail = await getInternalGmailClient(externalAccountId);
  const res = await withRetry(
    () =>
      gmail.users.messages.send({
        userId: "me",
        requestBody: threadId ? { raw, threadId } : { raw },
      }),
    "messages.send",
  );

  const result: SendEmailResult = {
    messageId: res.data.id ?? "",
    threadId: res.data.threadId ?? "",
    from,
  };
  log.info(
    {
      to,
      cc: cc ?? null,
      bcc: bcc ?? null,
      subject,
      alias: alias ?? "primary",
      messageId: result.messageId,
      attachmentCount: attachments?.length ?? 0,
      threaded: Boolean(threadId || inReplyTo),
    },
    "gmail message sent",
  );
  return result;
}
