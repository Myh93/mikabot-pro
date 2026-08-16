"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const fs = require("node:fs");
const fsp = fs.promises;
const net = require("node:net");
const path = require("node:path");

const DEFAULT_LIMITS = Object.freeze({ image: 5 * 1024 * 1024, gif: 15 * 1024 * 1024, sticker: 1024 * 1024, video: 25 * 1024 * 1024 });
const MIME = Object.freeze({ png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", mp4: "video/mp4", webm: "video/webm" });

function detectedFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "jpg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
  return null;
}

function structurallyValid(buffer, format) {
  if (format === "jpg") return buffer.length >= 4 && buffer.at(-2) === 255 && buffer.at(-1) === 217;
  if (format === "gif") return buffer.length >= 14 && buffer.at(-1) === 59;
  if (format === "webp") return buffer.length >= 20 && buffer.readUInt32LE(4) + 8 === buffer.length;
  if (format === "mp4") return buffer.length >= 16 && buffer.readUInt32BE(0) >= 8;
  if (format === "webm") return buffer.length >= 8;
  if (format === "png") {
    let offset = 8; let first = true; let ended = false;
    while (offset + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(offset); const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
      if (offset + 12 + size > buffer.length || (first && (type !== "IHDR" || size !== 13))) return false;
      offset += 12 + size; first = false; if (type === "IEND") { ended = true; break; }
    }
    return ended && offset === buffer.length;
  }
  return false;
}

function validateBuffer(buffer, mediaType, options = {}) {
  const format = detectedFormat(buffer); const limit = Number(options.limits?.[mediaType] || DEFAULT_LIMITS[mediaType]);
  if (!format) return { valid: false, code: "invalid_signature" };
  if (!structurallyValid(buffer, format)) return { valid: false, code: "corrupt_media" };
  if (!Number.isFinite(limit) || buffer.length > limit) return { valid: false, code: "file_too_large" };
  if (mediaType === "gif" && !["gif", "mp4"].includes(format)) return { valid: false, code: "type_mismatch" };
  if (mediaType === "sticker" && format !== "webp") return { valid: false, code: "type_mismatch" };
  if (mediaType === "image" && !["png", "jpg", "webp"].includes(format)) return { valid: false, code: "type_mismatch" };
  if (mediaType === "video" && !["mp4", "webm"].includes(format)) return { valid: false, code: "type_mismatch" };
  return { valid: true, format, mimeType: MIME[format], size: buffer.length, checksum: crypto.createHash("sha256").update(buffer).digest("hex"), extension: format === "jpg" ? ".jpg" : `.${format}` };
}

function controlledPath(root, candidate) {
  const absoluteRoot = path.resolve(root); const absolute = path.resolve(candidate); const relative = path.relative(absoluteRoot, absolute);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? absolute : null;
}

async function validateFile(filePath, mediaType, options = {}) {
  const controlled = controlledPath(options.root, filePath); if (!controlled) return { valid: false, code: "path_not_allowed" };
  let stat; try { stat = await fsp.stat(controlled); } catch (_) { return { valid: false, code: "file_unavailable" }; }
  if (!stat.isFile() || !stat.size) return { valid: false, code: "empty_file" };
  const limit = Number(options.limits?.[mediaType] || DEFAULT_LIMITS[mediaType]); if (stat.size > limit) return { valid: false, code: "file_too_large" };
  try { return { ...validateBuffer(await fsp.readFile(controlled), mediaType, options), internalPath: controlled }; } catch (_) { return { valid: false, code: "read_failed" }; }
}

function privateIp(address) {
  if (!net.isIP(address)) return false;
  if (address === "::1" || address === "0.0.0.0" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) return true;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && (parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
}

async function validateExternalUrl(value, allowedDomains, options = {}) {
  let url; try { url = new URL(value); } catch (_) { return { valid: false, code: "invalid_url" }; }
  if (url.protocol !== "https:" || url.username || url.password) return { valid: false, code: "scheme_not_allowed" };
  const hostname = url.hostname.toLowerCase(); const allowed = (allowedDomains || []).some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  if (!allowed || hostname === "localhost" || privateIp(hostname)) return { valid: false, code: "domain_not_allowed" };
  try {
    const lookup = options.lookup || (host => dns.lookup(host, { all: true })); const addresses = await lookup(hostname);
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => privateIp(item.address || item))) return { valid: false, code: "private_address" };
  } catch (_) { return { valid: false, code: "dns_failed" }; }
  return { valid: true, url, hostname };
}

module.exports = { DEFAULT_LIMITS, detectedFormat, structurallyValid, validateBuffer, validateFile, controlledPath, validateExternalUrl, privateIp };
