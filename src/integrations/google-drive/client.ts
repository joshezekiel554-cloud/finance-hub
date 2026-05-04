// Google Drive client for RMA photo upload + folder management.
//
// Auth pattern mirrors src/integrations/gmail/client.ts exactly:
//   - Tokens stored in `oauth_tokens` table with provider="gmail" (Drive
//     uses the same Google OAuth flow; the drive.file scope was added in
//     Phase 2 Task 2).
//   - Tokens loaded by externalAccountId (= the Google account email) or
//     by the first gmail row when no ID is specified.
//   - On successful Drive API calls, googleapis emits "tokens" when it
//     refreshes; we persist the updated token back to the DB.
//
// Each exported function accepts `userId` (the app user's UUID) which is
// currently used only to satisfy the call signature — Drive operations
// use the shared Google OAuth token (single-mailbox setup), not per-user
// tokens. This parameter is reserved for future multi-user token routing.

import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { and, eq } from "drizzle-orm";
import { db } from "~/db/index.js";
import { accounts } from "~/db/schema/auth.js";
import { oauthTokens } from "~/db/schema/oauth.js";
import { decrypt, encrypt } from "~/lib/crypto.js";
import { env } from "~/lib/env.js";
import { createLogger } from "~/lib/logger.js";

const log = createLogger({ module: "google-drive.client" });

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export type DriveUploadResult = {
  fileId: string;
  viewUrl: string;
  thumbnailUrl: string | null;
  mimeType: string;
  sizeBytes: number;
};

// ---------------------------------------------------------------------------
// Internal token helpers (shared with Gmail — same table, same provider)
// ---------------------------------------------------------------------------

type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  externalAccountId: string;
};

type StoredToken = {
  rowId: string;
  externalAccountId: string;
  tokens: TokenSet;
};

// Either scope is sufficient: `drive.file` is the minimal per-file scope;
// `drive` is the full Drive scope. Both let us upload + manage files via
// the Drive API.
const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file",
];
const TOKEN_REFRESH_LEAD_MS = 60_000;

function buildOAuth2Client(): OAuth2Client {
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    `${env.PUBLIC_URL.replace(/\/$/, "")}/oauth/callback/gmail`,
  );
}

async function loadStoredToken(userId?: string): Promise<StoredToken | null> {
  // Drive uses tokens from the Auth.js `accounts` table (provider=google).
  // The user signs in via Auth.js with the drive.file scope; that grant
  // lands here. We prefer this source over the legacy oauth_tokens row
  // used by Gmail polling (which doesn't include drive.file).
  if (userId) {
    const rows = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.userId, userId), eq(accounts.provider, "google")))
      .limit(1);
    const row = rows[0];
    if (row?.access_token && row?.refresh_token) {
      return {
        rowId: `account:${row.userId}:${row.providerAccountId}`,
        externalAccountId: row.providerAccountId,
        tokens: {
          accessToken: row.access_token,
          refreshToken: row.refresh_token,
          expiresAt:
            row.expires_at != null ? new Date(row.expires_at * 1000) : null,
          scope: row.scope ?? null,
          externalAccountId: row.providerAccountId,
        },
      };
    }
  }

  // Fallback: legacy oauth_tokens row (used by Gmail polling).
  const rows = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.provider, "gmail"))
    .limit(1);

  const row = rows[0];
  if (!row || row.revokedAt) return null;
  if (row.externalAccountId.startsWith("pending:")) return null;

  return {
    rowId: row.id,
    externalAccountId: row.externalAccountId,
    tokens: {
      accessToken: decrypt(row.accessTokenEnc),
      refreshToken: row.refreshTokenEnc ? decrypt(row.refreshTokenEnc) : null,
      expiresAt: row.expiresAt,
      scope: row.scope,
      externalAccountId: row.externalAccountId,
    },
  };
}

async function persistToken(
  rowId: string,
  externalAccountId: string,
  tokens: TokenSet,
): Promise<void> {
  await db
    .update(oauthTokens)
    .set({
      externalAccountId,
      accessTokenEnc: encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    })
    .where(eq(oauthTokens.id, rowId));
}

function tokenHasDriveScope(scope: string | null): boolean {
  if (!scope) return false;
  const granted = scope.split(/\s+/).filter(Boolean);
  return DRIVE_SCOPES.some((s) => granted.includes(s));
}

// ---------------------------------------------------------------------------
// Build an authenticated OAuth2Client for Drive calls
// ---------------------------------------------------------------------------

async function getDriveClient(userId?: string): Promise<ReturnType<typeof google.drive>> {
  const stored = await loadStoredToken(userId);
  if (!stored) {
    throw new Error(
      "Drive not authenticated. Sign out and sign back in via Google to grant photo upload permission.",
    );
  }
  if (!stored.tokens.refreshToken) {
    throw new Error(
      "Drive token has no refresh_token — re-auth required to obtain offline access.",
    );
  }
  if (!tokenHasDriveScope(stored.tokens.scope)) {
    throw new Error(
      "Drive not authorized — sign out and sign back in to grant photo upload permission.",
    );
  }

  const oauth = buildOAuth2Client();
  oauth.setCredentials({
    access_token: stored.tokens.accessToken,
    refresh_token: stored.tokens.refreshToken,
    expiry_date: stored.tokens.expiresAt ? stored.tokens.expiresAt.getTime() : undefined,
    scope: stored.tokens.scope ?? undefined,
  });

  oauth.on("tokens", (next) => {
    void (async () => {
      try {
        const merged: TokenSet = {
          accessToken: next.access_token ?? stored.tokens.accessToken,
          refreshToken: next.refresh_token ?? stored.tokens.refreshToken,
          expiresAt: next.expiry_date
            ? new Date(next.expiry_date)
            : stored.tokens.expiresAt,
          scope: next.scope ?? stored.tokens.scope,
          externalAccountId: stored.externalAccountId,
        };
        await persistToken(stored.rowId, stored.externalAccountId, merged);
        log.debug({ externalAccountId: stored.externalAccountId }, "drive tokens refreshed");
      } catch (err) {
        log.error({ err }, "failed to persist refreshed Drive tokens");
      }
    })();
  });

  // Eagerly refresh if the access token is within the lead window.
  if (
    stored.tokens.expiresAt &&
    stored.tokens.expiresAt.getTime() - Date.now() < TOKEN_REFRESH_LEAD_MS
  ) {
    await oauth.getAccessToken();
  }

  return google.drive({ version: "v3", auth: oauth });
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Upload a file into a Drive folder.
 * Returns metadata needed to populate the rma_photos row.
 */
export async function uploadFile(input: {
  userId: string;
  folderId: string;
  filename: string;
  mimeType: string;
  content: Buffer | NodeJS.ReadableStream;
}): Promise<DriveUploadResult> {
  const drive = await getDriveClient(input.userId);
  const { folderId, filename, mimeType, content } = input;

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
      mimeType,
    },
    media: {
      mimeType,
      body: content,
    },
    fields: "id,webViewLink,thumbnailLink,mimeType,size",
    supportsAllDrives: true,
  });

  const file = res.data;
  if (!file.id) throw new Error("Drive upload returned no file id");

  return {
    fileId: file.id,
    viewUrl: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
    thumbnailUrl: file.thumbnailLink ?? null,
    mimeType: file.mimeType ?? mimeType,
    sizeBytes: Number(file.size ?? 0),
  };
}

/**
 * Delete a file from Drive.
 * Silently swallows 404 (file already gone).
 */
export async function deleteFile(input: {
  userId: string;
  fileId: string;
}): Promise<void> {
  const drive = await getDriveClient(input.userId);
  try {
    await drive.files.delete({ fileId: input.fileId, supportsAllDrives: true });
  } catch (err) {
    const status = (err as { code?: number; response?: { status?: number } })?.response?.status
      ?? (err as { code?: number })?.code;
    if (status === 404) {
      log.warn({ fileId: input.fileId }, "Drive file already deleted — ignoring 404");
      return;
    }
    throw err;
  }
}

/**
 * Ensure a folder exists inside `parentId` with the given `name`.
 * If the folder already exists, return its ID. Otherwise create it.
 */
export async function ensureFolder(input: {
  userId: string;
  parentId: string;
  name: string;
}): Promise<string> {
  const drive = await getDriveClient(input.userId);
  const { parentId, name } = input;

  // Search for an existing folder with this name under the parent.
  const listRes = await drive.files.list({
    q: `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
    fields: "files(id,name)",
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const existing = listRes.data.files?.[0];
  if (existing?.id) {
    log.debug({ name, parentId, folderId: existing.id }, "drive folder already exists");
    return existing.id;
  }

  // Create the folder.
  const createRes = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId],
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
    supportsAllDrives: true,
  });

  const folderId = createRes.data.id;
  if (!folderId) throw new Error(`Failed to create Drive folder "${name}"`);
  log.info({ name, parentId, folderId }, "drive folder created");
  return folderId;
}

/**
 * Rename a Drive folder.
 */
export async function renameFolder(input: {
  userId: string;
  folderId: string;
  newName: string;
}): Promise<void> {
  const drive = await getDriveClient(input.userId);
  await drive.files.update({
    fileId: input.folderId,
    requestBody: { name: input.newName },
  });
  log.info({ folderId: input.folderId, newName: input.newName }, "drive folder renamed");
}

/**
 * Grant anyone-with-link read access to a file (so thumbnails/view URLs work
 * for users who aren't signed into Google).
 */
export async function makeViewable(input: {
  userId: string;
  fileId: string;
}): Promise<void> {
  const drive = await getDriveClient(input.userId);
  await drive.permissions.create({
    fileId: input.fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });
  log.debug({ fileId: input.fileId }, "drive file made publicly viewable");
}

/**
 * Download the binary content of a Drive file.
 * Returns a Buffer. Caller handles MIME type detection.
 */
export async function downloadFileContent(input: {
  userId: string;
  fileId: string;
}): Promise<Buffer> {
  const drive = await getDriveClient(input.userId);
  const res = await drive.files.get(
    { fileId: input.fileId, alt: "media" },
    { responseType: "arraybuffer" },
  );
  const data = res.data as ArrayBuffer;
  return Buffer.from(data);
}
