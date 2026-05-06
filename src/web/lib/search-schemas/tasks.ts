// src/web/lib/search-schemas/tasks.ts
//
// Mirrors the previous useState defaults in tasks.tsx.
// Sets become arrays in URL; component rebuilds Sets via useMemo for
// O(1) membership checks.
//
// customerFilter stores id only; component re-resolves displayName by
// holding the last-selected CustomerOption in local state (passed from
// the picker on selection, cleared when id becomes null).
//
// Note: TaskStatus / TaskPriority have no centralised DB export — the
// literal tuples here must stay in sync with the types in tasks.tsx.

import { z } from "zod";

const TASK_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;

const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export { TASK_STATUSES, TASK_PRIORITIES };

export const tasksSearchSchema = z.object({
  view: z.enum(["board", "list"]).catch("board"),
  assignee: z.enum(["me", "all"]).catch("me"),
  statuses: z
    .array(z.enum(TASK_STATUSES))
    .catch(["open", "in_progress", "blocked"]),
  priorities: z.array(z.enum(TASK_PRIORITIES)).catch([]),
  tags: z.array(z.string()).catch([]),
  search: z.string().catch(""),
  customerId: z.string().nullable().catch(null),
});

export type TasksSearch = z.infer<typeof tasksSearchSchema>;
