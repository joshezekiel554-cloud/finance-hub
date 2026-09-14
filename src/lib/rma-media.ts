// Accepted media for RMA / credit-memo evidence uploads (Drive-backed).
//
// Cross-cutting on purpose: the server route (multer fileFilter, size cap,
// error text) and the web upload zone (<input accept>, video vs image
// rendering) must agree, so both import from here.

// mime → file extension used when naming the Drive file.
const RMA_MEDIA_EXT: Record<string, string> = {
  // Images (what the upload always accepted)
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  // Video — what phones and browsers actually produce. Deliberately no
  // AVI/WMV: Drive can't preview them and nobody ships them from a phone.
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-m4v": "m4v",
};

// 200 MB — a 1-2 minute phone clip at 1080p. Anything bigger is a
// screen-recording of the wrong thing. Must stay ≤ nginx
// client_max_body_size (deployment/nginx-finance.feldart.com.conf) and the
// Fastify bodyLimit on the photos route.
export const RMA_MEDIA_MAX_BYTES = 200 * 1024 * 1024;

export const RMA_MEDIA_ACCEPT_ATTR = "image/*,video/*";

export function isAcceptedRmaMedia(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(RMA_MEDIA_EXT, mime);
}

export function extensionForRmaMedia(mime: string): string {
  return RMA_MEDIA_EXT[mime] ?? "jpg";
}

export function isVideoMime(mime: string): boolean {
  return mime.startsWith("video/");
}

export function describeAcceptedRmaMedia(): string {
  return "JPEG, PNG, WebP, HEIC, MP4, MOV, WebM";
}
