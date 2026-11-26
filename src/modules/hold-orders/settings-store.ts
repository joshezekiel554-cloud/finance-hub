// Hold Orders Settings — load / save / "changed by" over app_settings.
// Writes: one upsert per changed key + ONE audit_log row per save
// (action holds_settings.updated, entity app_setting/holds_settings,
// before/after = {key: value} for the keys that changed).

import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { auditLog } from "../../db/schema/audit.js";
import { users } from "../../db/schema/auth.js";
import { loadAppSettings } from "../statements/settings.js";
import {
  HOLDS_SETTING_KEYS,
  diffHoldsConfig,
  lastChangedBySection,
  parseHoldsConfig,
  type HoldsConfig,
  type LastChanged,
  type SettingsAuditRow,
} from "./holds-settings.js";

export const HOLDS_SETTINGS_AUDIT_ACTION = "holds_settings.updated";

export async function loadHoldsConfig(): Promise<HoldsConfig> {
  return parseHoldsConfig(await loadAppSettings());
}

export type SaveResult = { changed: Array<{ key: string; before: string; after: string }> };

/** Persist `next` (already validated) vs `current`; no-op when nothing changed. */
export async function saveHoldsConfig(args: {
  current: HoldsConfig;
  next: HoldsConfig;
  userId: string | null;
  actorEmail: string | null;
}): Promise<SaveResult> {
  const changes = diffHoldsConfig(args.current, args.next);
  if (changes.length === 0) return { changed: [] };
  for (const c of changes) {
    await db
      .insert(appSettings)
      .values({ key: c.key, value: c.after, updatedByUserId: args.userId })
      .onDuplicateKeyUpdate({
        set: { value: c.after, updatedByUserId: args.userId, updatedAt: sql`CURRENT_TIMESTAMP` },
      });
  }
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const c of changes) {
    before[c.key] = c.before;
    after[c.key] = c.after;
  }
  await db.insert(auditLog).values({
    id: nanoid(24),
    userId: args.userId,
    action: HOLDS_SETTINGS_AUDIT_ACTION,
    entityType: "app_setting",
    entityId: "holds_settings",
    before,
    after: { ...after, actorEmail: args.actorEmail },
  });
  return { changed: changes.map((c) => ({ key: c.key, before: c.before, after: c.after })) };
}

const ALL_KEYS: string[] = Object.values(HOLDS_SETTING_KEYS);

/**
 * Newest change per Settings section: our own save rows plus finance's
 * per-key /settings writes (app_setting.update) of the shared keys.
 */
export async function loadLastChanged(): Promise<LastChanged> {
  const rows = await db
    .select({
      at: auditLog.occurredAt,
      action: auditLog.action,
      entityId: auditLog.entityId,
      before: auditLog.before,
      after: auditLog.after,
      name: users.name,
      email: users.email,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .where(
      and(
        eq(auditLog.entityType, "app_setting"),
        or(
          eq(auditLog.action, HOLDS_SETTINGS_AUDIT_ACTION),
          and(eq(auditLog.action, "app_setting.update"), inArray(auditLog.entityId, ALL_KEYS)),
        ),
      ),
    )
    .orderBy(desc(auditLog.occurredAt))
    .limit(100);
  const audit: SettingsAuditRow[] = rows.map((r) => ({
    at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
    by: r.name ?? r.email ?? null,
    keys:
      r.action === HOLDS_SETTINGS_AUDIT_ACTION
        ? Object.keys({ ...(r.before ?? {}), ...(r.after ?? {}) }).filter((k) => ALL_KEYS.includes(k))
        : [r.entityId],
  }));
  return lastChangedBySection(audit);
}
