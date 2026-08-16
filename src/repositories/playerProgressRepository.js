"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const SCHEMA_VERSION = 1;
const DATASET_VERSION = "1.0.0";
const DEFAULT_DIR = path.join(__dirname, "..", "database", "player-progress");
const DEFAULT_BACKUPS = path.join(__dirname, "..", "database", "backups", "player-progress");
const queues = new Map();
const clone = (value) => JSON.parse(JSON.stringify(value));
const checksum = (value) => crypto.createHash("sha256").update(value).digest("hex");
const iso = () => new Date().toISOString();

function createPlayerProgressRepository(options = {}) {
  const databaseDir = path.resolve(options.databaseDir || DEFAULT_DIR);
  const backupRoot = path.resolve(options.backupRoot || DEFAULT_BACKUPS);
  const progressPath = path.join(databaseDir, "progress.json");
  const manifestPath = path.join(databaseDir, "manifest.json");
  const clock = options.clock || (() => new Date());
  const now = () => clock().toISOString();
  const groupKey = (platform, groupId, playerId) => `${platform}:${groupId}:${playerId}`;
  const globalKey = (platform, playerId) => `${platform}:${playerId}`;

  function fortalezaDateParts(date = clock()) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  }
  function getCurrentWeekKey(date = clock()) {
    const { year, month, day } = fortalezaDateParts(date);
    const local = new Date(Date.UTC(year, month - 1, day));
    const weekday = local.getUTCDay() || 7;
    local.setUTCDate(local.getUTCDate() + 4 - weekday);
    const weekYear = local.getUTCFullYear();
    const first = new Date(Date.UTC(weekYear, 0, 1));
    const week = Math.ceil((((local - first) / 86400000) + 1) / 7);
    return `${weekYear}-W${String(week).padStart(2, "0")}`;
  }
  function getCurrentMonthKey(date = clock()) { const { year, month } = fortalezaDateParts(date); return `${year}-${String(month).padStart(2, "0")}`; }

  function normalizePeriodCounters(progress, date = clock()) {
    const result = { ...progress, periodHistory: { ...(progress.periodHistory || {}) } };
    const weekKey = getCurrentWeekKey(date); const monthKey = getCurrentMonthKey(date);
    if (result.weeklyPeriodKey !== weekKey) {
      if (result.weeklyPeriodKey) result.periodHistory[result.weeklyPeriodKey] = { xp: Number(result.weeklyXp || 0), correctAnswers: Number(result.weeklyCorrectAnswers || 0), wins: Number(result.weeklyWins || 0), mvpCount: Number(result.weeklyMvpCount || 0), bestCombo: Number(result.weeklyBestCombo || 0) };
      Object.assign(result, { weeklyXp: 0, weeklyCorrectAnswers: 0, weeklyWins: 0, weeklyMvpCount: 0, weeklyBestCombo: 0, weeklyPeriodKey: weekKey });
    }
    if (result.monthlyPeriodKey !== monthKey) {
      if (result.monthlyPeriodKey) result.periodHistory[result.monthlyPeriodKey] = { xp: Number(result.monthlyXp || 0), correctAnswers: Number(result.monthlyCorrectAnswers || 0), wins: Number(result.monthlyWins || 0), mvpCount: Number(result.monthlyMvpCount || 0), bestCombo: Number(result.monthlyBestCombo || 0) };
      Object.assign(result, { monthlyXp: 0, monthlyCorrectAnswers: 0, monthlyWins: 0, monthlyMvpCount: 0, monthlyBestCombo: 0, monthlyPeriodKey: monthKey });
    }
    return result;
  }
  function archivePreviousPeriodSummary(progress, date = clock()) { return normalizePeriodCounters(progress, date); }
  function applyPeriodDeltas(previous, next) {
    const result = normalizePeriodCounters(next);
    const old = normalizePeriodCounters(previous);
    const deltas = { Xp: Number(next.xp || 0) - Number(previous.xp || 0), CorrectAnswers: Number(next.correctAnswers || 0) - Number(previous.correctAnswers || 0), Wins: Number(next.wins || 0) - Number(previous.wins || 0), MvpCount: Number(next.mvpCount || 0) - Number(previous.mvpCount || 0) };
    for (const [suffix, delta] of Object.entries(deltas)) {
      result[`weekly${suffix}`] = Math.max(0, Number(old[`weekly${suffix}`] || 0) + Math.max(0, delta));
      result[`monthly${suffix}`] = Math.max(0, Number(old[`monthly${suffix}`] || 0) + Math.max(0, delta));
    }
    result.weeklyBestCombo = Math.max(Number(old.weeklyBestCombo || 0), Number(next.currentCombo || 0));
    result.monthlyBestCombo = Math.max(Number(old.monthlyBestCombo || 0), Number(next.currentCombo || 0));
    return result;
  }

  function enqueue(operation) {
    const previous = queues.get(databaseDir) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(databaseDir, current);
    return current.finally(() => { if (queues.get(databaseDir) === current) queues.delete(databaseDir); });
  }

  async function atomicWrite(filePath, value) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(value, "utf8");
      await handle.sync();
      await handle.close(); handle = null;
      await fsp.rename(temporary, filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  function emptyDatabase() {
    return { schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION, updatedAt: now(), data: { groups: {}, global: {}, receipts: {} } };
  }

  function validateDatabase(database) {
    const errors = [];
    if (database?.schemaVersion !== SCHEMA_VERSION) errors.push("schemaVersion inválido");
    if (database?.datasetVersion !== DATASET_VERSION) errors.push("datasetVersion inválido");
    if (!database?.data || typeof database.data !== "object") errors.push("data inválido");
    for (const field of ["groups", "global", "receipts"]) if (!database?.data?.[field] || typeof database.data[field] !== "object" || Array.isArray(database.data[field])) errors.push(`${field} inválido`);
    return { valid: errors.length === 0, errors };
  }

  async function writeSet(database, createdAt = now()) {
    const progressText = `${JSON.stringify(database, null, 2)}\n`;
    await atomicWrite(progressPath, progressText);
    const manifest = { schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION, createdAt, updatedAt: now(), files: ["progress.json"], checksums: { "progress.json": { algorithm: "sha256", value: checksum(progressText) } }, status: "valid" };
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  async function ensureInitialized() {
    await fsp.mkdir(databaseDir, { recursive: true });
    const progressExists = fs.existsSync(progressPath);
    const manifestExists = fs.existsSync(manifestPath);
    if (progressExists !== manifestExists) throw new Error("Base de progresso parcialmente inicializada.");
    if (!progressExists) await enqueue(() => writeSet(emptyDatabase()));
  }

  async function loadDatabase() {
    await ensureInitialized();
    let database; let manifest; let text;
    try {
      text = await fsp.readFile(progressPath, "utf8");
      database = JSON.parse(text);
      manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    } catch (error) { throw new Error(`Banco de progresso corrompido: ${error.message}`); }
    const validation = validateDatabase(database);
    if (!validation.valid) throw new Error(`Banco de progresso inválido: ${validation.errors.join(", ")}.`);
    if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.datasetVersion !== DATASET_VERSION || manifest.status !== "valid") throw new Error("Manifesto de progresso inválido.");
    if (manifest.checksums?.["progress.json"]?.value !== checksum(text)) throw new Error("Checksum incorreto em progress.json.");
    return clone(database);
  }

  async function saveQuizDatabase(database) { return saveDatabase(database); }
  async function saveDatabase(database) {
    const validation = validateDatabase(database);
    if (!validation.valid) throw new Error(`Banco de progresso inválido: ${validation.errors.join(", ")}.`);
    return enqueue(async () => { database.updatedAt = now(); await writeSet(database); return clone(database); });
  }

  function blank(platform, groupId, playerId, displayName) {
    const timestamp = now();
    return normalizePeriodCounters({ platform, groupId, playerId, displayName: displayName || "Treinador", xp: 0, level: 1, correctAnswers: 0, wrongAnswers: 0, currentCombo: 0, bestCombo: 0, wins: 0, mvpCount: 0, marathonsPlayed: 0, marathonsFinished: 0, firstCorrectAt: null, lastCorrectAt: null, lastAnsweredAt: null, createdAt: timestamp, updatedAt: timestamp });
  }

  async function mutate(operation) {
    return enqueue(async () => {
      const database = await loadDatabase();
      const result = await operation(database);
      database.updatedAt = now();
      const oldReceipts = database.data.receipts;
      const threshold = clock().getTime() - 90 * 24 * 60 * 60 * 1000;
      database.data.receipts = Object.fromEntries(Object.entries(oldReceipts).filter(([, receipt]) => Date.parse(receipt.createdAt) >= threshold));
      await writeSet(database);
      return clone(result);
    });
  }

  async function getPlayerProgress(platform, groupId, playerId) { const value = (await loadDatabase()).data.groups[groupKey(platform, groupId, playerId)] || null; return value ? clone(normalizePeriodCounters(value)) : null; }
  async function getOrCreatePlayerProgress(platform, groupId, playerId, displayName) {
    const existing = await getPlayerProgress(platform, groupId, playerId); if (existing) return existing;
    return mutate((db) => db.data.groups[groupKey(platform, groupId, playerId)] ||= blank(platform, groupId, playerId, displayName));
  }
  async function updatePlayerProgress(platform, groupId, playerId, updater, operationId) {
    return mutate((db) => {
      if (operationId && db.data.receipts[operationId]) return { progress: db.data.groups[groupKey(platform, groupId, playerId)], applied: false };
      const key = groupKey(platform, groupId, playerId);
      const current = db.data.groups[key] || blank(platform, groupId, playerId);
      const changes = typeof updater === "function" ? updater(clone(current)) : updater;
      db.data.groups[key] = applyPeriodDeltas(current, { ...current, ...changes, platform, groupId, playerId, createdAt: current.createdAt, updatedAt: now() });
      if (operationId) db.data.receipts[operationId] = { createdAt: now() };
      return { progress: db.data.groups[key], applied: true };
    });
  }
  async function incrementPlayerStats(platform, groupId, playerId, changes, operationId) {
    return updatePlayerProgress(platform, groupId, playerId, (current) => {
      const next = { ...current };
      for (const [field, value] of Object.entries(changes || {})) next[field] = typeof value === "number" ? Number(next[field] || 0) + value : value;
      return next;
    }, operationId);
  }
  async function listGroupProgress(platform, groupId) { return Object.values((await loadDatabase()).data.groups).filter((entry) => entry.platform === platform && entry.groupId === groupId).map((entry) => normalizePeriodCounters(entry)); }
  async function getGlobalProgress(platform, playerId) { const value = (await loadDatabase()).data.global[globalKey(platform, playerId)] || null; return value ? clone(normalizePeriodCounters(value)) : null; }
  async function updateGlobalProgress(platform, playerId, updater, operationId) {
    return mutate((db) => {
      const receipt = operationId ? `global:${operationId}` : null;
      if (receipt && db.data.receipts[receipt]) return { progress: db.data.global[globalKey(platform, playerId)], applied: false };
      const key = globalKey(platform, playerId); const current = db.data.global[key] || blank(platform, null, playerId);
      const changes = typeof updater === "function" ? updater(clone(current)) : updater;
      db.data.global[key] = applyPeriodDeltas(current, { ...current, ...changes, platform, groupId: null, playerId, createdAt: current.createdAt, updatedAt: now() });
      if (receipt) db.data.receipts[receipt] = { createdAt: now() };
      return { progress: db.data.global[key], applied: true };
    });
  }
  async function listGlobalProgress(platform) { return Object.values((await loadDatabase()).data.global).filter((entry) => entry.platform === platform).map((entry) => normalizePeriodCounters(entry)); }
  async function listWeeklyProgress(platform, groupId = null) { const entries = groupId ? await listGroupProgress(platform, groupId) : await listGlobalProgress(platform); return entries.filter((entry) => entry.weeklyPeriodKey === getCurrentWeekKey() && [entry.weeklyXp, entry.weeklyCorrectAnswers, entry.weeklyWins, entry.weeklyMvpCount].some((value) => Number(value || 0) > 0)); }
  async function listMonthlyProgress(platform, groupId = null) { const entries = groupId ? await listGroupProgress(platform, groupId) : await listGlobalProgress(platform); return entries.filter((entry) => entry.monthlyPeriodKey === getCurrentMonthKey() && [entry.monthlyXp, entry.monthlyCorrectAnswers, entry.monthlyWins, entry.monthlyMvpCount].some((value) => Number(value || 0) > 0)); }

  async function resetPlayerData(platform, playerId) {
    return mutate(db => {
      let removed = 0;
      for (const [key, value] of Object.entries(db.data.groups)) if (value.playerId === playerId && value.platform === platform) { delete db.data.groups[key]; removed += 1; }
      const global = globalKey(platform, playerId);
      if (db.data.global[global]) { delete db.data.global[global]; removed += 1; }
      for (const key of Object.keys(db.data.receipts)) if (key.includes(`:${playerId}:`)) delete db.data.receipts[key];
      return { removed: removed > 0, itemsRemoved: removed };
    });
  }

  async function createBackup() {
    await ensureInitialized();
    const progress = await fsp.readFile(progressPath); const manifest = await fsp.readFile(manifestPath);
    const fingerprint = checksum(Buffer.concat([progress, manifest]));
    await fsp.mkdir(backupRoot, { recursive: true });
    for (const name of await fsp.readdir(backupRoot).catch(() => [])) {
      const file = path.join(backupRoot, name, "backup-manifest.json");
      const saved = await fsp.readFile(file, "utf8").then(JSON.parse).catch(() => null);
      if (saved?.fingerprint === fingerprint) return { path: path.dirname(file), reused: true };
    }
    const directory = path.join(backupRoot, now().replace(/[:.]/g, "-")); await fsp.mkdir(directory, { recursive: false });
    await atomicWrite(path.join(directory, "progress.json"), progress.toString()); await atomicWrite(path.join(directory, "manifest.json"), manifest.toString());
    const backupManifest = { createdAt: now(), schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION, fingerprint, checksums: { "progress.json": checksum(progress), "manifest.json": checksum(manifest) }, validation: "valid", restore: "Use restoreBackup(caminho)." };
    await atomicWrite(path.join(directory, "backup-manifest.json"), `${JSON.stringify(backupManifest, null, 2)}\n`);
    return { path: directory, reused: false };
  }

  async function restoreBackup(directory, options = {}) {
    const backupManifest = JSON.parse(await fsp.readFile(path.join(directory, "backup-manifest.json"), "utf8"));
    const progress = await fsp.readFile(path.join(directory, "progress.json")); const manifest = await fsp.readFile(path.join(directory, "manifest.json"));
    if (checksum(progress) !== backupManifest.checksums["progress.json"] || checksum(manifest) !== backupManifest.checksums["manifest.json"]) throw new Error("Backup de progresso com checksum inválido.");
    if (!options.skipCurrentBackup) await createBackup();
    return enqueue(async () => { await atomicWrite(progressPath, progress.toString()); await atomicWrite(manifestPath, manifest.toString()); return loadDatabase(); });
  }

  return { loadDatabase, validateDatabase, saveDatabase, saveQuizDatabase, getPlayerProgress, getOrCreatePlayerProgress, updatePlayerProgress, incrementPlayerStats, listGroupProgress, getGlobalProgress, updateGlobalProgress, listGlobalProgress, listWeeklyProgress, listMonthlyProgress, resetPlayerData, getCurrentWeekKey, getCurrentMonthKey, normalizePeriodCounters, archivePreviousPeriodSummary, createBackup, restoreBackup };
}

const repository = createPlayerProgressRepository();
module.exports = { ...repository, createPlayerProgressRepository, SCHEMA_VERSION, DATASET_VERSION };
