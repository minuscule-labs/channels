export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"] as const);
export type AllowedImageType = typeof ALLOWED_IMAGE_TYPES extends Set<infer T> ? T : never;

function text(bytes: Uint8Array, from: number, count: number): string {
  return String.fromCharCode(...bytes.subarray(from, from + count));
}

/** Container validation, not a pixel decoder. Reject truncated/header-only raster files. */
function validPng(bytes: Uint8Array): boolean {
  if (bytes.length < 57 || text(bytes, 12, 4) !== "IHDR") return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || !view.getUint32(16) || !view.getUint32(20)) return false;
  let data = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset);
    const kind = text(bytes, offset + 4, 4);
    if (size > bytes.length - offset - 12 || (kind === "IHDR" && offset !== 8)) return false;
    if (kind === "IDAT" && size > 0) data = true;
    offset += size + 12;
    if (kind === "IEND") return size === 0 && data && offset === bytes.length;
  }
  return false;
}

function validJpeg(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let frame = false;
  let scan = false;
  for (let offset = 2; offset < bytes.length;) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9) return frame && scan && offset === bytes.length;
    if (marker === undefined || marker === 0xd8 || marker === 0 || offset + 2 > bytes.length) return false;
    const size = view.getUint16(offset);
    if (size < 2 || offset + size > bytes.length) return false;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (size < 8 || !view.getUint16(offset + 3) || !view.getUint16(offset + 5)) return false;
      frame = true;
    }
    offset += size;
    if (marker === 0xda) {
      if (!frame) return false;
      scan = true;
      // Skip entropy-coded data, byte stuffing, and restart markers without decoding pixels.
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset += 1; continue; }
        const next = bytes[offset + 1];
        if (next === 0 || (next !== undefined && next >= 0xd0 && next <= 0xd7)) offset += 2;
        else break;
      }
    }
  }
  return false;
}

function validGif(bytes: Uint8Array): boolean {
  if (bytes.length < 14) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!view.getUint16(6, true) || !view.getUint16(8, true)) return false;
  let offset = 13 + ((bytes[10]! & 0x80) ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0);
  let image = false;
  const blocks = (): boolean => {
    while (offset < bytes.length) {
      const size = bytes[offset++]!;
      if (!size) return true;
      offset += size;
    }
    return false;
  };
  while (offset < bytes.length) {
    const kind = bytes[offset++];
    if (kind === 0x3b) return image && offset === bytes.length;
    if (kind === 0x21) { offset += 1; if (!blocks()) return false; }
    else if (kind === 0x2c) {
      if (offset + 9 > bytes.length || !view.getUint16(offset + 4, true) || !view.getUint16(offset + 6, true)) return false;
      const packed = bytes[offset + 8]!;
      offset += 9 + ((packed & 0x80) ? 3 * 2 ** ((packed & 7) + 1) : 0);
      const codeSize = bytes[offset++];
      if (codeSize === undefined || codeSize < 2 || codeSize > 8 || !blocks()) return false;
      image = true;
    } else return false;
  }
  return false;
}

function validWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 20) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.length - 8) return false;
  let image = false;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = text(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (size > bytes.length - offset - 8) return false;
    if (kind === "VP8 " && size >= 10 && text(bytes, offset + 11, 3) === "\x9d\x01\x2a") image = true;
    if (kind === "VP8L" && size >= 5 && bytes[offset + 8] === 0x2f) image = true;
    if (kind === "ANMF" && size >= 24) image = true;
    offset += 8 + size + (size % 2);
  }
  return image && offset === bytes.length;
}

export function detectRasterImageType(bytes: Uint8Array): AllowedImageType | undefined {
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value) && validPng(bytes)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && validJpeg(bytes)) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(text(bytes, 0, 6)) && validGif(bytes)) return "image/gif";
  if (text(bytes, 0, 4) === "RIFF" && text(bytes, 8, 4) === "WEBP" && validWebp(bytes)) return "image/webp";
  return undefined;
}

export function validateImageBytes(input: { bytes: Uint8Array; claimedMimeType: string }): {
  ok: true; mimeType: AllowedImageType; size: number;
} | { ok: false; reason: "unsupported_type" | "too_large" | "empty" | "type_mismatch" } {
  if (!ALLOWED_IMAGE_TYPES.has(input.claimedMimeType as AllowedImageType)) return { ok: false, reason: "unsupported_type" };
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large" };
  if (!input.bytes.byteLength) return { ok: false, reason: "empty" };
  const detected = detectRasterImageType(input.bytes);
  if (!detected || detected !== input.claimedMimeType) return { ok: false, reason: "type_mismatch" };
  return { ok: true, mimeType: detected, size: input.bytes.byteLength };
}
