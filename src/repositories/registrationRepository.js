"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const SCHEMA_VERSION = 1;
const DATASET_VERSION = "1.0.0";
const DATA_FILE = "registrations.json";
const queues = new Map();
const emptyData = () => ({ registrations: {}, identityIndex: {}, nickIndex: {}, friendCodeIndex: {}, history: {}, receipts: {} });
const clone = (value) => JSON.parse(JSON.stringify(value));
const nowIso = () => new Date().toISOString();
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function createRegistrationRepository(options = {}) {
  const databaseDir = path.resolve(options.databaseDir || path.join(__dirname, "..", "database", "registrations"));
  const backupRoot = path.resolve(options.backupRoot || path.join(__dirname, "..", "database", "backups", "registrations"));
  const manifestPath = path.join(databaseDir, "manifest.json");
  const dataPath = path.join(databaseDir, DATA_FILE);

  function enqueue(operation) {
    const previous = queues.get(databaseDir) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(databaseDir, current);
    return current.finally(() => { if (queues.get(databaseDir) === current) queues.delete(databaseDir); });
  }

  async function atomicWrite(file, content) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close(); handle = null;
      await fsp.rename(temporary, file);
      let directoryHandle;
      try { directoryHandle = await fsp.open(path.dirname(file), "r"); await directoryHandle.sync(); } catch (_) { /* Windows pode recusar fsync de diretório. */ }
      finally { if (directoryHandle) await directoryHandle.close().catch(() => undefined); }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  const envelope = (data, updatedAt = nowIso()) => ({ schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION, updatedAt, data });
  async function buildManifest(createdAt) {
    const updatedAt = nowIso();
    return { schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION, createdAt: createdAt || updatedAt, updatedAt, status: "valid", activeSource: DATA_FILE, legacySource: "../cadastros.json (somente leitura/histórico)", inactiveInvalidSource: "../entradas.json", files: [DATA_FILE], checksums: { [DATA_FILE]: { algorithm: "sha256", value: hash(await fsp.readFile(dataPath)) } } };
  }

  async function ensureInitialized() {
    await fsp.mkdir(databaseDir, { recursive: true });
    const exists = async (file) => fsp.access(file).then(() => true, () => false);
    const [hasData, hasManifest] = await Promise.all([exists(dataPath), exists(manifestPath)]);
    if (hasData || hasManifest) {
      if (!hasData || !hasManifest) throw new Error("Base de Cadastros parcialmente inicializada; operação recusada.");
      return;
    }
    await enqueue(async () => {
      if (await exists(dataPath)) return;
      await atomicWrite(dataPath, `${JSON.stringify(envelope(emptyData()), null, 2)}\n`);
      await atomicWrite(manifestPath, `${JSON.stringify(await buildManifest(), null, 2)}\n`);
    });
  }

  function rebuildIndexes(data) {
    const identityIndex = {}, nickIndex = {}, friendCodeIndex = {};
    for (const registration of Object.values(data.registrations || {})) {
      for (const alias of new Set([registration.primaryIdentity, ...(registration.identityAliases || [])].filter(Boolean))) {
        if (identityIndex[alias] && identityIndex[alias] !== registration.registrationId) throw new Error("Identidade duplicada detectada.");
        identityIndex[alias] = registration.registrationId;
      }
      const accounts = [{ nick: registration.mainAccount?.nick || registration.nick, friendCode: registration.mainAccount?.friendCode || registration.friendCode }, ...(registration.secondaryAccounts || [])];
      for (const account of accounts) {
        const nick = String(account.nick || "").trim().toLocaleLowerCase("pt-BR");
        if (nick && !(nickIndex[nick] ||= []).includes(registration.registrationId)) nickIndex[nick].push(registration.registrationId);
        const code = String(account.friendCode || "").replace(/\D/g, "");
        if (code) {
          if (friendCodeIndex[code] && friendCodeIndex[code] !== registration.registrationId) throw new Error("Friend Code duplicado detectado.");
          friendCodeIndex[code] = registration.registrationId;
        }
      }
    }
    return { identityIndex, nickIndex, friendCodeIndex };
  }

  function validateData(data) {
    const errors = [];
    if (!data || typeof data !== "object") return ["data ausente."];
    for (const key of ["registrations", "identityIndex", "nickIndex", "friendCodeIndex", "history", "receipts"]) if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) errors.push(`${key} inválido.`);
    if (errors.length) return errors;
    for (const [id, item] of Object.entries(data.registrations)) {
      if (item.registrationId !== id) errors.push(`registrationId divergente em ${id}.`);
      if (!item.platform || !item.primaryIdentity || !Array.isArray(item.identityAliases)) errors.push(`Registro incompleto em ${id}.`);
    }
    try {
      const expected = rebuildIndexes(data);
      for (const key of ["identityIndex", "nickIndex", "friendCodeIndex"]) if (JSON.stringify(data[key]) !== JSON.stringify(expected[key])) errors.push(`${key} órfão ou divergente.`);
    } catch (error) { errors.push(error.message); }
    return errors;
  }

  async function validateDatabase() {
    const errors = [];
    try {
      await ensureInitialized();
      const [rawData, rawManifest] = await Promise.all([fsp.readFile(dataPath), fsp.readFile(manifestPath, "utf8")]);
      let document, manifest;
      try { document = JSON.parse(rawData.toString("utf8")); manifest = JSON.parse(rawManifest); } catch (error) { return { valid: false, errors: [`JSON corrompido: ${error.message}`] }; }
      if (document.schemaVersion !== SCHEMA_VERSION || document.datasetVersion !== DATASET_VERSION || !document.data) errors.push("Envelope inválido.");
      if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.datasetVersion !== DATASET_VERSION || manifest.status !== "valid") errors.push("Manifesto inválido.");
      if (manifest.checksums?.[DATA_FILE]?.algorithm !== "sha256" || manifest.checksums?.[DATA_FILE]?.value !== hash(rawData)) errors.push("Checksum inválido para registrations.json.");
      errors.push(...validateData(document.data));
    } catch (error) { errors.push(error.message); }
    return { valid: errors.length === 0, errors, schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION };
  }

  async function loadDatabase() {
    const validation = await validateDatabase();
    if (!validation.valid) throw new Error(`Base de Cadastros inválida: ${validation.errors.join(" ")}`);
    return clone(JSON.parse(await fsp.readFile(dataPath, "utf8")));
  }

  async function persistData(data, createdAt) {
    Object.assign(data, rebuildIndexes(data));
    const errors = validateData(data); if (errors.length) throw new Error(errors.join(" "));
    await atomicWrite(dataPath, `${JSON.stringify(envelope(data), null, 2)}\n`);
    await atomicWrite(manifestPath, `${JSON.stringify(await buildManifest(createdAt), null, 2)}\n`);
  }

  async function saveDatabase(database) {
    await ensureInitialized();
    return enqueue(async () => {
      const currentManifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
      const data = clone(database.data || database);
      await persistData(data, currentManifest.createdAt);
      return loadDatabase();
    });
  }

  async function mutate(operation) {
    await ensureInitialized();
    return enqueue(async () => {
      const validation = await validateDatabase(); if (!validation.valid) throw new Error(`Base de Cadastros inválida: ${validation.errors.join(" ")}`);
      const document = JSON.parse(await fsp.readFile(dataPath, "utf8"));
      const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
      const result = await operation(document.data);
      await persistData(document.data, manifest.createdAt);
      return clone(result);
    });
  }

  async function getRegistrationById(id) { return clone((await loadDatabase()).data.registrations[String(id || "").toUpperCase()] || null); }
  async function findByIdentity(identity) { const db = (await loadDatabase()).data; return clone(db.registrations[db.identityIndex[identity]] || null); }
  async function findByNick(nick) { const db = (await loadDatabase()).data; return clone((db.nickIndex[String(nick || "").trim().toLocaleLowerCase("pt-BR")] || []).map(id => db.registrations[id])); }
  async function findByFriendCode(code) { const db = (await loadDatabase()).data; return clone(db.registrations[db.friendCodeIndex[String(code || "").replace(/\D/g, "")]] || null); }
  async function listRegistrations(filters = {}) { let values = Object.values((await loadDatabase()).data.registrations); for (const key of ["platform", "status", "validationStatus"]) if (filters[key]) values = values.filter(item => item[key] === filters[key]); return clone(values); }
  async function addHistoryEntry(registrationId, action, details = {}) { return mutate(data => { const entry = { action, timestamp: nowIso(), details: clone(details) }; (data.history[registrationId] ||= []).push(entry); return entry; }); }
  async function listHistory(registrationId) { return clone((await loadDatabase()).data.history[String(registrationId || "").toUpperCase()] || []); }
  function nextId(data) { const max = Object.keys(data.registrations).reduce((n, id) => Math.max(n, Number(id.slice(3)) || 0), 0); return `REG${String(max + 1).padStart(6, "0")}`; }
  async function createRegistration(input, options = {}) { return mutate(data => { const id = input.registrationId || nextId(data); if (data.registrations[id]) throw new Error("Registro já existe."); const timestamp = input.createdAt || nowIso(); const item = { ...clone(input), registrationId: id, createdAt: timestamp, updatedAt: input.updatedAt || timestamp }; data.registrations[id] = item; data.history[id] = [...(data.history[id] || []), { action: options.action || "created", timestamp, details: {} }]; return item; }); }
  async function updateRegistration(id, changes, options = {}) { return mutate(data => { const key = String(id || "").toUpperCase(), current = data.registrations[key]; if (!current) return null; if (changes.registrationId && changes.registrationId !== key) throw new Error("registrationId é imutável."); const beforeValidation = current.validationStatus; const aliasesAdded = (changes.identityAliases || []).filter(alias => !(current.identityAliases || []).includes(alias)); const timestamp = nowIso(); const item = { ...current, ...clone(changes), registrationId: key, createdAt: current.createdAt, updatedAt: timestamp }; data.registrations[key] = item; (data.history[key] ||= []).push({ action: options.action || "updated", timestamp, details: {} }); if (beforeValidation !== item.validationStatus) data.history[key].push({ action: "validation_changed", timestamp, details: {} }); for (const _alias of aliasesAdded) data.history[key].push({ action: "identity_alias_added", timestamp, details: {} }); return item; }); }
  async function upsertRegistration(input, options = {}) { const current = input.registrationId ? await getRegistrationById(input.registrationId) : await findByIdentity(input.primaryIdentity); return current ? updateRegistration(current.registrationId, input, options) : createRegistration(input, options); }
  async function reserveAccountId() { return mutate(data => { const next = Number(data.receipts.nextAccountNumber || 1); data.receipts.nextAccountNumber = next + 1; return `ACC${String(next).padStart(6, "0")}`; }); }
  async function removeRegistrationByIdentity(identity) { return mutate(data => { const id = data.identityIndex[identity]; if (!id || !data.registrations[id]) return { removed: false, registrationId: null }; delete data.registrations[id]; delete data.history[id]; return { removed: true, registrationId: id }; }); }

  async function createBackup(options = {}) {
    const sourceFile = path.resolve(options.sourceFile || dataPath);
    await fsp.mkdir(backupRoot, { recursive: true });
    const content = await fsp.readFile(sourceFile); JSON.parse(content.toString("utf8"));
    const checksum = hash(content), name = path.basename(sourceFile);
    for (const entry of await fsp.readdir(backupRoot, { withFileTypes: true })) if (entry.isDirectory()) { try { const meta = JSON.parse(await fsp.readFile(path.join(backupRoot, entry.name, "backup-manifest.json"), "utf8")); if (meta.checksums?.[name]?.value === checksum && hash(await fsp.readFile(path.join(backupRoot, entry.name, name))) === checksum) return { directory: path.join(backupRoot, entry.name), reused: true, validation: { valid: true } }; } catch (_) {} }
    const directory = path.join(backupRoot, nowIso().replace(/[:.]/g, "-")); await fsp.mkdir(directory);
    await fsp.copyFile(sourceFile, path.join(directory, name), fs.constants.COPYFILE_EXCL);
    const validation = { valid: hash(await fsp.readFile(path.join(directory, name))) === checksum, checkedAt: nowIso() };
    if (!validation.valid) throw new Error("Backup inválido.");
    const metadata = { date: nowIso(), source: name, checksums: { [name]: { algorithm: "sha256", value: checksum } }, validation, restorationInstruction: `Validar o SHA-256 e restaurar ${name} para a origem apropriada.`, status: "valid" };
    await atomicWrite(path.join(directory, "backup-manifest.json"), `${JSON.stringify(metadata, null, 2)}\n`);
    return { directory, reused: false, validation };
  }

  async function restoreBackup(directory, options = {}) {
    const resolved = path.resolve(directory), relative = path.relative(backupRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Backup fora do diretório autorizado.");
    const metadata = JSON.parse(await fsp.readFile(path.join(resolved, "backup-manifest.json"), "utf8"));
    const source = metadata.source || DATA_FILE, content = await fsp.readFile(path.join(resolved, source));
    if (hash(content) !== metadata.checksums?.[source]?.value) throw new Error("Checksum inválido no backup.");
    const target = options.targetFile || dataPath; JSON.parse(content.toString("utf8")); await atomicWrite(target, content);
    if (path.resolve(target) === dataPath) {
      const current = await fsp.readFile(manifestPath, "utf8").then(JSON.parse, () => ({}));
      await atomicWrite(manifestPath, `${JSON.stringify(await buildManifest(current.createdAt), null, 2)}\n`);
    }
    return { restored: true, target };
  }

  return { loadDatabase, validateDatabase, saveDatabase, getRegistrationById, findByIdentity, findByNick, findByFriendCode, createRegistration, updateRegistration, upsertRegistration, listRegistrations, addHistoryEntry, listHistory, reserveAccountId, removeRegistrationByIdentity, createBackup, restoreBackup, createRegistrationRepository };
}

const repository = createRegistrationRepository();
module.exports = { ...repository, createRegistrationRepository };
