// Photo upload / list / delete routes for RMA photos.
//
// Mounts under /api/rmas/:id/photos (registered by returns.ts).
//
// Multipart handling uses the same multer + content-type-parser pattern
// as logo-upload.ts: Fastify is told to pass multipart/form-data through
// untouched; multer reads the raw socket and populates req.raw.file.
//
// POST  /api/rmas/:id/photos     — upload one photo
// GET   /api/rmas/:id/photos     — list photos for RMA (sorted by position)
// DELETE /api/rmas/:id/photos/:photoId — delete one photo

import type { FastifyPluginAsync } from "fastify";
import multer from "multer";
import { asc, count, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../db/index.js";
import { rmas, rmaPhotos } from "../../db/schema/returns.js";
import { appSettings } from "../../db/schema/app-settings.js";
import { requireAuth } from "../lib/auth.js";
import { createLogger } from "../../lib/logger.js";
import {
  uploadFile,
  deleteFile,
  ensureFolder,
  makeViewable,
} from "../../integrations/google-drive/index.js";
import { getRmaById } from "../../modules/returns/index.js";

const log = createLogger({ component: "routes.returns-photos" });

// 20 MB — enough headroom for high-res phone photos (typical 8-12 MP JPEG
// is 3-6 MB; 20 gives room for RAW / burst-mode shots users occasionally
// send). Revisit if storage costs become a concern.
const MAX_BYTES = 20 * 1024 * 1024;

const ACCEPTED_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
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

const singleFile = upload.single("file");

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const returnsPhotosRoute: FastifyPluginAsync = async (app) => {
  // Content-type passthrough so multer can own the body parsing for this scope.
  app.addContentTypeParser(
    /^multipart\/form-data/,
    (_req, _payload, done) => done(null),
  );

  // ---- POST / — upload one photo ------------------------------------------
  // bodyLimit overrides Fastify's 1MB default so phone photos (3-6 MB) and
  // RAW shots (up to 20 MB per MAX_BYTES below) aren't rejected at the
  // connection layer before multer can parse them.
  app.post<{ Params: { id: string } }>("/", { bodyLimit: MAX_BYTES + 1024 * 1024 }, async (req, reply) => {
    const user = await requireAuth(req);

    // 1. Resolve RMA
    const rma = await getRmaById(req.params.id);
    if (!rma) {
      return reply.code(404).send({ error: "RMA not found" });
    }

    // 2. Read drive_root_folder_id from app_settings
    const settingRows = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, "drive_root_folder_id"))
      .limit(1);
    const rootFolderId = settingRows[0]?.value?.trim() ?? "";
    if (!rootFolderId) {
      return reply.code(412).send({
        error:
          "Returns photos root folder not configured. Set drive_root_folder_id in settings.",
      });
    }

    // 3. Parse multipart upload
    try {
      await new Promise<void>((resolve, reject) => {
        singleFile(
          req.raw as Parameters<typeof singleFile>[0],
          reply.raw as Parameters<typeof singleFile>[1],
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
            "Unsupported file type — accepted: JPEG, PNG, WebP, HEIC.",
        });
      }
      if (
        message.includes("File too large") ||
        message.includes("LIMIT_FILE_SIZE")
      ) {
        return reply.code(400).send({
          error: `File too large — max ${MAX_BYTES / 1024 / 1024} MB.`,
        });
      }
      log.warn({ err }, "photo upload parse failed");
      return reply.code(400).send({ error: message });
    }

    const file = (req.raw as unknown as { file?: Express.Multer.File }).file;
    if (!file) {
      return reply.code(400).send({ error: "Missing 'file' field." });
    }

    // 4. Determine / ensure Drive folder
    const folderLabel = rma.rmaNumber ?? `RMA-${rma.id}`;
    let folderId: string;

    if (rma.driveFolderId) {
      folderId = rma.driveFolderId;
    } else {
      try {
        folderId = await ensureFolder({
          userId: user.id,
          parentId: rootFolderId,
          name: folderLabel,
        });
      } catch (err) {
        log.error({ err, rmaId: rma.id }, "failed to ensure Drive folder");
        return reply.code(502).send({
          error: "Failed to create Drive folder — check Google Drive authorization.",
        });
      }
      // Persist folderId on the RMA row so subsequent uploads skip the lookup.
      await db
        .update(rmas)
        .set({ driveFolderId: folderId })
        .where(eq(rmas.id, rma.id));
    }

    // 5. Determine filename: {folderLabel}_{yyyymmdd}_{n}.{ext}
    const photoCountRows = await db
      .select({ n: count() })
      .from(rmaPhotos)
      .where(eq(rmaPhotos.rmaId, rma.id));
    const existingCount = Number(photoCountRows[0]?.n ?? 0);
    const photoNumber = existingCount + 1;

    const now = new Date();
    const pad = (v: number) => String(v).padStart(2, "0");
    const datePart =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const rawExt = ACCEPTED_MIME[file.mimetype] ?? "jpg";
    const filename = `${folderLabel}_${datePart}_${photoNumber}.${rawExt}`;

    // 6. Upload to Drive
    let uploadResult: Awaited<ReturnType<typeof uploadFile>>;
    try {
      uploadResult = await uploadFile({
        userId: user.id,
        folderId,
        filename,
        mimeType: file.mimetype,
        content: file.buffer,
      });
    } catch (err) {
      log.error({ err, rmaId: rma.id }, "Drive upload failed");
      return reply.code(502).send({
        error: "Drive upload failed — check Google Drive authorization.",
      });
    }

    // 7. Make file publicly viewable (so thumbnail URLs work without sign-in)
    try {
      await makeViewable({ userId: user.id, fileId: uploadResult.fileId });
    } catch (err) {
      // Non-fatal: view link still works for signed-in users; log + continue.
      log.warn({ err, fileId: uploadResult.fileId }, "makeViewable failed; continuing");
    }

    // 8. Insert rma_photos row
    const photoId = nanoid(24);
    const newPhoto = {
      id: photoId,
      rmaId: rma.id,
      position: existingCount, // 0-indexed
      driveFileId: uploadResult.fileId,
      driveViewUrl: uploadResult.viewUrl,
      driveThumbnailUrl: uploadResult.thumbnailUrl,
      filename,
      mimeType: file.mimetype,
      sizeBytes: uploadResult.sizeBytes,
      uploadedByUserId: user.id,
      uploadedAt: now,
    };

    await db.insert(rmaPhotos).values(newPhoto);

    log.info(
      { rmaId: rma.id, fileId: uploadResult.fileId, filename, sizeBytes: uploadResult.sizeBytes },
      "rma photo uploaded",
    );

    return reply.code(201).send(newPhoto);
  });

  // ---- GET / — list photos for an RMA -------------------------------------
  app.get<{ Params: { id: string } }>("/", async (req, reply) => {
    await requireAuth(req);

    const rma = await getRmaById(req.params.id);
    if (!rma) {
      return reply.code(404).send({ error: "RMA not found" });
    }

    const photos = await db
      .select()
      .from(rmaPhotos)
      .where(eq(rmaPhotos.rmaId, rma.id))
      .orderBy(asc(rmaPhotos.position));

    return reply.send({ photos });
  });

  // ---- DELETE /:photoId — delete one photo --------------------------------
  app.delete<{ Params: { id: string; photoId: string } }>(
    "/:photoId",
    async (req, reply) => {
      const user = await requireAuth(req);

      const photoRows = await db
        .select()
        .from(rmaPhotos)
        .where(eq(rmaPhotos.id, req.params.photoId))
        .limit(1);
      const photo = photoRows[0];
      if (!photo) {
        return reply.code(404).send({ error: "Photo not found" });
      }

      // Best-effort Drive delete — don't fail the row delete if Drive is unavailable.
      try {
        await deleteFile({ userId: user.id, fileId: photo.driveFileId });
      } catch (err) {
        log.warn(
          { err, fileId: photo.driveFileId, photoId: photo.id },
          "Drive delete failed; deleting DB row anyway",
        );
      }

      await db.delete(rmaPhotos).where(eq(rmaPhotos.id, photo.id));

      log.info(
        { rmaId: photo.rmaId, photoId: photo.id, fileId: photo.driveFileId },
        "rma photo deleted",
      );

      return reply.code(204).send();
    },
  );
};

export default returnsPhotosRoute;
