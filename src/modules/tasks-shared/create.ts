// Shared-task CREATE core (M2) — the PURE module behind the route.
//
// Finance creates a shared task by POSTing to inbox `POST /api/svc/tasks` with
// the CREATOR as `actingMemberId` and the ASSIGNEE (optional) as `ownerId`.
// LOCKED contract with inbox (2026-06-22). Comments / @mentions / attachments
// are authored ON the embedded inbox board, NOT here — M2 finance = creation.
//
// This lives OUTSIDE the Fastify route (src/server/routes/tasks.ts re-exports
// it) so non-route callers (the AI agent tools, the email-flag auto-task path)
// can import the create core without pulling a route → module circular import.
// No Fastify imports here — pure of HTTP framing so it stays unit-testable
// (mock the identity resolver + the inbox client).

import { z } from "zod";
import { TASK_PRIORITIES } from "../../db/schema/crm.js";
import { requireMemberForUser } from "./identity.js";
import { inboxFetch } from "../../integrations/inbox/client.js";

// Maps finance's task priority vocabulary (crm.ts TASK_PRIORITIES) to the inbox
// Task model's enum. Locked contract: inbox = LOW|NORMAL|IMPORTANT|URGENT.
export const FINANCE_TO_INBOX_PRIORITY: Record<string, string> = {
  low: "LOW",
  normal: "NORMAL",
  high: "IMPORTANT",
  urgent: "URGENT",
};

// Body finance accepts from its own UI. ownerId / financeCustomerId are
// nullable+optional (null/omitted ownerId = unassigned). dueAt/reminderAt are
// ISO-8601 instants; we forward them to inbox verbatim.
export const sharedCreateBodySchema = z
  .object({
    // inbox caps title at 300 (locked contract) — validate here so we fail fast.
    title: z.string().trim().min(1).max(300),
    body: z.string().max(10_000).nullable().optional(),
    ownerId: z.string().min(1).max(255).nullable().optional(),
    financeCustomerId: z.string().min(1).max(64).nullable().optional(),
    dueAt: z.string().datetime({ offset: true }).nullable().optional(),
    reminderAt: z.string().datetime({ offset: true }).nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    // Watchers (EXCLUDES the owner) — inbox member ids. Forwarded verbatim.
    watcherIds: z.array(z.string().min(1).max(255)).max(50).optional(),
    // Recurrence (inbox contract). Field names forwarded verbatim to inbox.
    recurrenceKind: z
      .enum(["NONE", "DAILY", "WEEKDAYS", "WEEKLY", "MONTHLY", "CUSTOM"])
      .optional(),
    recurrenceInterval: z.number().int().min(1).max(365).nullable().optional(),
    recurrenceUnit: z.enum(["DAY", "WEEK", "MONTH"]).nullable().optional(),
  })
  // A repeating task (recurrenceKind != NONE) REQUIRES a dueAt — the inbox
  // recurrence engine schedules the next occurrence off the due date, so a
  // recurring task with no anchor is meaningless. Enforce server-side too (not
  // just in the dialog) so any caller of this schema is held to the contract.
  .refine(
    (v) =>
      !v.recurrenceKind ||
      v.recurrenceKind === "NONE" ||
      (v.dueAt !== undefined && v.dueAt !== null),
    {
      message: "Repeating tasks require a due date",
      path: ["dueAt"],
    },
  )
  // CUSTOM recurrence requires interval + unit — hold non-dialog callers (the AI
  // agent / a direct API call) to the contract, not just the UI. (The dialog
  // always sends both for CUSTOM.)
  .refine(
    (v) =>
      v.recurrenceKind !== "CUSTOM" ||
      (typeof v.recurrenceInterval === "number" && v.recurrenceUnit != null),
    {
      message: "Custom recurrence requires an interval and a unit",
      path: ["recurrenceInterval"],
    },
  );
export type SharedCreateBody = z.infer<typeof sharedCreateBodySchema>;

// What inbox returns from POST /api/svc/tasks (LOCKED contract). `ownerId` is the
// assignee member id.
export type InboxCreatedTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  financeCustomerId: string | null;
  ownerId: string | null;
};
type InboxCreateResponse = { task: InboxCreatedTask };

/**
 * Resolve the finance user → their inbox member, then create the shared task in
 * inbox (the canonical store) with `actingMemberId` = the creator. Pure of HTTP
 * framing so it is unit-testable (mock identity + the inbox client). Surfaces
 * NoInboxAccountError / InboxUnreachableError / InboxApiError to the caller for
 * status mapping.
 */
export async function createSharedTaskForUser(
  user: { email: string | null | undefined },
  input: SharedCreateBody,
): Promise<InboxCreatedTask> {
  const member = await requireMemberForUser({ email: user.email ?? "" });
  const res = await inboxFetch<InboxCreateResponse>("/api/svc/tasks", {
    method: "POST",
    body: JSON.stringify({
      actingMemberId: member.teamMemberId,
      title: input.title,
      // Only forward the optional fields the caller actually set, so we don't
      // pin inbox defaults (e.g. send `ownerId: null` only when explicitly
      // unassigning vs omitting).
      // Field-name reconciliation to the locked inbox model: body→notes,
      // reminderAt→remindAt, priority mapped to inbox's enum.
      ...(input.body !== undefined ? { notes: input.body } : {}),
      ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
      ...(input.financeCustomerId !== undefined
        ? { financeCustomerId: input.financeCustomerId }
        : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.reminderAt !== undefined ? { remindAt: input.reminderAt } : {}),
      ...(input.priority !== undefined
        ? { priority: FINANCE_TO_INBOX_PRIORITY[input.priority] ?? "NORMAL" }
        : {}),
      // Watchers + recurrence — field names match the inbox contract verbatim,
      // forwarded only when the caller set them (same conditional-spread story).
      ...(input.watcherIds !== undefined ? { watcherIds: input.watcherIds } : {}),
      ...(input.recurrenceKind !== undefined
        ? { recurrenceKind: input.recurrenceKind }
        : {}),
      ...(input.recurrenceInterval !== undefined
        ? { recurrenceInterval: input.recurrenceInterval }
        : {}),
      ...(input.recurrenceUnit !== undefined
        ? { recurrenceUnit: input.recurrenceUnit }
        : {}),
    }),
  });
  return res.task;
}
