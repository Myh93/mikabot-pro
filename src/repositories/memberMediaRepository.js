"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");

const DEFAULT_FILE = process.env.NODE_TEST_CONTEXT
  ? path.join(os.tmpdir(), `mikabot-member-media-${process.pid}.json`)
  : path.join(__dirname, "..", "database", "member-experience", "media-library.json");
const queues = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const CATEGORIES = new Set(["welcome", "return", "farewell", "removal", "ban"]);
const MEDIA_TYPES = new Set(["image", "gif", "sticker", "video"]);
const CACHE_DEFAULTS = Object.freeze({ localOnly: true, updateFrequency: "disabled", maxItems: 100, maxBytes: 250 * 1024 * 1024, maxDownloadsPerDay: 20, maxAttempts: 2, lastCacheUpdateAt: null });

function createMemberMediaRepository(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_FILE);
  const clock = options.clock || (() => new Date());
  const initial = () => ({ schemaVersion: 1, nextMediaNumber: 1, updatedAt: clock().toISOString(), media: {}, groupUsage: {}, sources: {}, cacheSettings: { ...CACHE_DEFAULTS } });
  let initializePromise = null;

  async function atomicWrite(state) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8"); await handle.sync(); await handle.close(); handle = null;
      if (fs.existsSync(filePath)) await fsp.copyFile(filePath, `${filePath}.bak`);
      await fsp.rename(temporary, filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined); throw error;
    }
  }

  async function load() {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      initializePromise ||= atomicWrite(initial()).finally(() => { initializePromise = null; });
      await initializePromise;
    }
    const state = JSON.parse(await fsp.readFile(filePath, "utf8"));
    if (state.schemaVersion !== 1 || !state.media || !state.groupUsage || !state.sources || !state.cacheSettings) throw new Error("Biblioteca de mídias inválida.");
    state.cacheSettings = { ...CACHE_DEFAULTS, ...state.cacheSettings };
    return state;
  }

  function mutate(operation) {
    const previous = queues.get(filePath) || Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => { const state = await load(); const result = await operation(state); state.updatedAt = clock().toISOString(); await atomicWrite(state); return clone(result); });
    queues.set(filePath, current); return current.finally(() => { if (queues.get(filePath) === current) queues.delete(filePath); });
  }

  function validateMedia(input) {
    if (!CATEGORIES.has(input.category) || !MEDIA_TYPES.has(input.mediaType)) throw new Error("Categoria ou tipo de mídia inválido.");
    if (!input.internalPath || !input.checksum || !input.mimeType || !Number.isFinite(Number(input.size))) throw new Error("Metadados de mídia incompletos.");
  }

  async function addMedia(input) {
    validateMedia(input);
    return mutate(state => {
      const duplicate = Object.values(state.media).find(item => item.checksum === input.checksum && item.category === input.category && item.mediaType === input.mediaType);
      if (duplicate) return { item: duplicate, created: false };
      const mediaId = `ME${String(state.nextMediaNumber++).padStart(6, "0")}`;
      const item = { mediaId, origin: input.origin === "external" ? "external" : "local", sourceId: input.sourceId || null, sourceUrlHash: input.sourceUrlHash || null, category: input.category, mediaType: input.mediaType, internalPath: input.internalPath, mimeType: input.mimeType, size: Number(input.size), checksum: input.checksum, animated: Boolean(input.animated), addedAt: input.addedAt || clock().toISOString(), downloadedAt: input.downloadedAt || null, lastUsedAt: null, expiresAt: input.expiresAt || null, enabled: input.enabled !== false, licenseMetadata: input.licenseMetadata || null };
      state.media[mediaId] = item; return { item, created: true };
    });
  }

  async function listMedia(filters = {}) { return clone(Object.values((await load()).media).filter(item => (!filters.category || item.category === filters.category) && (!filters.mediaType || item.mediaType === filters.mediaType) && (!filters.origin || item.origin === filters.origin) && (filters.enabled === undefined || item.enabled === filters.enabled))); }
  async function getMedia(mediaId) { return clone((await load()).media[String(mediaId || "").toUpperCase()] || null); }
  async function updateMedia(mediaId, changes = {}) { return mutate(state => { const item = state.media[String(mediaId || "").toUpperCase()]; if (!item) return null; for (const field of ["enabled", "lastUsedAt", "expiresAt", "licenseMetadata"]) if (Object.prototype.hasOwnProperty.call(changes, field)) item[field] = clone(changes[field]); return item; }); }
  async function removeMedia(mediaId) { return mutate(state => { const id = String(mediaId || "").toUpperCase(); const item = state.media[id]; if (!item) return null; delete state.media[id]; return item; }); }
  async function findByInternalPath(internalPath) { return clone(Object.values((await load()).media).find(item => item.internalPath === internalPath) || null); }
  const usageField = mediaType => `last${mediaType[0].toUpperCase()}${mediaType.slice(1)}MediaId`;
  async function getLastUsed(groupId, category, mediaType) { return (await load()).groupUsage[groupId]?.[category]?.[usageField(mediaType)] || null; }
  async function recordUsage(groupId, item) { return mutate(state => { const category = item.selectionCategory || item.category; state.groupUsage[groupId] ||= {}; state.groupUsage[groupId][category] ||= {}; state.groupUsage[groupId][category][usageField(item.mediaType)] = item.mediaId; if (state.media[item.mediaId]) state.media[item.mediaId].lastUsedAt = clock().toISOString(); return state.media[item.mediaId] || item; }); }
  async function configureSource(sourceId, config) { return mutate(state => state.sources[sourceId] = { ...(state.sources[sourceId] || {}), ...clone(config), sourceId, updatedAt: clock().toISOString() }); }
  async function listSources() { return clone(Object.values((await load()).sources)); }
  async function getCacheSettings() { return clone((await load()).cacheSettings); }
  async function updateCacheSettings(changes) {
    const allowed = ["localOnly", "updateFrequency", "maxItems", "maxBytes", "maxDownloadsPerDay", "maxAttempts", "lastCacheUpdateAt"];
    if (Object.keys(changes || {}).some(key => !allowed.includes(key))) throw new Error("Configuração de cache inválida.");
    if (changes.updateFrequency && !["disabled", "daily", "weekly"].includes(changes.updateFrequency)) throw new Error("Frequência de cache inválida.");
    for (const field of ["maxItems", "maxBytes", "maxDownloadsPerDay"]) if (changes[field] !== undefined && (!Number.isInteger(changes[field]) || changes[field] < 0)) throw new Error("Limite de cache inválido.");
    if (changes.maxAttempts !== undefined && (!Number.isInteger(changes.maxAttempts) || changes.maxAttempts < 1 || changes.maxAttempts > 3)) throw new Error("Tentativas de cache inválidas.");
    return mutate(state => Object.assign(state.cacheSettings, clone(changes)));
  }

  return { filePath, load, addMedia, listMedia, getMedia, updateMedia, removeMedia, findByInternalPath, getLastUsed, recordUsage, configureSource, listSources, getCacheSettings, updateCacheSettings };
}

const repository = createMemberMediaRepository();
module.exports = { ...repository, createMemberMediaRepository, CATEGORIES, MEDIA_TYPES, CACHE_DEFAULTS };
