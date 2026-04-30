// Logo upload + serve endpoints for the Statement PDF settings.
//
// POST /api/logo-upload
//   multipart/form-data with a single field "logo". Accepts png/jpeg/svg
//   only, max 2MB. Saves under data/logos/ with a randomized filename
//   (so a re-upload doesn't shadow-cache in the browser), then writes
//   the absolute path to app_settings.company_logo_path. Audit-logged.
//
// GET  /api/static/logo
//   Streams the bytes referenced by app_settings.company_logo_path.
//   Auth-gated — the Settings UI uses this to render a preview after
//   upload; the PDF renderer reads the file from disk directly.
//
// Multer is express-shaped, so we adapt by registering a passthrough
// multipart content-type parser on this scope (so Fastify doesn't 415
// the request) and then invoke multer's middleware against req.raw +
// reply.raw. multer mutates req.raw with .file/.body, which we read
// back to complete the handler.
//
// The content-type parser registration is plugin-scoped (Fastify
// encapsulation) so it doesn't leak to other routes.

import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import multer from "multer";
import { db } from "../../db/index.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { auditLog } from "../../db/schema/audit.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger({ component: "routes.logo-upload" });

const LOGO_DIR = path.resolve(process.cwd(), "data", "logos");
const MAX_BYTES = 2 * 1024 * 1024;

// Map of accepted MIME types to the canonical extension we'll write to
// disk. The PDF renderer reads from disk by path, so we keep the
// extension stable and trustworthy rather than echoing whatever the
// client sent.
const ACCEPTED_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ACCEPTED_MIME[file.mimetype]) {
      cb(new Error("UNSUPPORTED_MIME"));
      return;
    }
    cb(null, true);
  },
});

const singleLogo = upload.single("logo");

// Sniff Content-Type for GET /api/static/logo from the file extension on
// disk. We control the extension at write-time so this is deterministic.
function contentTypeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function loadLogoPath(): Promise<string | null> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "company_logo_path"))
    .limit(1);
  const value = rows[0]?.value;
  if (!value) return null;
  return value;
}

const logoUploadRoute: FastifyPluginAsync = async (app) => {
  // Passthrough content-type parser. Fastify natively 415s unknown
  // types — multer needs to read the body itself off the raw socket,
  // so we tell Fastify to leave it alone for this scope.
  app.addContentTypeParser(
    /^multipart\/form-data/,
    (_req, _payload, done) => done(null),
  );

  app.post("/logo-upload", async (req, reply) => {
    const user = await requireAuth(req);

    // Run multer against the raw Node req/res. Wrap in a promise so we
    // can await the callback-driven middleware. multer mutates req.raw
    // with .file (the parsed upload) on success.
    try {
      await new Promise<void>((resolve, reject) => {
        singleLogo(
          req.raw as Parameters<typeof singleLogo>[0],
          reply.raw as Parameters<typeof singleLogo>[1],
          (err: unknown) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "upload failed";
      if (message === "UNSUPPORTED_MIME") {
        return reply.code(400).send({
          error:
            "Wrong format — only PNG, JPEG, or SVG files are accepted.",
        });
      }
      // multer's own LIMIT_FILE_SIZE error code lands here.
      if (message.includes("File too large") || message.includes("LIMIT_FILE_SIZE")) {
        return reply.code(400).send({
          error: "File too large — max 2 MB.",
        });
      }
      log.warn({ err }, "logo upload parse failed");
      return reply.code(400).send({ error: message });
    }

    const file = (req.raw as unknown as { file?: Express.Multer.File }).file;
    if (!file) {
      return reply.code(400).send({ error: "Missing 'logo' field." });
    }

    const ext = ACCEPTED_MIME[file.mimetype];
    if (!ext) {
      return reply.code(400).send({
        error: "Wrong format — only PNG, JPEG, or SVG files are accepted.",
      });
    }

    if (!existsSync(LOGO_DIR)) {
      await fs.mkdir(LOGO_DIR, { recursive: true });
    }

    const filename = `logo-${nanoid(12)}.${ext}`;
    const storedPath = path.join(LOGO_DIR, filename);
    await fs.writeFile(storedPath, file.buffer);

    // Capture the previous path so we can audit the diff and best-effort
    // delete the old file (small disk hygiene; failures don't block).
    const beforeRows = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "company_logo_path"))
      .limit(1);
    const before = beforeRows[0];

    if (before) {
      await db
        .update(appSettings)
        .set({ value: storedPath, updatedByUserId: user.id })
        .where(eq(appSettings.key, "company_logo_path"));
    } else {
      await db.insert(appSettings).values({
        key: "company_logo_path",
        value: storedPath,
        description:
          "Disk path of the uploaded logo (managed via /api/logo-upload).",
        updatedByUserId: user.id,
      });
    }

    if (before?.value && before.value !== storedPath) {
      try {
        await fs.unlink(before.value);
      } catch {
        // Old file may already be gone or live in a stale location — not
        // fatal, just disk debris we tried to clean up.
      }
    }

    await db.insert(auditLog).values({
      id: nanoid(24),
      userId: user.id,
      action: "app_setting.update",
      entityType: "app_setting",
      entityId: "company_logo_path",
      before: before ? { value: before.value } : null,
      after: { value: storedPath },
    });

    log.info(
      {
        userId: user.id,
        path: storedPath,
        bytes: file.size,
        mime: file.mimetype,
      },
      "logo uploaded",
    );

    return reply.send({
      ok: true,
      path: storedPath,
      url: "/api/static/logo",
    });
  });

  // GET /api/static/logo — auth-gated stream of the stored logo bytes.
  // The Statement PDF renderer reads the file from disk directly (off
  // the same path we persist here), so this route exists only for the
  // Settings UI preview img.
  app.get("/static/logo", async (req, reply) => {
    await requireAuth(req);
    const stored = await loadLogoPath();
    if (!stored) return reply.code(404).send({ error: "no logo configured" });

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(stored);
    } catch (err) {
      log.warn({ err, path: stored }, "logo file missing on disk");
      return reply.code(404).send({ error: "logo file missing" });
    }
    const ext = path.extname(stored);
    return reply
      .header("content-type", contentTypeFromExt(ext))
      .header("cache-control", "no-store")
      .send(bytes);
  });
};

export default logoUploadRoute;
