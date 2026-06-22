// Inbox service client. The DIRECTION FLIP for the shared-tasks feature:
// finance calls INTO the sibling inbox app (mirror of how inbox reads finance's
// /api/ext). Every call carries `Authorization: Bearer <INBOX_SERVICE_TOKEN>`
// against `INBOX_BASE_URL` (loopback on the shared VPS by default).
//
// Endpoints finance consumes (locked contract, 2026-06-22):
//   GET  /api/svc/members                 → identity map / assignable members
//   GET  /api/svc/tasks?assigneeId=&…     → list (my-tasks widget)        [M1+]
//   POST /api/svc/tasks                    → create                        [M2+]
// Only the typed fetch wrapper + error normalization live here; per-endpoint
// helpers live in their own modules (e.g. members.ts).

import { env } from "../../lib/env.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "inbox.client" });

/** Thrown on any non-2xx response from the inbox service. */
export class InboxApiError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "InboxApiError";
    this.status = status;
    this.body = body;
  }
}

/** Thrown when the request never reaches the inbox service (network/DNS/refused). */
export class InboxUnreachableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "InboxUnreachableError";
  }
}

function baseUrl(): string {
  // Strip a trailing slash so `${base}${path}` never doubles up.
  return env.INBOX_BASE_URL.replace(/\/+$/, "");
}

/**
 * Typed fetch wrapper. Issues a bearer-authed JSON request to the inbox
 * service and parses the JSON body. Throws InboxApiError on non-2xx and
 * InboxUnreachableError when the request fails to complete.
 */
export async function inboxFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${baseUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.INBOX_SERVICE_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    log.warn({ path, err }, "inbox service unreachable");
    throw new InboxUnreachableError(`Inbox service unreachable at ${url}`, err);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.warn({ status: res.status, path, body }, "inbox api error");
    throw new InboxApiError(
      `Inbox ${res.status}: ${body || res.statusText}`,
      res.status,
      body,
    );
  }

  return res.json() as Promise<T>;
}
