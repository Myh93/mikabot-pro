"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const repositoryDefault = require("../repositories/memberMediaRepository");
const validationDefault = require("./memberMediaValidationService");
const adaptersDefault = require("./externalMediaAdapterRegistry");
const {
  resolveSerializedMessageIdDetails,
  resolveOfficialSerializedMessageIdDetails
} = require("./whatsappClientHealthService");

const DEFAULT_ROOT = path.join(__dirname, "..", "media", "member-experience");
const TYPE_DIR = { image: "images", gif: "gifs", sticker: "stickers", video: "videos" };
const FALLBACK = { return: "welcome", removal: "farewell" };
const SAFE_TERMS = Object.freeze({ welcome: ["pokemon welcome", "trainer welcome", "pikachu welcome"], return: ["welcome back pokemon", "trainer returned"], farewell: ["pokemon goodbye", "trainer farewell"], removal: ["goodbye trainer", "farewell pokemon"], ban: ["community rules", "moderation notice"] });

function createMemberMediaLibraryService(options = {}) {
  const repository = options.repository || repositoryDefault;
  const validation = options.validationService || validationDefault;
  const adapters = options.adapterRegistry || adaptersDefault;
  const mediaRoot = path.resolve(options.mediaRoot || DEFAULT_ROOT);
  const cacheRoot = path.join(mediaRoot, "cache", "external");
  const random = options.random || Math.random;
  const clock = options.clock || (() => new Date());
  const log = options.log || (value => console.log(`[MEMBER_MEDIA] ${value}`));
  const uploadDebug = options.uploadDebug || (value => console.log(`[MEDIA_UPLOAD_DEBUG] ${value}`));
  const limits = options.limits;
  const processedMessageIds = new Map();
  const processedMessageObjects = new WeakSet();
  const messageTtlMs = Number(options.messageTtlMs || 2 * 60 * 1000);
  let routerInvocation = 0;
  const withTimeout = (promise, timeoutMs) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Object.assign(new Error("external_timeout"), { code: "ETIMEDOUT" })), timeoutMs); Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); }); });

  const directory = (category, mediaType) => path.join(mediaRoot, category, TYPE_DIR[mediaType]);
  const safeName = value => String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_");

  async function discoverLocal(category, mediaType) {
    const root = directory(category, mediaType); await fsp.mkdir(root, { recursive: true });
    const found = [];
    for (const entry of await fsp.readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      const filePath = path.join(root, entry.name); const validated = await validation.validateFile(filePath, mediaType, { root: mediaRoot, limits });
      if (!validated.valid) { log("mediaValidationFailed=true"); continue; }
      const existing = await repository.findByInternalPath(filePath);
      if (existing) { if (existing.enabled) found.push(existing); continue; }
      const added = await repository.addMedia({ origin: "local", category, mediaType, internalPath: filePath, ...validated }); found.push(added.item);
    }
    return found;
  }

  async function usable(items, mediaType) {
    const output = [];
    for (const item of items) {
      if (!item.enabled) continue;
      if (item.expiresAt && Date.parse(item.expiresAt) <= clock().getTime()) continue;
      const validated = await validation.validateFile(item.internalPath, mediaType, { root: mediaRoot, limits });
      if (validated.valid && validated.checksum === item.checksum) output.push(item); else log("mediaValidationFailed=true");
    }
    return output;
  }

  async function choose(groupId, category, mediaType, items, options = {}) {
    const excluded = new Set(options.excludeMediaIds || []);
    items = items.filter(item => !excluded.has(item.mediaId));
    if (!items.length) return null;
    const last = await repository.getLastUsed(groupId, category, mediaType);
    const eligible = items.length > 1 ? items.filter(item => item.mediaId !== last) : items;
    return eligible[Math.min(eligible.length - 1, Math.floor(random() * eligible.length))];
  }

  async function selectExact(groupId, category, mediaType, options = {}) {
    const local = await usable(await discoverLocal(category, mediaType), mediaType);
    if (local.length) { const item = await choose(groupId, category, mediaType, local, options); if (!item) return null; log("mediaSelected=true"); log("mediaSourceLocal=true"); return item; }
    const cached = await usable(await repository.listMedia({ category, mediaType, origin: "external", enabled: true }), mediaType);
    if (cached.length) { const item = await choose(groupId, category, mediaType, cached, options); if (!item) return null; log("mediaSelected=true"); log("mediaSourceExternalCache=true"); return item; }
    if (options.fetchExternal !== false) {
      await refreshCache({ category, mediaType, maxPerSource: 1 });
      const refreshed = await usable(await repository.listMedia({ category, mediaType, origin: "external", enabled: true }), mediaType);
      if (refreshed.length) return choose(groupId, category, mediaType, refreshed, options);
    }
    return null;
  }

  async function selectMedia(groupId, category, mediaType, options = {}) {
    const direct = await selectExact(groupId, category, mediaType, options); if (direct) return { ...direct, selectionCategory: category };
    const fallback = FALLBACK[category] ? await selectExact(groupId, FALLBACK[category], mediaType, options) : null;
    return fallback ? { ...fallback, selectionCategory: category } : null;
  }

  async function selectVisual(groupId, category, options = {}) {
    const candidates = (await Promise.all(["image", "gif", "video"].map(type => selectMedia(groupId, category, type, options)))).filter(Boolean);
    return candidates.length ? candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))] : null;
  }

  async function selectPreview(category) {
    const candidates = [];
    for (const mediaType of ["image", "sticker", "gif", "video"]) {
      const items = await repository.listMedia({ category, mediaType, enabled: true });
      candidates.push(...await usable(items, mediaType));
    }
    if (!candidates.length) return null;
    return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
  }

  async function markUsed(groupId, item) { if (item) await repository.recordUsage(groupId, item); return item; }

  async function importBuffer({ buffer, category, mediaType, fileName = "upload", origin = "local", sourceId = null, sourceUrlHash = null, licenseMetadata = null, expiresAt = null, animated = false }) {
    const validated = validation.validateBuffer(buffer, mediaType, { limits }); if (!validated.valid) return { created: false, errorCode: validated.code };
    if (origin === "external") {
      await cleanupCache({ reserveItems: 1, reserveBytes: validated.size }); const settings = await repository.getCacheSettings(); const cached = await repository.listMedia({ origin: "external" });
      if (cached.length >= settings.maxItems || cached.reduce((sum, item) => sum + item.size, 0) + validated.size > settings.maxBytes) return { created: false, errorCode: "cache_limit" };
    }
    const root = origin === "external" ? cacheRoot : directory(category, mediaType); await fsp.mkdir(root, { recursive: true });
    const name = origin === "external" ? `${validated.checksum}${validated.extension}` : `${Date.now()}-${crypto.randomUUID()}-${safeName(path.parse(fileName).name)}${validated.extension}`;
    const internalPath = path.join(root, name); if (!validation.controlledPath(mediaRoot, internalPath)) return { created: false, errorCode: "path_not_allowed" };
    if (!fs.existsSync(internalPath)) await fsp.writeFile(internalPath, buffer, { flag: "wx" });
    let added;
    try { added = await repository.addMedia({ origin, sourceId, sourceUrlHash, category, mediaType, internalPath, mimeType: validated.mimeType, size: validated.size, checksum: validated.checksum, animated, downloadedAt: origin === "external" ? clock().toISOString() : null, licenseMetadata, expiresAt }); }
    catch (error) { await fsp.unlink(internalPath).catch(() => undefined); throw error; }
    if (!added.created && internalPath !== added.item.internalPath) await fsp.unlink(internalPath).catch(() => undefined);
    return added;
  }

  async function importWhatsAppMedia(input, category) {
    routerInvocation += 1;
    const message = input?.message || input?.originalMessage || input;
    const originalMessagePresent = Boolean(input?.originalMessage);
    const sameObjectReference = Boolean(input?.message && input?.originalMessage && input.message === input.originalMessage);
    const localResolution = resolveSerializedMessageIdDetails(message);
    const officialResolution = localResolution.serializedId
      ? {
          serializedId: localResolution.serializedId,
          source: localResolution.source,
          officialFactoryAvailable: false,
          officialFactoryName: "not_needed",
          officialFactoryAccepted: false
        }
      : await resolveOfficialSerializedMessageIdDetails(message);
    const resolution = officialResolution;
    const idShape = localResolution.idInspection;
    const dataIdShape = localResolution.dataIdInspection;
    if (resolution.serializedId && message?.id && typeof message.id === "object" && !message.id._serialized) {
      try { message.id._serialized = resolution.serializedId; } catch (_) { /* MantÃ©m falha segura. */ }
    }
    const processingKey = message?.id?._serialized === resolution.serializedId ? resolution.serializedId : null;
    const serializedIdSource = processingKey ? resolution.source : "none";
    uploadDebug(`routeEntered=true routerInvocation=${routerInvocation} messageObjectPresent=${Boolean(message)} originalMessagePresent=${originalMessagePresent} sameObjectReference=${sameObjectReference}`);
    uploadDebug(`idConstructorName=${idShape.constructorName} idOwnKeys=${idShape.ownKeys} idPrototypeKeys=${idShape.prototypeKeys} idHasSerialized=${idShape.hasSerialized} idHasToString=${idShape.hasToString} idToStringCallable=${idShape.toStringCallable} idToStringSucceeded=${idShape.toStringSucceeded} idToStringReturnedString=${idShape.toStringReturnedString} idToStringValidShape=${idShape.toStringValidShape}`);
    uploadDebug(`dataIdExists=${Boolean(message?._data?.id)} dataIdConstructorName=${dataIdShape.constructorName} dataIdOwnKeys=${dataIdShape.ownKeys} dataIdHasSerialized=${dataIdShape.hasSerialized} dataIdHasToString=${dataIdShape.hasToString} dataIdToStringCallable=${dataIdShape.toStringCallable} dataIdToStringSucceeded=${dataIdShape.toStringSucceeded} dataIdToStringValidShape=${dataIdShape.toStringValidShape}`);
    uploadDebug(`officialFactoryAvailable=${resolution.officialFactoryAvailable} officialFactoryName=${resolution.officialFactoryName} officialFactoryAccepted=${resolution.officialFactoryAccepted} officialSerializedResolved=${Boolean(resolution.serializedId)}`);
    uploadDebug(`messageType=${String(message?.type || "unknown").replace(/[^a-z0-9_-]/gi, "_")} hasMedia=${Boolean(message?.hasMedia)} downloadMethodAvailable=${typeof message?.downloadMedia === "function"} messageIdPresent=${Boolean(message?.id)} serializedIdPresent=${Boolean(message?.id?._serialized)} serializedIdSource=${serializedIdSource} processingKeyPresent=${Boolean(processingKey)}`);
    if (!message?.hasMedia) return { created: false, errorCode: "no_media" };
    if (typeof message.downloadMedia !== "function") return { created: false, errorCode: "download_unavailable" };
    const now = clock().getTime();
    for (const [key, timestamp] of processedMessageIds) if (now - timestamp >= messageTtlMs) processedMessageIds.delete(key);
    const dedupeHit = processingKey ? processedMessageIds.has(processingKey) : processedMessageObjects.has(message);
    uploadDebug(`dedupeHit=${dedupeHit}`);
    if (dedupeHit) return { created: false, errorCode: "duplicate_message", ignored: true };
    if (processingKey) processedMessageIds.set(processingKey, now); else processedMessageObjects.add(message);
    let media;
    uploadDebug("downloadAttempt=true");
    try {
      media = await message.downloadMedia();
      uploadDebug(`downloadResolved=${Boolean(media)} mediaObjectPresent=${Boolean(media)} mediaDataPresent=${typeof media?.data === "string" && Boolean(media.data)} mimePresent=${typeof media?.mimetype === "string" && Boolean(media.mimetype)}`);
    }
    catch (error) {
      const safe = value => String(value || "unknown").replace(/https?:\/\/\S+/gi, "[url]").replace(/\b\S+@(?:lid|c\.us|g\.us)\b/gi, "[id]").replace(/\b\d{5,}\b/g, "[number]").slice(0, 180);
      uploadDebug(`downloadThrown=true errorName=${safe(error?.name || "Error")} errorMessage=${safe(error?.message || "download_failed")} errorCode=${safe(error?.code || "download_failed")}`);
      return { created: false, errorCode: "download_failed" };
    }
    if (!media || typeof media.data !== "string" || !media.data.trim() || typeof media.mimetype !== "string" || !media.mimetype.trim()) return { created: false, errorCode: "download_returned_empty" };
    const compact = media.data.replace(/\s/g, "");
    if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return { created: false, errorCode: "invalid_base64" };
    let buffer;
    try { buffer = Buffer.from(compact, "base64"); } catch (_) { return { created: false, errorCode: "invalid_base64" }; }
    if (!buffer.length || buffer.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) return { created: false, errorCode: "invalid_base64" };
    const format = validation.detectedFormat(buffer);
    const declaredMime = media.mimetype.toLowerCase().split(";")[0].trim();
    const gifAsVideo = format === "mp4" && Boolean(message.isGif || message._data?.isGif || message.type === "gif");
    let mediaType = null;
    if (message.type === "sticker" && format === "webp") mediaType = "sticker";
    else if (format === "gif" || gifAsVideo) mediaType = "gif";
    else if (["png", "jpg", "webp"].includes(format)) mediaType = "image";
    else if (["mp4", "webm"].includes(format)) mediaType = "video";
    if (!mediaType) return { created: false, errorCode: format ? "unsupported_mime" : "invalid_file_signature" };
    const allowedMime = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm"]);
    if (!allowedMime.has(declaredMime)) return { created: false, errorCode: "unsupported_mime" };
    const expectedMime = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", webm: "video/webm" }[format];
    if (declaredMime !== expectedMime) return { created: false, errorCode: "invalid_file_signature" };
    let result;
    try { result = await importBuffer({ buffer, category, mediaType, fileName: media.filename || `whatsapp-${mediaType}`, animated: mediaType === "gif" }); }
    catch (_) { return { created: false, errorCode: "save_failed" }; }
    if (result.errorCode === "invalid_signature") result.errorCode = "invalid_file_signature";
    if (result.errorCode === "corrupt_media") result.errorCode = "corrupted_media";
    return result;
  }

  async function downloadFromAdapter(adapter, result, category, mediaType) {
    if (!adapter.validateResult(result)) return { created: false, errorCode: "result_rejected" };
    const metadata = adapter.normalizeMetadata(result); const firstUrl = await validation.validateExternalUrl(metadata.url, adapter.allowedDomains);
    if (!firstUrl.valid) return { created: false, errorCode: firstUrl.code };
    const settings = await repository.getCacheSettings(); let downloaded; let lastError;
    for (let attempt = 0; attempt < Math.max(1, Math.min(3, Number(settings.maxAttempts || 1))); attempt += 1) { try { downloaded = await withTimeout(adapter.downloadMedia(result, { redirect: "manual", allowedDomains: [...adapter.allowedDomains] }), adapter.timeoutMs); break; } catch (error) { lastError = error; } }
    if (!downloaded && lastError) return { created: false, errorCode: lastError.code === "ETIMEDOUT" ? "timeout" : "download_failed" };
    if (!Buffer.isBuffer(downloaded?.buffer)) return { created: false, errorCode: "download_failed" };
    if (downloaded.buffer.length > adapter.maxSize) return { created: false, errorCode: "file_too_large" };
    if (downloaded.finalUrl) { const finalUrl = await validation.validateExternalUrl(downloaded.finalUrl, adapter.allowedDomains); if (!finalUrl.valid) return { created: false, errorCode: "redirect_not_allowed" }; }
    return importBuffer({ buffer: downloaded.buffer, category, mediaType, origin: "external", sourceId: adapter.sourceId, sourceUrlHash: crypto.createHash("sha256").update(metadata.url).digest("hex"), licenseMetadata: metadata.licenseMetadata || null, expiresAt: metadata.expiresAt || null });
  }

  async function refreshCache(filters = {}) {
    const settings = await repository.getCacheSettings(); if (settings.localOnly) return { downloaded: 0, skipped: true };
    let downloaded = 0;
    for (const source of await repository.listSources()) {
      const adapter = adapters.get(source.sourceId); if (!source.enabled || !adapter) continue;
      if (filters.scheduled) { const interval = source.updateFrequency === "daily" ? 86400000 : source.updateFrequency === "weekly" ? 7 * 86400000 : Infinity; if (clock().getTime() - Date.parse(source.lastUpdatedAt || 0) < interval) continue; }
      const today = clock().toISOString().slice(0, 10); const usedToday = source.downloadDate === today ? Number(source.downloadsToday || 0) : 0;
      const dailyLimit = Math.min(Number(source.maxDownloadsPerDay ?? settings.maxDownloadsPerDay), Number(settings.maxDownloadsPerDay));
      if (usedToday >= dailyLimit) continue;
      let sourceDownloaded = 0;
      const categories = filters.category ? [filters.category] : source.categories || adapter.supportedCategories;
      const types = filters.mediaType ? [filters.mediaType] : source.types || adapter.supportedTypes;
      for (const category of categories) for (const mediaType of types) {
        if (!adapter.supportedCategories.includes(category) || !adapter.supportedTypes.includes(mediaType)) continue;
        try {
          log("externalFetchStarted=true"); const terms = source.keywords?.[category] || SAFE_TERMS[category];
          const results = await withTimeout(adapter.searchMedia({ category, mediaType, keywords: terms, limit: filters.maxPerSource || 1 }), adapter.timeoutMs);
          for (const result of (results || []).slice(0, Math.max(0, Math.min(filters.maxPerSource || 1, dailyLimit - usedToday - sourceDownloaded)))) { const added = await downloadFromAdapter(adapter, result, category, mediaType); if (added.created) { downloaded += 1; sourceDownloaded += 1; await repository.configureSource(source.sourceId, { downloadsToday: usedToday + sourceDownloaded, downloadDate: today, lastUpdatedAt: clock().toISOString() }); } }
          log("externalFetchSucceeded=true");
        } catch (_) { log("externalFetchFailed=true"); }
      }
    }
    await cleanupCache(); await repository.updateCacheSettings({ lastCacheUpdateAt: clock().toISOString() }); return { downloaded, skipped: false };
  }

  async function refreshDue() {
    const settings = await repository.getCacheSettings(); if (settings.localOnly || settings.updateFrequency === "disabled") return { downloaded: 0, skipped: true };
    const interval = settings.updateFrequency === "daily" ? 86400000 : settings.updateFrequency === "weekly" ? 7 * 86400000 : Infinity;
    if (clock().getTime() - Date.parse(settings.lastCacheUpdateAt || 0) < interval) return { downloaded: 0, skipped: true };
    return refreshCache({ scheduled: true });
  }

  async function cleanupCache(options = {}) {
    const settings = await repository.getCacheSettings(); const external = await repository.listMedia({ origin: "external" });
    let total = external.reduce((sum, item) => sum + item.size, 0); const sorted = [...external].sort((a, b) => Date.parse(a.lastUsedAt || a.downloadedAt || 0) - Date.parse(b.lastUsedAt || b.downloadedAt || 0)); let removed = 0; let remaining = external.length;
    for (const item of sorted) {
      if (remaining + Number(options.reserveItems || 0) <= settings.maxItems && total + Number(options.reserveBytes || 0) <= settings.maxBytes) break;
      if (item.enabled && (!item.expiresAt || Date.parse(item.expiresAt) > clock().getTime())) continue;
      await repository.removeMedia(item.mediaId); await fsp.unlink(item.internalPath).catch(() => undefined); total -= item.size; remaining -= 1; removed += 1;
    }
    log("cacheCleanupCompleted=true"); return { removed, bytesRemaining: total };
  }

  async function setEnabled(mediaId, enabled) { return repository.updateMedia(mediaId, { enabled: Boolean(enabled) }); }
  async function removeMedia(mediaId) { const item = await repository.removeMedia(mediaId); if (!item) return null; const referenced = (await repository.listMedia()).some(other => other.internalPath === item.internalPath); if (!referenced && validation.controlledPath(mediaRoot, item.internalPath)) await fsp.unlink(item.internalPath).catch(() => undefined); log("mediaRemoved=true"); return item; }
  async function listMedia(category) { return repository.listMedia(category ? { category } : {}); }
  async function configureSource(sourceId, config = {}) {
    const adapter = adapters.get(sourceId); if (!adapter) throw new Error("Fonte externa não autorizada ou sem adaptador.");
    const settings = await repository.getCacheSettings();
    const categories = (config.categories || adapter.supportedCategories).filter(value => adapter.supportedCategories.includes(value));
    const types = (config.types || adapter.supportedTypes).filter(value => adapter.supportedTypes.includes(value));
    const keywords = {};
    for (const category of categories) keywords[category] = (config.keywords?.[category] || SAFE_TERMS[category] || []).map(value => String(value).trim()).filter(value => value && !/(adult|porn|violence|weapon|gambl|bet)/i.test(value)).slice(0, 10);
    return repository.configureSource(sourceId, { enabled: Boolean(config.enabled), categories, types, keywords, updateFrequency: config.updateFrequency || "disabled", maxDownloadsPerDay: Math.max(0, Number(config.maxDownloadsPerDay ?? settings.maxDownloadsPerDay)) });
  }

  return { mediaRoot, cacheRoot, discoverLocal, selectMedia, selectVisual, selectPreview, markUsed, importBuffer, importWhatsAppMedia, refreshCache, refreshDue, cleanupCache, setEnabled, removeMedia, listMedia, configureSource, listAdapters: () => adapters.list().map(item => ({ sourceId: item.sourceId, supportedTypes: item.supportedTypes, supportedCategories: item.supportedCategories, licensePolicy: item.licensePolicy })), repository, SAFE_TERMS };
}

const service = createMemberMediaLibraryService();
module.exports = { ...service, createMemberMediaLibraryService, DEFAULT_ROOT, TYPE_DIR, FALLBACK, SAFE_TERMS };
