import { createLogger } from "~/lib/logger.js";
import {
  getInternalGmailClient,
  getProfileEmail,
  withRetry,
} from "./client.js";
import { listAliases } from "./aliases.js";
import type { SendEmailInput, SendEmailResult } from "./types.js";

const log = createLogger({ module: "gmail.send" });

// Build an RFC 822 MIME multipart/alternative message. Gmail's
// users.messages.send accepts this base64url-encoded as the `raw` field.
//
// Notes on format:
//   - Boundary string is randomized per message; the trailing `--` marks end.
//   - We send both text and html parts so non-HTML clients have a fallback.
//   - Replies wrapped from web Gmail use \r\n line endings; we match.
//   - Reply-To header is optional but useful when sending from a sales@ alias
//     while wanting replies to land at accounts@ etc.
export function buildRawMessage({
  from,
  to,
  subject,
  html,
  text,
  replyTo,
}: {
  from: string;
  to: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
}): string {
  const boundary = "----=_Part_" + Math.random().toString(36).slice(2);

  const headerLines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  if (replyTo) headerLines.push(`Reply-To: ${replyTo}`);
  const headers = headerLines.join("\r\n");

  const bodyParts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    text ?? "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    html ?? "",
    `--${boundary}--`,
  ].join("\r\n");

  const message = headers + "\r\n\r\n" + bodyParts;
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
  const { to, subject, html, text, replyTo, alias } = input;

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

  const raw = buildRawMessage({ from, to, subject, html, text, replyTo });

  const gmail = await getInternalGmailClient(externalAccountId);
  const res = await withRetry(
    () => gmail.users.messages.send({ userId: "me", requestBody: { raw } }),
    "messages.send",
  );

  const result: SendEmailResult = {
    messageId: res.data.id ?? "",
    threadId: res.data.threadId ?? "",
    from,
  };
  log.info(
    { to, subject, alias: alias ?? "primary", messageId: result.messageId },
    "gmail message sent",
  );
  return result;
}
