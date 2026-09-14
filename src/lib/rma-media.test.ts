import { describe, expect, it } from "vitest";
import {
  RMA_MEDIA_MAX_BYTES,
  RMA_MEDIA_ACCEPT_ATTR,
  buildRmaMediaFilename,
  describeAcceptedRmaMedia,
  extensionForRmaMedia,
  extensionOfFilename,
  isAcceptedRmaMedia,
  isVideoMime,
} from "./rma-media.js";

describe("buildRmaMediaFilename", () => {
  // Operator spec 2026-09-14: "SKU-creditmemo". Before the credit memo
  // exists the doc number is the RMA number; files are renamed when the
  // memo is issued.
  it("names a file SKU-<doc>-<n>.<ext>", () => {
    expect(
      buildRmaMediaFilename({ sku: "ABC123", docNumber: "CM1042", n: 1, ext: "jpg" }),
    ).toBe("ABC123-CM1042-1.jpg");
  });

  it("drops the SKU segment when none was picked", () => {
    expect(
      buildRmaMediaFilename({ sku: null, docNumber: "RMA-0207", n: 3, ext: "mp4" }),
    ).toBe("RMA-0207-3.mp4");
  });

  it("strips path separators and squeezes whitespace out of the SKU", () => {
    expect(
      buildRmaMediaFilename({ sku: " AB/12\\ 3 ", docNumber: "RMA-1", n: 1, ext: "png" }),
    ).toBe("AB12 3-RMA-1-1.png");
  });
});

describe("extensionOfFilename", () => {
  it("returns the lowercase extension", () => {
    expect(extensionOfFilename("ABC-CM1-2.MOV")).toBe("mov");
  });
  it("defaults to jpg when there is none", () => {
    expect(extensionOfFilename("noext")).toBe("jpg");
  });
});

describe("rma-media", () => {
  it("accepts the image types the RMA photo upload always took", () => {
    for (const m of ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"]) {
      expect(isAcceptedRmaMedia(m)).toBe(true);
    }
  });

  it("accepts phone + browser video containers", () => {
    for (const m of ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"]) {
      expect(isAcceptedRmaMedia(m)).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const m of ["application/pdf", "image/svg+xml", "video/x-msvideo", "text/plain", ""]) {
      expect(isAcceptedRmaMedia(m)).toBe(false);
    }
  });

  it("maps mime → file extension, defaulting to jpg", () => {
    expect(extensionForRmaMedia("image/jpeg")).toBe("jpg");
    expect(extensionForRmaMedia("video/quicktime")).toBe("mov");
    expect(extensionForRmaMedia("video/mp4")).toBe("mp4");
    expect(extensionForRmaMedia("application/octet-stream")).toBe("jpg");
  });

  it("identifies video mimes", () => {
    expect(isVideoMime("video/mp4")).toBe(true);
    expect(isVideoMime("image/png")).toBe(false);
  });

  it("caps uploads at 200 MB so a phone clip fits", () => {
    expect(RMA_MEDIA_MAX_BYTES).toBe(200 * 1024 * 1024);
  });

  it("exposes an <input accept> attribute covering images + videos", () => {
    expect(RMA_MEDIA_ACCEPT_ATTR).toBe("image/*,video/*");
  });

  it("describes the accepted set for error messages", () => {
    expect(describeAcceptedRmaMedia()).toBe("JPEG, PNG, WebP, HEIC, MP4, MOV, WebM");
  });
});
