import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — must be defined before any imports
// ---------------------------------------------------------------------------

// Mock the db layer
const mockDbSelect = vi.hoisted(() => vi.fn());
const mockDbUpdate = vi.hoisted(() => vi.fn());
vi.mock("~/db/index.js", () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
  },
}));

// Mock crypto helpers
vi.mock("~/lib/crypto.js", () => ({
  decrypt: vi.fn((v: string) => `decrypted:${v}`),
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
}));

// Mock env
vi.mock("~/lib/env.js", () => ({
  env: {
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    PUBLIC_URL: "https://test.example.com",
  },
}));

// Mock logger
vi.mock("~/lib/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock the Drive API methods
const driveFilesCreateMock = vi.hoisted(() => vi.fn());
const driveFilesDeleteMock = vi.hoisted(() => vi.fn());
const driveFilesListMock = vi.hoisted(() => vi.fn());
const driveFilesUpdateMock = vi.hoisted(() => vi.fn());
const drivePermissionsCreateMock = vi.hoisted(() => vi.fn());
const oauthGetAccessTokenMock = vi.hoisted(() => vi.fn().mockResolvedValue({ token: "tok" }));
const oauthOnMock = vi.hoisted(() => vi.fn());
const oauthSetCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock("googleapis", () => {
  const mockDriveInstance = {
    files: {
      create: driveFilesCreateMock,
      delete: driveFilesDeleteMock,
      list: driveFilesListMock,
      update: driveFilesUpdateMock,
    },
    permissions: {
      create: drivePermissionsCreateMock,
    },
  };

  const mockOAuth2Instance = {
    setCredentials: oauthSetCredentialsMock,
    on: oauthOnMock,
    getAccessToken: oauthGetAccessTokenMock,
  };

  return {
    google: {
      auth: {
        OAuth2: vi.fn(() => mockOAuth2Instance),
      },
      drive: vi.fn(() => mockDriveInstance),
    },
  };
});

vi.mock("google-auth-library", () => ({
  OAuth2Client: vi.fn(),
}));

vi.mock("~/db/schema/oauth.js", () => ({
  oauthTokens: { provider: "provider", externalAccountId: "externalAccountId" },
}));

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Wire up mockDbSelect to return a stored token row. */
function setupValidToken() {
  // loadStoredToken calls db.select().from().where().limit(1)
  const chainNode = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([
      {
        id: "token-row-1",
        provider: "gmail",
        externalAccountId: "user@example.com",
        accessTokenEnc: "enc-access",
        refreshTokenEnc: "enc-refresh",
        expiresAt: new Date(Date.now() + 3_600_000), // 1 hour from now
        scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.file",
        revokedAt: null,
      },
    ]),
  };
  mockDbSelect.mockReturnValue(chainNode);
  return chainNode;
}

// ---------------------------------------------------------------------------
// Import subject (after mocks)
// ---------------------------------------------------------------------------
import {
  uploadFile,
  deleteFile,
  ensureFolder,
  renameFolder,
  makeViewable,
} from "./client.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("uploadFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidToken();
  });

  it("calls drive.files.create with correct params and returns mapped result", async () => {
    driveFilesCreateMock.mockResolvedValue({
      data: {
        id: "file-abc123",
        webViewLink: "https://drive.google.com/file/d/file-abc123/view",
        thumbnailLink: "https://drive.google.com/thumbnail/file-abc123",
        mimeType: "image/jpeg",
        size: "102400",
      },
    });

    const result = await uploadFile({
      userId: "user-1",
      folderId: "folder-xyz",
      filename: "DC-20260504-120000_20260504_1.jpg",
      mimeType: "image/jpeg",
      content: Buffer.from("fake-bytes"),
    });

    expect(driveFilesCreateMock).toHaveBeenCalledOnce();
    const callArg = driveFilesCreateMock.mock.calls[0][0] as {
      requestBody: { name: string; parents: string[]; mimeType: string };
      media: { mimeType: string };
      fields: string;
    };
    expect(callArg.requestBody.name).toBe("DC-20260504-120000_20260504_1.jpg");
    expect(callArg.requestBody.parents).toEqual(["folder-xyz"]);
    expect(callArg.requestBody.mimeType).toBe("image/jpeg");
    expect(callArg.media.mimeType).toBe("image/jpeg");
    expect(callArg.fields).toContain("id");
    expect(callArg.fields).toContain("webViewLink");

    expect(result.fileId).toBe("file-abc123");
    expect(result.viewUrl).toBe("https://drive.google.com/file/d/file-abc123/view");
    expect(result.thumbnailUrl).toBe("https://drive.google.com/thumbnail/file-abc123");
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.sizeBytes).toBe(102400);
  });

  it("constructs a fallback viewUrl when webViewLink is missing", async () => {
    driveFilesCreateMock.mockResolvedValue({
      data: { id: "file-nv", webViewLink: null, thumbnailLink: null, mimeType: "image/png", size: "1024" },
    });

    const result = await uploadFile({
      userId: "u",
      folderId: "f",
      filename: "photo.png",
      mimeType: "image/png",
      content: Buffer.from("x"),
    });

    expect(result.viewUrl).toBe("https://drive.google.com/file/d/file-nv/view");
    expect(result.thumbnailUrl).toBeNull();
  });

  it("throws when Drive returns no file id", async () => {
    driveFilesCreateMock.mockResolvedValue({ data: {} });
    await expect(
      uploadFile({ userId: "u", folderId: "f", filename: "x.jpg", mimeType: "image/jpeg", content: Buffer.from("") }),
    ).rejects.toThrow(/no file id/i);
  });
});

describe("deleteFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidToken();
  });

  it("calls drive.files.delete with the given fileId", async () => {
    driveFilesDeleteMock.mockResolvedValue({});
    await deleteFile({ userId: "u", fileId: "file-to-delete" });
    expect(driveFilesDeleteMock).toHaveBeenCalledWith({ fileId: "file-to-delete" });
  });

  it("silently ignores 404 (file already deleted)", async () => {
    driveFilesDeleteMock.mockRejectedValue({ response: { status: 404 } });
    await expect(deleteFile({ userId: "u", fileId: "gone" })).resolves.toBeUndefined();
  });

  it("re-throws non-404 errors", async () => {
    driveFilesDeleteMock.mockRejectedValue(new Error("Drive API error"));
    await expect(deleteFile({ userId: "u", fileId: "f" })).rejects.toThrow("Drive API error");
  });
});

describe("ensureFolder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidToken();
  });

  it("returns existing folder id when found", async () => {
    driveFilesListMock.mockResolvedValue({
      data: { files: [{ id: "existing-folder", name: "RMA-draft-123" }] },
    });

    const id = await ensureFolder({ userId: "u", parentId: "root-folder", name: "RMA-draft-123" });

    expect(id).toBe("existing-folder");
    expect(driveFilesCreateMock).not.toHaveBeenCalled();
  });

  it("creates folder and returns new id when not found", async () => {
    driveFilesListMock.mockResolvedValue({ data: { files: [] } });
    driveFilesCreateMock.mockResolvedValue({ data: { id: "new-folder-id" } });

    const id = await ensureFolder({ userId: "u", parentId: "root-folder", name: "DC-20260504-120000" });

    expect(id).toBe("new-folder-id");
    const createArg = driveFilesCreateMock.mock.calls[0][0] as {
      requestBody: { name: string; parents: string[]; mimeType: string };
    };
    expect(createArg.requestBody.name).toBe("DC-20260504-120000");
    expect(createArg.requestBody.parents).toEqual(["root-folder"]);
    expect(createArg.requestBody.mimeType).toBe("application/vnd.google-apps.folder");
  });

  it("throws when create returns no folder id", async () => {
    driveFilesListMock.mockResolvedValue({ data: { files: [] } });
    driveFilesCreateMock.mockResolvedValue({ data: {} });

    await expect(
      ensureFolder({ userId: "u", parentId: "p", name: "Bad" }),
    ).rejects.toThrow(/Failed to create Drive folder/);
  });
});

describe("renameFolder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidToken();
  });

  it("calls drive.files.update with folderId and new name", async () => {
    driveFilesUpdateMock.mockResolvedValue({});

    await renameFolder({ userId: "u", folderId: "folder-123", newName: "DC-20260504-120000" });

    expect(driveFilesUpdateMock).toHaveBeenCalledWith({
      fileId: "folder-123",
      requestBody: { name: "DC-20260504-120000" },
    });
  });
});

describe("makeViewable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupValidToken();
  });

  it("calls drive.permissions.create with anyone-reader for the fileId", async () => {
    drivePermissionsCreateMock.mockResolvedValue({});

    await makeViewable({ userId: "u", fileId: "file-xyz" });

    expect(drivePermissionsCreateMock).toHaveBeenCalledWith({
      fileId: "file-xyz",
      requestBody: { role: "reader", type: "anyone" },
    });
  });
});
