// App-settings CRUD endpoints.
//
// Drives the Settings → Statement defaults UI. The 9 canonical keys are
// listed in src/db/schema/app-settings.ts (APP_SETTING_KEYS); writes to
// any other key are rejected so the UI can't silently insert garbage.
// Reads return everything from the table (including any user-defined
// keys the brief leaves room for).
//
// Auth-gated. Each PATCHed key writes its own audit_log row so the
// trail records each individual setting change with its before/after
// rather than a coarse "settings updated" entry. The `updated_by_user_id`
// column on the row itself also records the most-recent operator.
//
// Mounting: registered by team-lead in src/server/routes/index.ts at
// `/api/app-settings`. The brief reserves index.ts to the team-lead so
// this file just exports the plugin and trusts the wire-up.

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import {
  APP_SETTING_KEYS,
  appSettings,
} from "../../db/schema/app-settings.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.app-settings" });

// PATCH body — each value capped at 16 KB to stay well under the TEXT
// column's 64 KB ceiling and to defend against accidental paste-bombs.
// The PDF renderer assumes each line of company_address /
// payment_methods is <= 200 chars; we don't enforce that at the API
// layer because line wrapping is a render concern, not a storage one.
const VALUE_MAX = 16 * 1024;
const patchBodySchema = z
  .record(z.string().max(64), z.string().max(VALUE_MAX))
  .refine((obj) => Object.keys(obj).length > 0, {
    message: "body must contain at least one key",
  });

const appSettingsRoute: FastifyPluginAsync = async (app) => {
  // GET /api/app-settings — return every row as { [key]: value }.
  // Includes any user-defined keys; the canonical 9 are always present
  // (loadAllAppSettings fills in defaults). The frontend keys off
  // APP_SETTING_KEYS for the visible inputs and treats anything else as
  // read-only-display.
  app.get("/", async (req, reply) => {
    await requireAuth(req);
    const rows = await db.select().from(appSettings);
    const map: Record<string, string> = {};
    // Seed defaults so a fresh install renders blank inputs rather than
    // missing-key errors. Only the canonical keys get defaulted; other
    // rows show up exactly as stored.
    for (const k of APP_SETTING_KEYS) {
      map[k] = "";
    }
    for (const r of rows) {
      map[r.key] = r.value ?? "";
    }
    return reply.send({ settings: map });
  });

  // PATCH /api/app-settings — partial update. Body: { [key]: value }.
  //
  // - Rejects unknown keys with 400 + a list of invalid keys (so the UI
  //   can show "you tried to write 'foo' but that key isn't allowed").
  // - For each provided key, UPSERTs the row (no row → insert; existing
  //   → update) and writes a per-key audit_log entry.
  // - Returns the full updated map so the frontend doesn't need a
  //   follow-up GET.
  app.patch("/", async (req, reply) => {
    const user = await requireAuth(req);
    const parse = patchBodySchema.safeParse(req.body);
    if (!parse.success) {
      return reply
        .code(400)
        .send({ error: "invalid body", details: parse.error.flatten() });
    }
    const body = parse.data;

    const allowed = new Set<string>(APP_SETTING_KEYS);
    const invalid = Object.keys(body).filter((k) => !allowed.has(k));
    if (invalid.length > 0) {
      return reply.code(400).send({
        error: "unknown setting keys",
        invalidKeys: invalid,
        allowedKeys: APP_SETTING_KEYS,
      });
    }

    // Pre-load existing values so the audit log records before/after.
    const existing = await db.select().from(appSettings);
    const beforeMap = new Map<string, string>();
    for (const r of existing) {
      beforeMap.set(r.key, r.value ?? "");
    }

    for (const [key, value] of Object.entries(body)) {
      if (beforeMap.has(key)) {
        await db
          .update(appSettings)
          .set({
            value,
            updatedByUserId: user.id,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(eq(appSettings.key, key));
      } else {
        await db.insert(appSettings).values({
          key,
          value,
          updatedByUserId: user.id,
        });
      }
      await db.insert(auditLog).values({
        id: nanoid(24),
        userId: user.id,
        action: "app_setting.update",
        entityType: "app_setting",
        entityId: key,
        before: beforeMap.has(key) ? { value: beforeMap.get(key) } : null,
        after: { value },
      });
    }

    log.info(
      {
        userId: user.id,
        keys: Object.keys(body),
      },
      "app settings updated",
    );

    // Return the full refreshed map.
    const rows = await db.select().from(appSettings);
    const map: Record<string, string> = {};
    for (const k of APP_SETTING_KEYS) map[k] = "";
    for (const r of rows) map[r.key] = r.value ?? "";
    return reply.send({ settings: map });
  });
};

export default appSettingsRoute;
