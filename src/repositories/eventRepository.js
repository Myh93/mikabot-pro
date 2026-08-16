"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const SCHEMA_VERSION = 1;
const DATASET_VERSION = "1.0.0";
const DATA_FILES = ["events.json", "history.json", "settings.json", "schedules.json", "templates.json"];
const DEFAULT_DATABASE_DIR = path.join(__dirname, "..", "database", "events");
const DEFAULT_BACKUP_ROOT = path.join(__dirname, "..", "database", "backups", "events");
const VALID_STATUSES = new Set(["draft", "scheduled", "published", "running", "finished", "cancelled", "archived"]);
const VALID_PLATFORMS = new Set(["whatsapp", "telegram"]);
const queues = new Map();

const INITIAL_DATA = {
  "events.json": { events: {} },
  "history.json": { entries: [] },
  "settings.json": { global: {}, groups: {} },
  "schedules.json": { schedules: {} },
  "templates.json": { templates: {} }
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const nowIso = () => new Date().toISOString();
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const normalizeId = (id) => String(id || "").trim().toUpperCase();
const envelope = (data, updatedAt = nowIso()) => ({ schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION, updatedAt, data });
const validIso = (value) => value === null || value === undefined || (typeof value === "string" && Number.isFinite(Date.parse(value)));
const nextIso = (previous) => {
  const current = Date.now();
  const prior = Date.parse(previous || "");
  return new Date(Number.isFinite(prior) && current <= prior ? prior + 1 : current).toISOString();
};

function createEventRepository(options = {}) {
  const databaseDir = path.resolve(options.databaseDir || DEFAULT_DATABASE_DIR);
  const backupRoot = path.resolve(options.backupRoot || DEFAULT_BACKUP_ROOT);
  const manifestPath = path.join(databaseDir, "manifest.json");

  function enqueue(operation) {
    const previous = queues.get(databaseDir) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(databaseDir, current);
    return current.finally(() => {
      if (queues.get(databaseDir) === current) queues.delete(databaseDir);
    });
  }

  async function atomicWrite(filePath, content) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(temporary, filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async function checksum(filePath) {
    return sha256(await fsp.readFile(filePath));
  }

  async function readJson(filePath, label) {
    try {
      return JSON.parse(await fsp.readFile(filePath, "utf8"));
    } catch (error) {
      throw new Error(`${label} corrompido ou ausente: ${error.message}`);
    }
  }

  async function readEnvelope(file) {
    const parsed = await readJson(path.join(databaseDir, file), file);
    if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.datasetVersion !== DATASET_VERSION || !parsed.data || typeof parsed.data !== "object") {
      throw new Error(`Schema inválido em ${file}.`);
    }
    return parsed;
  }

  async function readManifest() {
    return readJson(manifestPath, "Manifesto de Eventos");
  }

  async function buildManifest(createdAt, nextEventNumber, status = "valid") {
    const checksums = {};
    for (const file of DATA_FILES) checksums[file] = { algorithm: "sha256", value: await checksum(path.join(databaseDir, file)) };
    const updatedAt = nowIso();
    return { schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION, createdAt: createdAt || updatedAt, updatedAt, status, files: [...DATA_FILES], checksums, nextEventNumber };
  }

  async function ensureInitialized() {
    await fsp.mkdir(databaseDir, { recursive: true });
    const manifestExists = await fsp.access(manifestPath).then(() => true, () => false);
    const dataExists = await Promise.all(DATA_FILES.map((file) => fsp.access(path.join(databaseDir, file)).then(() => true, () => false)));
    if (manifestExists || dataExists.some(Boolean)) {
      if (!manifestExists || dataExists.some((exists) => !exists)) throw new Error("Base de Eventos parcialmente inicializada; operação recusada.");
      return;
    }
    await enqueue(async () => {
      if (await fsp.access(manifestPath).then(() => true, () => false)) return;
      const timestamp = nowIso();
      for (const file of DATA_FILES) await atomicWrite(path.join(databaseDir, file), `${JSON.stringify(envelope(clone(INITIAL_DATA[file]), timestamp), null, 2)}\n`);
      await atomicWrite(manifestPath, `${JSON.stringify(await buildManifest(timestamp, 1), null, 2)}\n`);
    });
  }

  async function validateDatabase() {
    const errors = [];
    try {
      await ensureInitialized();
      const manifest = await readManifest();
      if (manifest.schemaVersion !== SCHEMA_VERSION) errors.push("schemaVersion inválido no manifesto.");
      if (manifest.datasetVersion !== DATASET_VERSION) errors.push("datasetVersion inválido no manifesto.");
      if (manifest.status !== "valid") errors.push("status inválido no manifesto.");
      if (!Number.isInteger(manifest.nextEventNumber) || manifest.nextEventNumber < 1) errors.push("nextEventNumber inválido.");
      if (!Array.isArray(manifest.files) || DATA_FILES.some((file) => !manifest.files.includes(file))) errors.push("Lista de arquivos incompleta.");
      for (const file of DATA_FILES) {
        await readEnvelope(file).catch((error) => errors.push(error.message));
        const actual = await checksum(path.join(databaseDir, file)).catch(() => null);
        if (!actual || manifest.checksums?.[file]?.value !== actual || manifest.checksums?.[file]?.algorithm !== "sha256") errors.push(`Checksum inválido para ${file}.`);
      }
    } catch (error) {
      errors.push(error.message);
    }
    return { valid: errors.length === 0, errors, schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION };
  }

  async function loadDatabase() {
    await ensureInitialized();
    const validation = await validateDatabase();
    if (!validation.valid) throw new Error(`Base de Eventos inválida: ${validation.errors.join(" ")}`);
    const result = { manifest: await readManifest() };
    for (const file of DATA_FILES) result[path.basename(file, ".json")] = (await readEnvelope(file)).data;
    return clone(result);
  }

  async function persist(updates, manifestChanges = {}) {
    const current = await readManifest();
    const timestamp = nowIso();
    for (const [file, data] of Object.entries(updates)) await atomicWrite(path.join(databaseDir, file), `${JSON.stringify(envelope(data, timestamp), null, 2)}\n`);
    await atomicWrite(manifestPath, `${JSON.stringify(await buildManifest(current.createdAt, manifestChanges.nextEventNumber ?? current.nextEventNumber), null, 2)}\n`);
  }

  async function saveDatabase(database) {
    await ensureInitialized();
    const validation = await validateDatabase();
    if (!validation.valid) throw new Error(`Base de Eventos inválida: ${validation.errors.join(" ")}`);
    return enqueue(async () => {
      const updates = {};
      for (const file of DATA_FILES) {
        const key = path.basename(file, ".json");
        if (!database?.[key] || typeof database[key] !== "object") throw new Error(`Dados ausentes para ${key}.`);
        updates[file] = clone(database[key]);
      }
      await persist(updates, { nextEventNumber: database.manifest?.nextEventNumber });
      return loadDatabase();
    });
  }

  async function mutate(files, operation) {
    await ensureInitialized();
    const validation = await validateDatabase();
    if (!validation.valid) throw new Error(`Base de Eventos inválida: ${validation.errors.join(" ")}`);
    return enqueue(async () => {
      const data = {};
      for (const file of files) data[file] = (await readEnvelope(file)).data;
      const manifest = await readManifest();
      const outcome = await operation(data, manifest);
      await persist(data, { nextEventNumber: manifest.nextEventNumber });
      return clone(outcome);
    });
  }

  function validateEvent(event) {
    if (!event || typeof event !== "object") throw new Error("Evento inválido.");
    if (!String(event.title || "").trim()) throw new Error("title não pode ser vazio.");
    if (!String(event.type || "").trim()) throw new Error("type não pode ser vazio.");
    if (!VALID_PLATFORMS.has(event.platform)) throw new Error("platform inválida.");
    if (!VALID_STATUSES.has(event.status)) throw new Error("status inválido.");
    if (["scheduled", "published", "running"].includes(event.status) && !event.groupId) throw new Error("Eventos agendados ou publicados exigem groupId.");
    if (!validIso(event.startsAt) || !validIso(event.endsAt)) throw new Error("Data ISO inválida.");
    if (event.startsAt && event.endsAt && Date.parse(event.endsAt) < Date.parse(event.startsAt)) throw new Error("endsAt não pode ser anterior a startsAt.");
    return true;
  }

  function historyEntry(eventId, action, authorId, details = {}, timestamp = nowIso()) {
    return { eventId, action, authorId: authorId || null, timestamp, details: clone(details) };
  }

  async function createEvent(input = {}, options = {}) {
    return mutate(["events.json", "history.json"], (data, manifest) => {
      const id = `E${String(manifest.nextEventNumber).padStart(4, "0")}`;
      manifest.nextEventNumber += 1;
      const timestamp = nowIso();
      const event = {
        id, type: input.type || "custom", title: String(input.title || "").trim(), description: input.description || "",
        platform: input.platform || "whatsapp", groupId: input.groupId || null, creatorId: input.creatorId || null,
        status: input.status || "draft", timezone: input.timezone || "America/Fortaleza", startsAt: input.startsAt || null,
        endsAt: input.endsAt || null, publishedAt: null, cancelledAt: null, finishedAt: null, archivedAt: null,
        prize: input.prize ?? null, notifications: clone(input.notifications || []), result: input.result ?? null,
        settings: clone(input.settings || {}), metadata: clone(input.metadata || {}), createdAt: timestamp, updatedAt: timestamp
      };
      validateEvent(event);
      data["events.json"].events[id] = event;
      data["history.json"].entries.push(historyEntry(id, "created", options.authorId || event.creatorId, {}, timestamp));
      return event;
    });
  }

  async function getEventById(id) {
    const database = await loadDatabase();
    return clone(database.events.events[normalizeId(id)] || null);
  }

  function sortEvents(events) {
    return events.sort((a, b) => {
      if (a.startsAt && b.startsAt) return Date.parse(a.startsAt) - Date.parse(b.startsAt) || a.id.localeCompare(b.id);
      if (a.startsAt) return -1;
      if (b.startsAt) return 1;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id);
    });
  }

  async function listEvents(filters = {}) {
    let events = Object.values((await loadDatabase()).events.events);
    for (const field of ["platform", "groupId", "creatorId", "status", "type"]) if (filters[field] !== undefined) events = events.filter((event) => event[field] === filters[field]);
    if (!filters.includeArchived) events = events.filter((event) => event.status !== "archived");
    if (filters.startsAfter) events = events.filter((event) => event.startsAt && Date.parse(event.startsAt) >= Date.parse(filters.startsAfter));
    if (filters.startsBefore) events = events.filter((event) => event.startsAt && Date.parse(event.startsAt) <= Date.parse(filters.startsBefore));
    return clone(sortEvents(events));
  }

  const listEventsByGroup = (platform, groupId, filters = {}) => listEvents({ ...filters, platform, groupId });
  const listEventsByStatus = (status, filters = {}) => listEvents({ ...filters, status });

  async function updateEvent(id, changes = {}, options = {}) {
    return mutate(["events.json", "history.json"], (data) => {
      const normalized = normalizeId(id);
      const current = data["events.json"].events[normalized];
      if (!current) return null;
      if (changes.id !== undefined && normalizeId(changes.id) !== current.id) throw new Error("O ID do evento é imutável.");
      if (changes.createdAt !== undefined && changes.createdAt !== current.createdAt) throw new Error("createdAt é imutável.");
      const updated = { ...current, ...clone(changes), id: current.id, createdAt: current.createdAt, updatedAt: nextIso(current.updatedAt) };
      validateEvent(updated);
      data["events.json"].events[normalized] = updated;
      data["history.json"].entries.push(historyEntry(normalized, options.action || "updated", options.authorId, options.details || {}));
      return updated;
    });
  }

  async function transition(id, target, options = {}) {
    return mutate(["events.json", "history.json"], (data) => {
      const normalized = normalizeId(id);
      const event = data["events.json"].events[normalized];
      if (!event) return null;
      if (event.status === target) return event;
      const allowed = {
        scheduled: ["draft"], published: ["draft", "scheduled"], running: ["published", "scheduled"],
        finished: ["running", "published"], cancelled: ["draft", "scheduled", "published", "running"],
        archived: ["draft", "scheduled", "published", "running", "finished", "cancelled"]
      };
      if (!allowed[target]?.includes(event.status)) throw new Error(`Transição inválida: ${event.status} -> ${target}.`);
      const timestamp = nextIso(event.updatedAt);
      const changes = clone(options.changes || {});
      if (target === "scheduled") changes.startsAt = changes.startsAt || event.startsAt;
      if (target === "published") changes.publishedAt = changes.publishedAt || timestamp;
      if (target === "finished") changes.finishedAt = changes.finishedAt || timestamp;
      if (target === "cancelled") changes.cancelledAt = changes.cancelledAt || timestamp;
      if (target === "archived") changes.archivedAt = changes.archivedAt || timestamp;
      Object.assign(event, changes, { status: target, id: event.id, createdAt: event.createdAt, updatedAt: timestamp });
      validateEvent(event);
      data["history.json"].entries.push(historyEntry(normalized, target === "running" ? "started" : target, options.authorId, options.details || {}, timestamp));
      return event;
    });
  }

  const scheduleEvent = (id, details = {}, options = {}) => transition(id, "scheduled", { ...options, changes: details });
  const publishEvent = (id, details = {}, options = {}) => transition(id, "published", { ...options, changes: details });
  const startEvent = (id, details = {}, options = {}) => transition(id, "running", { ...options, changes: details });
  const finishEvent = (id, details = {}, options = {}) => transition(id, "finished", { ...options, changes: details });
  const cancelEvent = (id, details = {}, options = {}) => transition(id, "cancelled", { ...options, changes: details });
  const archiveEvent = (id, details = {}, options = {}) => transition(id, "archived", { ...options, changes: details });

  async function deleteEvent(id, options = {}) {
    return mutate(["events.json", "history.json"], (data) => {
      const normalized = normalizeId(id);
      const event = data["events.json"].events[normalized];
      if (!event) return false;
      if (event.status !== "draft" && !options.administrativeOverride) throw new Error("Exclusão recusada; prefira arquivar o evento.");
      delete data["events.json"].events[normalized];
      data["history.json"].entries.push(historyEntry(normalized, "deleted", options.authorId, { snapshot: event }));
      return true;
    });
  }

  async function removePendingEventsByUser(userId, options = {}) {
    return mutate(["events.json", "history.json"], data => {
      let removed = 0;
      for (const event of Object.values(data["events.json"].events)) {
        if (event.creatorId !== userId || !["draft", "scheduled", "published"].includes(event.status)) continue;
        event.status = "cancelled";
        event.cancelledAt = nowIso();
        event.updatedAt = event.cancelledAt;
        data["history.json"].entries.push(historyEntry(event.id, "cancelled", options.authorId, { reason: "member_data_removal" }));
        removed += 1;
      }
      return { removed: removed > 0, itemsRemoved: removed };
    });
  }

  async function addHistoryEntry(entry) {
    return mutate(["history.json"], (data) => {
      if (!entry?.eventId || !entry.action) throw new Error("Histórico exige eventId e action.");
      const stored = historyEntry(normalizeId(entry.eventId), entry.action, entry.authorId, entry.details, entry.timestamp || nowIso());
      data["history.json"].entries.push(stored);
      return stored;
    });
  }

  async function listHistory(filters = {}) {
    let entries = (await loadDatabase()).history.entries;
    if (filters.eventId) entries = entries.filter((entry) => entry.eventId === normalizeId(filters.eventId));
    if (filters.action) entries = entries.filter((entry) => entry.action === filters.action);
    return clone(entries.slice(-(filters.limit || entries.length)));
  }

  async function getSettings() { return clone((await loadDatabase()).settings); }
  async function updateSettings(changes) { return mutate(["settings.json"], (data) => Object.assign(data["settings.json"], clone(changes), { updatedAt: nowIso() })); }
  async function getSchedules(filters = {}) { let items = Object.values((await loadDatabase()).schedules.schedules); if (filters.eventId) items = items.filter((item) => item.eventId === normalizeId(filters.eventId)); if (filters.status) items = items.filter((item) => item.status === filters.status); return clone(items); }
  async function saveSchedule(input) { return mutate(["schedules.json"], (data) => { const id = input.id || crypto.randomUUID(); if (data["schedules.json"].schedules[id]) throw new Error("Agendamento já existe."); const item = { ...clone(input), id, eventId: normalizeId(input.eventId), status: input.status || "scheduled", createdAt: input.createdAt || nowIso(), updatedAt: nowIso() }; data["schedules.json"].schedules[id] = item; return item; }); }
  async function updateSchedule(id, changes) { return mutate(["schedules.json"], (data) => { const item = data["schedules.json"].schedules[id]; if (!item) return null; Object.assign(item, clone(changes), { id, updatedAt: nowIso() }); return item; }); }
  const cancelSchedule = (id, details = {}) => updateSchedule(id, { ...details, status: "cancelled", cancelledAt: details.cancelledAt || nowIso() });
  async function getTemplates() { return clone(Object.values((await loadDatabase()).templates.templates)); }
  async function saveTemplate(input) { return mutate(["templates.json"], (data) => { const id = input.id || crypto.randomUUID(); if (data["templates.json"].templates[id]) throw new Error("Template já existe."); const item = { ...clone(input), id, createdAt: input.createdAt || nowIso(), updatedAt: nowIso() }; data["templates.json"].templates[id] = item; return item; }); }
  async function updateTemplate(id, changes) { return mutate(["templates.json"], (data) => { const item = data["templates.json"].templates[id]; if (!item) return null; Object.assign(item, clone(changes), { id, updatedAt: nowIso() }); return item; }); }
  async function deleteTemplate(id) { return mutate(["templates.json"], (data) => Boolean(delete data["templates.json"].templates[id])); }

  async function currentHashes() {
    const hashes = {};
    for (const file of ["manifest.json", ...DATA_FILES]) hashes[file] = await checksum(path.join(databaseDir, file));
    return hashes;
  }

  async function validateBackup(directory, hashes) {
    const errors = [];
    for (const [file, expected] of Object.entries(hashes)) if (await checksum(path.join(directory, file)).catch(() => null) !== expected) errors.push(`Checksum inválido no backup: ${file}.`);
    return { valid: errors.length === 0, errors, checkedAt: nowIso() };
  }

  async function createBackup() {
    await ensureInitialized();
    const validation = await validateDatabase();
    if (!validation.valid) throw new Error(`Backup recusado: ${validation.errors.join(" ")}`);
    return enqueue(async () => {
      const hashes = await currentHashes();
      await fsp.mkdir(backupRoot, { recursive: true });
      for (const entry of await fsp.readdir(backupRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(backupRoot, entry.name);
        try {
          const metadata = await readJson(path.join(directory, "backup-manifest.json"), "Manifesto de backup");
          if (Object.keys(hashes).every((file) => metadata.checksums?.[file]?.value === hashes[file]) && (await validateBackup(directory, hashes)).valid) return { directory, reused: true, validation: await validateBackup(directory, hashes) };
        } catch (_) { /* backup incompleto não é reutilizado */ }
      }
      const directory = path.join(backupRoot, nowIso().replace(/[:.]/g, "-"));
      await fsp.mkdir(directory, { recursive: false });
      for (const file of Object.keys(hashes)) await fsp.copyFile(path.join(databaseDir, file), path.join(directory, file), fs.constants.COPYFILE_EXCL);
      const checked = await validateBackup(directory, hashes);
      if (!checked.valid) throw new Error(`Backup inválido: ${checked.errors.join(" ")}`);
      const metadata = { date: nowIso(), datasetVersion: DATASET_VERSION, checksums: Object.fromEntries(Object.entries(hashes).map(([file, value]) => [file, { algorithm: "sha256", value }])), validation: checked, restorationInstruction: "Validar checksums e usar restoreBackup com este diretório.", status: "valid" };
      await atomicWrite(path.join(directory, "backup-manifest.json"), `${JSON.stringify(metadata, null, 2)}\n`);
      return { directory, reused: false, validation: checked };
    });
  }

  async function restoreBackup(backupDirectory, options = {}) {
    await ensureInitialized();
    const directory = path.resolve(backupDirectory);
    const relative = path.relative(backupRoot, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Backup fora do diretório autorizado.");
    if (!options.skipCurrentBackup) await createBackup();
    const restored = await enqueue(async () => {
      const metadata = await readJson(path.join(directory, "backup-manifest.json"), "Manifesto de backup");
      const hashes = Object.fromEntries(Object.entries(metadata.checksums || {}).map(([file, value]) => [file, value.value || value]));
      const required = ["manifest.json", ...DATA_FILES];
      const checked = await validateBackup(directory, hashes);
      if (!checked.valid || required.some((file) => !hashes[file])) throw new Error(`Restauração recusada: ${checked.errors.join(" ") || "backup incompleto"}.`);
      for (const file of DATA_FILES) await atomicWrite(path.join(databaseDir, file), await fsp.readFile(path.join(directory, file), "utf8"));
      await atomicWrite(manifestPath, await fsp.readFile(path.join(directory, "manifest.json"), "utf8"));
      const result = await validateDatabase();
      if (!result.valid) throw new Error(`Base restaurada inválida: ${result.errors.join(" ")}`);
      return { restored: true, directory, validation: result };
    });
    if (options.eventId) await addHistoryEntry({ eventId: options.eventId, action: "restored", authorId: options.authorId });
    return restored;
  }

  return {
    loadDatabase, validateDatabase, saveDatabase, createEvent, getEventById, listEvents, listEventsByGroup,
    listEventsByStatus, updateEvent, scheduleEvent, publishEvent, startEvent, finishEvent, cancelEvent,
    archiveEvent, deleteEvent, removePendingEventsByUser, addHistoryEntry, listHistory, getSettings, updateSettings, getSchedules,
    saveSchedule, updateSchedule, cancelSchedule, getTemplates, saveTemplate, updateTemplate, deleteTemplate,
    createBackup, restoreBackup
  };
}

const repository = createEventRepository();
module.exports = { ...repository, createEventRepository };
