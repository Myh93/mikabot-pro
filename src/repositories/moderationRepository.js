"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const SCHEMA_VERSION = 1;
const DATASET_VERSION = "2.1.0-dev";
const FILE_NAME = "moderation.json";
const MANIFEST_NAME = "manifest.json";
const queues = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const checksum = value => crypto.createHash("sha256").update(value).digest("hex");
const nowIso = clock => clock().toISOString();

const getDefaultGroupConfig = () => ({
  enabled: false,
  settings: {
    warnings: { enabled: false, limit: 3, finalAction: "notify_admins" },
    antiLink: { enabled: false, deleteMessage: true, warnUser: true, adminsBypass: true, requireApproval: true },
    ban: { enabled: false, blockReentry: true },
    approval: { enabled: false, allowModeratorReview: false, requestExpiresDays: 7, notifyAdminsPrivately: true, publishByBotOnly: true },
    antiFlood: { enabled: false },
    antiSpam: { enabled: false }
  },
  createdAt: null,
  updatedAt: null
});

const emptyDatabase = () => ({
  schemaVersion: SCHEMA_VERSION,
  revision: 0,
  updatedAt: null,
  groups: {},
  warnings: {},
  bans: {},
  history: [],
  pendingLinks: {},
  domainRules: { whitelist: {}, blacklist: {}, reputation: {} },
  receipts: {}
});

function deepMerge(base, patch) {
  const result = clone(base);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) result[key] = deepMerge(result[key], value);
    else if (value !== undefined) result[key] = clone(value);
  }
  return result;
}

function createModerationRepository(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.join(__dirname, "..", "..", "data", "moderation"));
  const backupRoot = path.resolve(options.backupRoot || path.join(__dirname, "..", "..", "data", "backups", "moderation"));
  const clock = options.clock || (() => new Date());
  const dataPath = path.join(dataDir, FILE_NAME);
  const manifestPath = path.join(dataDir, MANIFEST_NAME);

  function enqueue(operation) {
    const previous = queues.get(dataDir) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(dataDir, current);
    return current.finally(() => { if (queues.get(dataDir) === current) queues.delete(dataDir); });
  }

  async function atomicWrite(file, content) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8"); await handle.sync(); await handle.close(); handle = null;
      await fsp.rename(temporary, file);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  function normalizeGroupConfig(value = {}, timestamp = null) {
    const merged = deepMerge(getDefaultGroupConfig(), value);
    merged.enabled = Boolean(merged.enabled);
    merged.settings.warnings.enabled = Boolean(merged.settings.warnings.enabled);
    merged.settings.warnings.limit = Number.isInteger(Number(merged.settings.warnings.limit)) && Number(merged.settings.warnings.limit) >= 1 ? Number(merged.settings.warnings.limit) : 3;
    merged.settings.warnings.finalAction = String(merged.settings.warnings.finalAction || "notify_admins");
    for (const key of ["enabled", "deleteMessage", "warnUser", "adminsBypass", "requireApproval"]) merged.settings.antiLink[key] = Boolean(merged.settings.antiLink[key]);
    merged.settings.ban = merged.settings.ban || { enabled: false, blockReentry: true };
    merged.settings.ban.enabled = Boolean(merged.settings.ban.enabled);
    merged.settings.ban.blockReentry = merged.settings.ban.blockReentry !== false;
    merged.settings.approval = merged.settings.approval || {};
    merged.settings.approval.enabled = Boolean(merged.settings.approval.enabled);
    merged.settings.approval.allowModeratorReview = Boolean(merged.settings.approval.allowModeratorReview);
    merged.settings.approval.requestExpiresDays = Number.isInteger(Number(merged.settings.approval.requestExpiresDays)) && Number(merged.settings.approval.requestExpiresDays) >= 1 ? Number(merged.settings.approval.requestExpiresDays) : 7;
    merged.settings.approval.notifyAdminsPrivately = merged.settings.approval.notifyAdminsPrivately !== false;
    merged.settings.approval.publishByBotOnly = merged.settings.approval.publishByBotOnly !== false;
    merged.settings.antiFlood.enabled = Boolean(merged.settings.antiFlood.enabled);
    merged.settings.antiSpam.enabled = Boolean(merged.settings.antiSpam.enabled);
    merged.createdAt = value.createdAt || timestamp;
    merged.updatedAt = value.updatedAt || timestamp;
    return merged;
  }

  function normalizeDatabase(value = {}) {
    const base = emptyDatabase(), normalized = { ...base, ...clone(value) };
    normalized.schemaVersion = SCHEMA_VERSION;
    normalized.revision = Number.isInteger(Number(value.revision)) && Number(value.revision) >= 0 ? Number(value.revision) : 0;
    normalized.updatedAt = value.updatedAt || null;
    normalized.groups = Object.fromEntries(Object.entries(value.groups || {}).map(([id, config]) => [id, normalizeGroupConfig(config)]));
    normalized.warnings = value.warnings && typeof value.warnings === "object" && !Array.isArray(value.warnings) ? value.warnings : {};
    normalized.bans = value.bans && typeof value.bans === "object" && !Array.isArray(value.bans) ? value.bans : {};
    normalized.history = Array.isArray(value.history) ? value.history : [];
    normalized.pendingLinks = value.pendingLinks && typeof value.pendingLinks === "object" && !Array.isArray(value.pendingLinks) ? value.pendingLinks : {};
    normalized.domainRules = {
      whitelist: value.domainRules?.whitelist && typeof value.domainRules.whitelist === "object" ? value.domainRules.whitelist : {},
      blacklist: value.domainRules?.blacklist && typeof value.domainRules.blacklist === "object" ? value.domainRules.blacklist : {},
      reputation: value.domainRules?.reputation && typeof value.domainRules.reputation === "object" ? value.domainRules.reputation : {}
    };
    normalized.receipts = value.receipts && typeof value.receipts === "object" && !Array.isArray(value.receipts) ? value.receipts : {};
    return normalized;
  }

  function validateDatabase(database) {
    const errors = [];
    if (database && (!database.bans || typeof database.bans !== "object" || Array.isArray(database.bans))) errors.push("bans invalidos.");
    if (!database || typeof database !== "object" || Array.isArray(database)) return ["Banco ausente ou inválido."];
    if (database.schemaVersion !== SCHEMA_VERSION) errors.push("schemaVersion incompatível.");
    if (!Number.isInteger(database.revision) || database.revision < 0) errors.push("revision inválida.");
    for (const key of ["groups", "warnings", "pendingLinks", "domainRules", "receipts"]) if (!database[key] || typeof database[key] !== "object" || Array.isArray(database[key])) errors.push(`${key} inválido.`);
    if (!Array.isArray(database.history)) errors.push("history inválido.");
    for (const key of ["whitelist", "blacklist", "reputation"]) if (!database.domainRules?.[key] || typeof database.domainRules[key] !== "object" || Array.isArray(database.domainRules[key])) errors.push(`domainRules.${key} inválido.`);
    for (const [id, item] of Object.entries(database.warnings || {})) if (item.warningId !== id) errors.push(`Advertência divergente: ${id}.`);
    for (const [id, item] of Object.entries(database.pendingLinks || {})) if (item.requestId !== id) errors.push(`Link pendente divergente: ${id}.`);
    return errors;
  }

  async function writeManifest(raw, revision) {
    const manifest = { schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION, activeSource: FILE_NAME, revision, updatedAt: nowIso(clock), checksum: { algorithm: "sha256", value: checksum(raw) } };
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  async function persist(database, increment = true) {
    const normalized = normalizeDatabase(database);
    if (increment) { normalized.revision += 1; normalized.updatedAt = nowIso(clock); }
    const errors = validateDatabase(normalized); if (errors.length) throw new Error(`Banco de moderação inválido: ${errors.join(" ")}`);
    const raw = `${JSON.stringify(normalized, null, 2)}\n`;
    await atomicWrite(dataPath, raw); await writeManifest(raw, normalized.revision);
    return clone(normalized);
  }

  async function initialize() {
    await fsp.mkdir(dataDir, { recursive: true });
    const exists = file => fsp.access(file).then(() => true, () => false);
    const [hasData, hasManifest] = await Promise.all([exists(dataPath), exists(manifestPath)]);
    if (hasData && hasManifest) return getDatabase();
    if (hasData !== hasManifest) {
      const recovered = await recoverFromLatestBackup().catch(() => null);
      if (recovered) return recovered;
      throw new Error("Base de moderação parcialmente inicializada.");
    }
    return enqueue(() => persist(emptyDatabase(), false));
  }

  async function readValidated() {
    const [raw, manifestRaw] = await Promise.all([fsp.readFile(dataPath), fsp.readFile(manifestPath, "utf8")]);
    const manifest = JSON.parse(manifestRaw), parsed = JSON.parse(raw.toString("utf8"));
    if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.checksum?.algorithm !== "sha256" || manifest.checksum.value !== checksum(raw)) throw new Error("Checksum ou manifesto da moderação inválido.");
    const normalized = normalizeDatabase(parsed), errors = validateDatabase(normalized);
    if (errors.length) throw new Error(errors.join(" "));
    return normalized;
  }

  async function getDatabase() {
    const exists = await fsp.access(dataPath).then(() => true, () => false);
    if (!exists) return initialize();
    try { return clone(await readValidated()); }
    catch (error) {
      const recovered = await recoverFromLatestBackup().catch(() => null);
      if (recovered) return recovered;
      throw new Error(`Falha segura ao carregar moderação: ${error.message}`);
    }
  }

  async function createBackup() {
    const database = await readValidated();
    const raw = await fsp.readFile(dataPath), digest = checksum(raw);
    await fsp.mkdir(backupRoot, { recursive: true });
    for (const entry of await fsp.readdir(backupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try { const meta = JSON.parse(await fsp.readFile(path.join(backupRoot, entry.name, "backup-manifest.json"), "utf8")); if (meta.checksum?.value === digest) return { directory: path.join(backupRoot, entry.name), reused: true, revision: database.revision }; } catch (_) {}
    }
    const directory = path.join(backupRoot, `${nowIso(clock).replace(/[:.]/g, "-")}-r${database.revision}`); await fsp.mkdir(directory);
    await fsp.copyFile(dataPath, path.join(directory, FILE_NAME), fs.constants.COPYFILE_EXCL);
    const metadata = { schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION, source: FILE_NAME, revision: database.revision, createdAt: nowIso(clock), checksum: { algorithm: "sha256", value: digest } };
    await atomicWrite(path.join(directory, "backup-manifest.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    return { directory, reused: false, revision: database.revision };
  }

  async function recoverFromLatestBackup() {
    await fsp.mkdir(backupRoot, { recursive: true });
    const entries = (await fsp.readdir(backupRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()).sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of entries) {
      try {
        const directory = path.join(backupRoot, entry.name), meta = JSON.parse(await fsp.readFile(path.join(directory, "backup-manifest.json"), "utf8")), raw = await fsp.readFile(path.join(directory, FILE_NAME));
        if (meta.schemaVersion !== SCHEMA_VERSION || meta.checksum?.value !== checksum(raw)) continue;
        const database = normalizeDatabase(JSON.parse(raw.toString("utf8"))); if (validateDatabase(database).length) continue;
        await atomicWrite(dataPath, raw); await writeManifest(raw, database.revision); return clone(database);
      } catch (_) {}
    }
    return null;
  }

  async function mutate(operation) {
    await initialize();
    return enqueue(async () => {
      const database = await readValidated();
      await createBackup();
      const result = await operation(database);
      const stored = await persist(database, true);
      return { result: clone(result), database: stored };
    });
  }

  function nextId(database, receipt, prefix) {
    const number = Number(database.receipts[receipt] || 1); database.receipts[receipt] = number + 1;
    return `${prefix}${String(number).padStart(6, "0")}`;
  }
  const ruleKey = (domain, metadata = {}) => `${metadata.scope === "group" ? `group:${metadata.groupId || ""}` : "global"}:${domain}`;

  async function getGroupConfig(groupId) { const database = await getDatabase(); return clone(database.groups[groupId] || null); }
  async function ensureGroupConfig(groupId) {
    if (!groupId) throw new Error("groupId é obrigatório.");
    const current = await getGroupConfig(groupId); if (current) return current;
    const timestamp = nowIso(clock); return (await mutate(database => { const existing = database.groups[groupId]; if (existing) return existing; return (database.groups[groupId] = normalizeGroupConfig({}, timestamp)); })).result;
  }
  async function updateGroupConfig(groupId, patch) {
    if (!groupId) throw new Error("groupId é obrigatório.");
    return (await mutate(database => { const timestamp = nowIso(clock), current = database.groups[groupId] || normalizeGroupConfig({}, timestamp); const updated = normalizeGroupConfig(deepMerge(current, patch), timestamp); updated.createdAt = current.createdAt || timestamp; updated.updatedAt = timestamp; return (database.groups[groupId] = updated); })).result;
  }
  async function addWarningRecord(record) { return (await mutate(database => { const warningId = record.warningId || nextId(database, "nextWarning", "WARN-"); const item = { ...clone(record), warningId }; if (database.warnings[warningId]) throw new Error("warningId já existe."); database.warnings[warningId] = item; return item; })).result; }
  async function addWarningRecordIdempotent(record, receiptKey = null) {
    return (await mutate(database => {
      const receipts = (database.receipts.warningMessages ||= {});
      if (receiptKey && receipts[receiptKey]) return { warning: database.warnings[receipts[receiptKey]] || null, duplicate: true, previousActiveCount: null, activeCount: null };
      const previousActiveCount = Object.values(database.warnings).filter(item => item.groupId === record.groupId && item.userId === record.userId && item.active).length;
      const warningId = record.warningId || nextId(database, "nextWarning", "WARN-");
      if (database.warnings[warningId]) throw new Error("warningId já existe.");
      const warning = { ...clone(record), warningId }; database.warnings[warningId] = warning;
      if (receiptKey) receipts[receiptKey] = warningId;
      return { warning, duplicate: false, previousActiveCount, activeCount: previousActiveCount + 1 };
    })).result;
  }
  async function getWarningRecords(groupId, userId) { const database = await getDatabase(); return Object.values(database.warnings).filter(item => (!groupId || item.groupId === groupId) && (!userId || item.userId === userId)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).map(clone); }
  async function clearWarningRecords(groupId, userId, clearedBy = null) { return (await mutate(database => { const timestamp = nowIso(clock), cleared = []; for (const item of Object.values(database.warnings)) if (item.groupId === groupId && item.userId === userId && item.active) { item.active = false; item.clearedAt = timestamp; item.clearedBy = clearedBy; cleared.push(item.warningId); } return cleared; })).result; }
  async function addBanRecord(record, receiptKey = null) { return (await mutate(database => { const receipts = (database.receipts.banActions ||= {}); if (receiptKey && receipts[receiptKey]) return { ban: database.bans[receipts[receiptKey]] || null, duplicate: true }; const active = Object.values(database.bans).find(item => item.groupId === record.groupId && item.userId === record.userId && item.active); if (active) return { ban: active, duplicate: true }; const banId = record.banId || nextId(database, "nextBan", "BAN-"); const ban = { ...clone(record), banId }; database.bans[banId] = ban; if (receiptKey) receipts[receiptKey] = banId; return { ban, duplicate: false }; })).result; }
  async function getActiveBan(groupId, userId) { const database = await getDatabase(); return clone(Object.values(database.bans).find(item => item.groupId === groupId && item.userId === userId && item.active) || null); }
  async function listActiveBans(groupId) { const database = await getDatabase(); return Object.values(database.bans).filter(item => (!groupId || item.groupId === groupId) && item.active).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(clone); }
  async function revokeBan(banId, actorId) { return (await mutate(database => { const item = database.bans[banId]; if (!item || !item.active) return null; item.active = false; item.revokedAt = nowIso(clock); item.revokedBy = actorId; return item; })).result; }
  async function countActiveBans(groupId) { return (await listActiveBans(groupId)).length; }
  async function claimReceipt(namespace, key, value = true) { return (await mutate(database => { const bucket = (database.receipts[namespace] ||= {}); if (bucket[key]) return false; bucket[key] = value; return true; })).result; }
  async function appendHistory(entry) { return (await mutate(database => { const historyId = entry.historyId || nextId(database, "nextHistory", "MOD-HIS-"); const item = { ...clone(entry), historyId }; if (database.history.some(existing => existing.historyId === historyId)) throw new Error("historyId já existe."); database.history.push(item); return item; })).result; }
  async function listHistory(filters = {}) { const database = await getDatabase(); let list = [...database.history]; const map = { groupId: "groupId", userId: "userId", action: "action", domain: "domain" }; for (const [filter, field] of Object.entries(map)) if (filters[filter]) list = list.filter(item => item[field] === filters[filter]); if (filters.from) list = list.filter(item => Date.parse(item.createdAt) >= Date.parse(filters.from)); if (filters.to) list = list.filter(item => Date.parse(item.createdAt) <= Date.parse(filters.to)); list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); const pageSize = Math.min(100, Math.max(1, Number(filters.pageSize) || 20)), total = list.length, totalPages = Math.max(1, Math.ceil(total / pageSize)), page = Math.max(1, Number(filters.page) || 1); return { items: list.slice((page - 1) * pageSize, page * pageSize).map(clone), page, pageSize, total, totalPages }; }
  async function createPendingLink(request) { return (await mutate(database => { const requestId = request.requestId || nextId(database, "nextPendingLink", "LINK-"); const item = { ...clone(request), requestId }; if (database.pendingLinks[requestId]) throw new Error("requestId já existe."); database.pendingLinks[requestId] = item; return item; })).result; }
  async function getPendingLink(requestId) { const database = await getDatabase(); return clone(database.pendingLinks[requestId] || null); }
  async function updatePendingLink(requestId, patch) { return (await mutate(database => { const current = database.pendingLinks[requestId]; if (!current) return null; return (database.pendingLinks[requestId] = { ...current, ...clone(patch), requestId }); })).result; }
  async function findPendingLinks(filters = {}) { const database = await getDatabase(); let items = Object.values(database.pendingLinks); for (const key of ["groupId", "requesterId", "status", "urlHash"]) if (filters[key]) items = items.filter(item => item[key] === filters[key]); if (Array.isArray(filters.statuses)) items = items.filter(item => filters.statuses.includes(item.status)); return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(clone); }
  async function findDuplicatePendingLink({ groupId, requesterId, urlHash }) { const items = await findPendingLinks({ groupId, requesterId, urlHash }); return items.find(item => ["pending", "approved", "publishing"].includes(item.status)) || null; }
  async function reservePendingLinkPublication(requestId, actorId) { return (await mutate(database => { const item = database.pendingLinks[requestId]; if (!item || item.status !== "pending") return { reserved: false, request: item || null }; item.status = "publishing"; item.reviewedBy = actorId; item.updatedAt = nowIso(clock); return { reserved: true, request: item }; })).result; }
  async function releasePendingLinkPublication(requestId) { return (await mutate(database => { const item = database.pendingLinks[requestId]; if (!item || item.status !== "publishing") return null; item.status = "pending"; item.updatedAt = nowIso(clock); return item; })).result; }
  async function expirePendingLink(requestId) { return (await mutate(database => { const item = database.pendingLinks[requestId]; if (!item || !["pending", "approved"].includes(item.status)) return item || null; item.status = "expired"; item.updatedAt = nowIso(clock); return item; })).result; }
  async function saveNotificationReceipt(key, value) { return claimReceipt("linkNotifications", key, value); }
  async function savePublicationReceipt(key, value) { return claimReceipt("linkPublications", key, value); }
  async function addDomainRule(type, domain, metadata = {}) { if (!["whitelist", "blacklist"].includes(type)) throw new Error("Tipo de regra inválido."); return (await mutate(database => { const item = { domain, ...clone(metadata) }, key = ruleKey(domain, metadata); database.domainRules[type][key] = item; return item; })).result; }
  async function removeDomainRule(type, domain, metadata = {}) { if (!["whitelist", "blacklist"].includes(type)) throw new Error("Tipo de regra inválido."); return (await mutate(database => { const key = ruleKey(domain, metadata), current = database.domainRules[type][key] || null; delete database.domainRules[type][key]; return current; })).result; }
  async function getDomainRule(type, domain, metadata = {}) { if (!["whitelist", "blacklist"].includes(type)) return null; const database = await getDatabase(); return clone(database.domainRules[type][ruleKey(domain, metadata)] || null); }
  async function getDomainReputation(domain) { const database = await getDatabase(); return clone(database.domainRules.reputation[domain] || null); }
  async function updateDomainReputation(domain, patch) { return (await mutate(database => { const current = database.domainRules.reputation[domain] || { domain, score: 0, observations: 0, createdAt: nowIso(clock) }; return (database.domainRules.reputation[domain] = { ...current, ...clone(patch), domain, updatedAt: nowIso(clock) }); })).result; }

  return { initialize, getDatabase, getGroupConfig, ensureGroupConfig, updateGroupConfig, addWarningRecord, addWarningRecordIdempotent, getWarningRecords, clearWarningRecords, addBanRecord, getActiveBan, listActiveBans, revokeBan, countActiveBans, claimReceipt, appendHistory, listHistory, createPendingLink, getPendingLink, updatePendingLink, findPendingLinks, findDuplicatePendingLink, reservePendingLinkPublication, releasePendingLinkPublication, expirePendingLink, saveNotificationReceipt, savePublicationReceipt, addDomainRule, removeDomainRule, getDomainRule, getDomainReputation, updateDomainReputation, createBackup, recoverFromLatestBackup, normalizeDatabase, validateDatabase, getDefaultGroupConfig, dataPath, manifestPath, backupRoot };
}

const repository = createModerationRepository();
module.exports = { ...repository, createModerationRepository, getDefaultGroupConfig, emptyDatabase, SCHEMA_VERSION, DATASET_VERSION };
