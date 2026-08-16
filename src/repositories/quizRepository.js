"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const SCHEMA_VERSION = 1;
const DATASET_VERSION = "1.0.0";
const DATA_FILES = ["settings.json", "sessions.json", "rankings.json", "profiles.json", "history.json", "schedules.json", "recentQuestions.json"];
const DEFAULT_DATABASE_DIR = path.join(__dirname, "..", "database", "quiz");
const DEFAULT_BACKUP_ROOT = path.join(__dirname, "..", "database", "backups", "quiz");
const writerQueues = new Map();

const INITIAL_DATA = {
  "settings.json": { groups: {} },
  "sessions.json": { sessions: {} },
  "rankings.json": { groups: {}, global: {} },
  "profiles.json": { groups: {}, global: {} },
  "history.json": { entries: [] },
  "schedules.json": { schedules: {} },
  "recentQuestions.json": { groups: {} }
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function groupKey(platform, groupId) {
  if (!platform || !groupId) throw new Error("platform e groupId são obrigatórios.");
  return `${platform}:${groupId}`;
}

function userKey(platform, groupId, userId) {
  if (!userId) throw new Error("userId é obrigatório.");
  return `${groupKey(platform, groupId)}:${userId}`;
}

function globalUserKey(platform, userId) {
  if (!platform || !userId) throw new Error("platform e userId são obrigatórios.");
  return `${platform}:${userId}`;
}

function roundKey(platform, groupId, roundId) {
  if (!roundId) throw new Error("roundId é obrigatório.");
  return `${groupKey(platform, groupId)}:${roundId}`;
}

function envelope(data, updatedAt = nowIso()) {
  return { schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION, updatedAt, data };
}

function defaultProfile() {
  return {
    points: 0,
    correctAnswers: 0,
    wrongAnswers: 0,
    gamesPlayed: 0,
    wins: 0,
    currentStreak: 0,
    bestStreak: 0,
    performanceByQuestionType: {},
    performanceByDifficulty: {},
    lastPlayedAt: null
  };
}

function addNumericStats(profile, changes) {
  const result = { ...defaultProfile(), ...profile };
  for (const field of ["points", "correctAnswers", "wrongAnswers", "gamesPlayed", "wins"]) {
    if (changes[field] !== undefined) result[field] = Number(result[field] || 0) + Number(changes[field] || 0);
  }
  if (changes.currentStreak !== undefined) result.currentStreak = Number(changes.currentStreak);
  if (changes.streakDelta !== undefined) result.currentStreak = Math.max(0, result.currentStreak + Number(changes.streakDelta));
  result.bestStreak = Math.max(Number(result.bestStreak || 0), Number(changes.bestStreak || 0), result.currentStreak);
  if (changes.questionType) {
    const current = result.performanceByQuestionType[changes.questionType] || { correct: 0, wrong: 0, played: 0 };
    result.performanceByQuestionType = { ...result.performanceByQuestionType, [changes.questionType]: {
      correct: current.correct + Number(changes.correctAnswers || 0),
      wrong: current.wrong + Number(changes.wrongAnswers || 0),
      played: current.played + Number(changes.gamesPlayed || 0)
    } };
  }
  if (changes.difficulty) {
    const current = result.performanceByDifficulty[changes.difficulty] || { correct: 0, wrong: 0, played: 0 };
    result.performanceByDifficulty = { ...result.performanceByDifficulty, [changes.difficulty]: {
      correct: current.correct + Number(changes.correctAnswers || 0),
      wrong: current.wrong + Number(changes.wrongAnswers || 0),
      played: current.played + Number(changes.gamesPlayed || 0)
    } };
  }
  result.lastPlayedAt = changes.lastPlayedAt || result.lastPlayedAt || nowIso();
  return result;
}

function createQuizRepository(options = {}) {
  const databaseDir = path.resolve(options.databaseDir || DEFAULT_DATABASE_DIR);
  const backupRoot = path.resolve(options.backupRoot || DEFAULT_BACKUP_ROOT);
  const manifestPath = path.join(databaseDir, "manifest.json");

  function enqueue(operation) {
    const previous = writerQueues.get(databaseDir) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    writerQueues.set(databaseDir, current);
    return current.finally(() => {
      if (writerQueues.get(databaseDir) === current) writerQueues.delete(databaseDir);
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
      let directoryHandle;
      try {
        directoryHandle = await fsp.open(path.dirname(filePath), "r");
        await directoryHandle.sync();
      } catch (_) {
        // Alguns sistemas não permitem fsync de diretório; o fsync do arquivo já foi concluído.
      } finally {
        if (directoryHandle) await directoryHandle.close().catch(() => undefined);
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async function fileChecksum(filePath) {
    return sha256(await fsp.readFile(filePath));
  }

  async function readEnvelope(file) {
    const filePath = path.join(databaseDir, file);
    let parsed;
    try {
      parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
    } catch (error) {
      throw new Error(`Arquivo do Quiz corrompido ou ausente (${file}): ${error.message}`);
    }
    if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.datasetVersion !== DATASET_VERSION || !parsed.data || typeof parsed.data !== "object") {
      throw new Error(`Schema inválido em ${file}.`);
    }
    return parsed;
  }

  async function buildManifest(createdAt, status = "valid") {
    const checksums = {};
    for (const file of DATA_FILES) checksums[file] = { algorithm: "sha256", value: await fileChecksum(path.join(databaseDir, file)) };
    const updatedAt = nowIso();
    return { schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION, createdAt: createdAt || updatedAt, updatedAt, files: [...DATA_FILES], checksums, status };
  }

  async function ensureInitialized() {
    await fsp.mkdir(databaseDir, { recursive: true });
    const manifestExists = await fsp.access(manifestPath).then(() => true, () => false);
    const existingData = await Promise.all(DATA_FILES.map((file) => fsp.access(path.join(databaseDir, file)).then(() => true, () => false)));
    if (manifestExists || existingData.some(Boolean)) {
      if (!manifestExists || existingData.some((exists) => !exists)) throw new Error("Base do Quiz parcialmente inicializada; inicialização segura recusada.");
      const existingManifest = await readManifest();
      if (existingManifest.status === "initializing") {
        await enqueue(async () => {
          const timestamp = nowIso();
          for (const file of DATA_FILES) {
            const current = await readEnvelope(file);
            await atomicWrite(path.join(databaseDir, file), `${JSON.stringify(envelope(current.data, timestamp), null, 2)}\n`);
          }
          await atomicWrite(manifestPath, `${JSON.stringify(await buildManifest(timestamp), null, 2)}\n`);
        });
      }
      return;
    }
    await enqueue(async () => {
      const checkAgain = await fsp.access(manifestPath).then(() => true, () => false);
      if (checkAgain) return;
      const timestamp = nowIso();
      for (const file of DATA_FILES) await atomicWrite(path.join(databaseDir, file), `${JSON.stringify(envelope(clone(INITIAL_DATA[file]), timestamp), null, 2)}\n`);
      await atomicWrite(manifestPath, `${JSON.stringify(await buildManifest(timestamp), null, 2)}\n`);
    });
  }

  async function readManifest() {
    let manifest;
    try {
      manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`Manifesto do Quiz corrompido ou ausente: ${error.message}`);
    }
    return manifest;
  }

  async function validateQuizDatabase() {
    const errors = [];
    try {
      await ensureInitialized();
      const manifest = await readManifest();
      if (manifest.schemaVersion !== SCHEMA_VERSION) errors.push("schemaVersion inválido no manifesto.");
      if (manifest.datasetVersion !== DATASET_VERSION) errors.push("datasetVersion inválido no manifesto.");
      if (manifest.status !== "valid") errors.push("status do manifesto não é valid.");
      if (!Array.isArray(manifest.files) || DATA_FILES.some((file) => !manifest.files.includes(file))) errors.push("Lista de arquivos incompleta no manifesto.");
      for (const file of DATA_FILES) {
        await readEnvelope(file).catch((error) => errors.push(error.message));
        const expected = typeof manifest.checksums?.[file] === "string" ? manifest.checksums[file] : manifest.checksums?.[file]?.value;
        const actual = await fileChecksum(path.join(databaseDir, file)).catch(() => null);
        if (!expected || expected !== actual) errors.push(`Checksum inválido para ${file}.`);
      }
    } catch (error) {
      errors.push(error.message);
    }
    return { valid: errors.length === 0, errors, schemaVersion: SCHEMA_VERSION, datasetVersion: DATASET_VERSION };
  }

  async function loadQuizDatabase() {
    await ensureInitialized();
    const validation = await validateQuizDatabase();
    if (!validation.valid) throw new Error(`Base do Quiz inválida: ${validation.errors.join(" ")}`);
    const result = { manifest: await readManifest() };
    for (const file of DATA_FILES) result[path.basename(file, ".json")] = (await readEnvelope(file)).data;
    return clone(result);
  }

  async function persistFiles(updates) {
    const currentManifest = await readManifest();
    for (const [file, data] of Object.entries(updates)) await atomicWrite(path.join(databaseDir, file), `${JSON.stringify(envelope(data), null, 2)}\n`);
    await atomicWrite(manifestPath, `${JSON.stringify(await buildManifest(currentManifest.createdAt), null, 2)}\n`);
  }

  async function saveQuizDatabase(database) {
    await ensureInitialized();
    return enqueue(async () => {
      const updates = {};
      for (const file of DATA_FILES) {
        const key = path.basename(file, ".json");
        if (!database || !database[key] || typeof database[key] !== "object") throw new Error(`Dados ausentes para ${key}.`);
        updates[file] = clone(database[key]);
      }
      await persistFiles(updates);
      return loadQuizDatabase();
    });
  }

  async function mutate(files, operation) {
    await ensureInitialized();
    return enqueue(async () => {
      const data = {};
      for (const file of files) data[file] = (await readEnvelope(file)).data;
      const result = await operation(data);
      await persistFiles(data);
      return clone(result);
    });
  }

  async function getGroupSettings(platform, groupId) {
    await ensureInitialized();
    const settings = (await readEnvelope("settings.json")).data.groups[groupKey(platform, groupId)];
    return clone(settings || { platform, groupId, timezone: "UTC", enabled: true, cooldownSeconds: 0 });
  }

  async function updateGroupSettings(platform, groupId, changes) {
    return mutate(["settings.json"], ({ "settings.json": settings }) => {
      const key = groupKey(platform, groupId);
      settings.groups[key] = { platform, groupId, timezone: "UTC", enabled: true, cooldownSeconds: 0, ...(settings.groups[key] || {}), ...clone(changes), updatedAt: nowIso() };
      return settings.groups[key];
    });
  }

  async function getActiveSession(platform, groupId, options = {}) {
    await ensureInitialized();
    const sessions = Object.values((await readEnvelope("sessions.json")).data.sessions);
    const session = sessions.find((item) => item.platform === platform && item.groupId === groupId && item.status === "active") || null;
    if (!session) return null;
    const result = clone(session);
    result.isExpired = Boolean(result.expiresAt && Date.parse(result.expiresAt) <= Date.now());
    if (options.excludeExpired && result.isExpired) return null;
    return result;
  }

  async function createSession(session) {
    return mutate(["sessions.json"], ({ "sessions.json": store }) => {
      const required = ["platform", "groupId", "roundId", "mode", "questionType", "pokemonId", "startedAt", "expiresAt"];
      const missing = required.filter((field) => session?.[field] === undefined || session[field] === null || session[field] === "");
      if (missing.length) throw new Error(`Sessão incompleta: ${missing.join(", ")}.`);
      const active = Object.values(store.sessions).find((item) => item.platform === session.platform && item.groupId === session.groupId && item.status === "active");
      if (active) throw new Error(`Já existe uma sessão ativa para ${groupKey(session.platform, session.groupId)}.`);
      const key = roundKey(session.platform, session.groupId, session.roundId);
      if (store.sessions[key]) throw new Error(`Rodada ${key} já existe.`);
      store.sessions[key] = {
        acceptedAnswers: [], attemptsByUser: {}, participants: {}, difficulty: "normal", points: 10,
        winnerId: null, finishedAt: null, ...clone(session), status: "active"
      };
      return store.sessions[key];
    });
  }

  async function updateSession(platform, groupId, roundId, changes) {
    return mutate(["sessions.json"], ({ "sessions.json": store }) => {
      const key = roundKey(platform, groupId, roundId);
      if (!store.sessions[key]) throw new Error(`Sessão ${key} não encontrada.`);
      store.sessions[key] = { ...store.sessions[key], ...clone(changes), platform, groupId, roundId, updatedAt: nowIso() };
      return store.sessions[key];
    });
  }

  async function finishSession(platform, groupId, roundId, details = {}) {
    return mutate(["sessions.json", "history.json"], (data) => {
      const key = roundKey(platform, groupId, roundId);
      const session = data["sessions.json"].sessions[key];
      if (!session) throw new Error(`Sessão ${key} não encontrada.`);
      if (session.status === "finished") return session;
      Object.assign(session, clone(details), { status: "finished", finishedAt: details.finishedAt || nowIso(), updatedAt: nowIso() });
      if (!data["history.json"].entries.some((entry) => entry.type === "session_finished" && entry.sessionKey === key)) {
        data["history.json"].entries.push({ id: crypto.randomUUID(), type: "session_finished", sessionKey: key, platform, groupId, roundId, createdAt: session.finishedAt, session: clone(session) });
      }
      return session;
    });
  }

  async function deleteSession(platform, groupId, roundId) {
    return mutate(["sessions.json"], ({ "sessions.json": store }) => {
      const key = roundKey(platform, groupId, roundId);
      const existed = Boolean(store.sessions[key]);
      delete store.sessions[key];
      return existed;
    });
  }

  async function getUserProfile(platform, groupId, userId, options = {}) {
    await ensureInitialized();
    const profiles = (await readEnvelope("profiles.json")).data;
    const key = options.global ? globalUserKey(platform, userId) : userKey(platform, groupId, userId);
    return clone((options.global ? profiles.global[key] : profiles.groups[key]) || defaultProfile());
  }

  async function updateUserProfile(platform, groupId, userId, changes, options = {}) {
    return mutate(["profiles.json"], ({ "profiles.json": profiles }) => {
      const key = options.global ? globalUserKey(platform, userId) : userKey(platform, groupId, userId);
      const collection = options.global ? profiles.global : profiles.groups;
      collection[key] = { ...defaultProfile(), ...(collection[key] || {}), ...clone(changes), platform, userId, ...(options.global ? {} : { groupId }), updatedAt: nowIso() };
      return collection[key];
    });
  }

  async function incrementUserStats(platform, groupId, userId, changes) {
    return mutate(["profiles.json", "rankings.json"], (data) => {
      const profileStore = data["profiles.json"];
      const rankingStore = data["rankings.json"];
      const groupUser = userKey(platform, groupId, userId);
      const globalUser = globalUserKey(platform, userId);
      const group = groupKey(platform, groupId);
      profileStore.groups[groupUser] = { ...addNumericStats(profileStore.groups[groupUser], changes), platform, groupId, userId };
      profileStore.global[globalUser] = { ...addNumericStats(profileStore.global[globalUser], changes), platform, userId };
      rankingStore.groups[group] ||= {};
      rankingStore.groups[group][userId] = clone(profileStore.groups[groupUser]);
      rankingStore.global[platform] ||= {};
      rankingStore.global[platform][userId] = clone(profileStore.global[globalUser]);
      return { group: profileStore.groups[groupUser], global: profileStore.global[globalUser] };
    });
  }

  async function getGroupRanking(platform, groupId, limit = 100) {
    await ensureInitialized();
    const ranking = (await readEnvelope("rankings.json")).data.groups[groupKey(platform, groupId)] || {};
    return Object.entries(ranking).map(([userId, stats]) => ({ userId, ...stats })).sort((a, b) => b.points - a.points || b.correctAnswers - a.correctAnswers || a.userId.localeCompare(b.userId)).slice(0, Math.max(0, limit));
  }

  async function addHistoryEntry(entry) {
    return mutate(["history.json"], ({ "history.json": history }) => {
      const stored = { id: entry.id || crypto.randomUUID(), ...clone(entry), createdAt: entry.createdAt || nowIso() };
      if (!stored.platform || !stored.groupId) throw new Error("Histórico exige platform e groupId.");
      history.entries.push(stored);
      return stored;
    });
  }

  async function listHistory(platform, groupId, options = {}) {
    await ensureInitialized();
    let entries = (await readEnvelope("history.json")).data.entries.filter((entry) => entry.platform === platform && entry.groupId === groupId);
    if (options.type) entries = entries.filter((entry) => entry.type === options.type);
    return clone(entries.slice(-(options.limit || 100)).reverse());
  }

  async function getSchedules(platform, groupId, options = {}) {
    await ensureInitialized();
    let schedules = Object.values((await readEnvelope("schedules.json")).data.schedules).filter((item) => item.platform === platform && item.groupId === groupId);
    if (options.status) schedules = schedules.filter((item) => item.status === options.status);
    return clone(schedules);
  }

  async function saveSchedule(schedule) {
    return mutate(["schedules.json"], ({ "schedules.json": store }) => {
      const scheduleId = schedule.scheduleId || crypto.randomUUID();
      if (!schedule.platform || !schedule.groupId) throw new Error("Agendamento exige platform e groupId.");
      const key = `${groupKey(schedule.platform, schedule.groupId)}:${scheduleId}`;
      if (store.schedules[key]) throw new Error(`Agendamento ${key} já existe.`);
      store.schedules[key] = {
        timezone: "UTC", status: "scheduled", rules: {}, receipts: { notice30m: null, notice10m: null, started: null, ended: null },
        ...clone(schedule), scheduleId, createdAt: schedule.createdAt || nowIso(), updatedAt: nowIso()
      };
      return store.schedules[key];
    });
  }

  async function updateSchedule(platform, groupId, scheduleId, changes) {
    return mutate(["schedules.json"], ({ "schedules.json": store }) => {
      const key = `${groupKey(platform, groupId)}:${scheduleId}`;
      if (!store.schedules[key]) throw new Error(`Agendamento ${key} não encontrado.`);
      store.schedules[key] = { ...store.schedules[key], ...clone(changes), platform, groupId, scheduleId, updatedAt: nowIso() };
      return store.schedules[key];
    });
  }

  async function cancelSchedule(platform, groupId, scheduleId, details = {}) {
    return updateSchedule(platform, groupId, scheduleId, { ...details, status: "cancelled", cancelledAt: details.cancelledAt || nowIso() });
  }

  async function getRecentQuestions(platform, groupId, options = {}) {
    await ensureInitialized();
    let entries = (await readEnvelope("recentQuestions.json")).data.groups[groupKey(platform, groupId)] || [];
    if (!options.includeExpired) entries = entries.filter((entry) => !entry.expiresAt || Date.parse(entry.expiresAt) > Date.now());
    return clone(entries);
  }

  async function getRecentPokemon(platform, groupId, limit = 50) {
    return (await getRecentQuestions(platform, groupId)).slice(-limit).map((entry) => entry.pokemonId).filter(Number.isInteger);
  }

  async function getRecentQuestionModels(platform, groupId, limit = 2) {
    return (await getRecentQuestions(platform, groupId)).slice(-limit).map((entry) => entry.questionType).filter(Boolean);
  }

  async function getRecentCorrectAnswers(platform, groupId, limit = 20) {
    return (await getRecentQuestions(platform, groupId)).slice(-limit).map((entry) => entry.correctAnswer).filter(Boolean);
  }

  async function addRecentQuestion(platform, groupId, question) {
    return mutate(["recentQuestions.json"], ({ "recentQuestions.json": store }) => {
      const key = groupKey(platform, groupId);
      store.groups[key] ||= [];
      const entry = { pokemonId: question.pokemonId, questionType: question.questionType, correctAnswer: question.correctAnswer || null, platform, groupId, usedAt: question.usedAt || nowIso(), expiresAt: question.expiresAt || null };
      store.groups[key].push(entry);
      return entry;
    });
  }

  async function clearExpiredRecentQuestions(referenceTime = nowIso()) {
    return mutate(["recentQuestions.json"], ({ "recentQuestions.json": store }) => {
      let removed = 0;
      const reference = Date.parse(referenceTime);
      for (const key of Object.keys(store.groups)) {
        const before = store.groups[key].length;
        store.groups[key] = store.groups[key].filter((entry) => !entry.expiresAt || Date.parse(entry.expiresAt) > reference);
        removed += before - store.groups[key].length;
      }
      return removed;
    });
  }

  async function resetUserData(platform, userId) {
    return mutate(["profiles.json", "rankings.json", "sessions.json", "history.json"], data => {
      let removed = 0;
      const profiles = data["profiles.json"], rankings = data["rankings.json"], sessions = data["sessions.json"], history = data["history.json"];
      for (const collection of [profiles.groups, profiles.global]) for (const key of Object.keys(collection)) if (collection[key]?.userId === userId || key.endsWith(`:${userId}`)) { delete collection[key]; removed += 1; }
      for (const groups of Object.values(rankings.groups || {})) if (Object.prototype.hasOwnProperty.call(groups, userId)) { delete groups[userId]; removed += 1; }
      if (rankings.global?.[platform] && Object.prototype.hasOwnProperty.call(rankings.global[platform], userId)) { delete rankings.global[platform][userId]; removed += 1; }
      for (const session of Object.values(sessions.sessions || {})) {
        if (session.participants && Object.prototype.hasOwnProperty.call(session.participants, userId)) { delete session.participants[userId]; removed += 1; }
        if (session.attemptsByUser && Object.prototype.hasOwnProperty.call(session.attemptsByUser, userId)) { delete session.attemptsByUser[userId]; removed += 1; }
        if (session.winnerId === userId) session.winnerId = null;
      }
      history.entries = (history.entries || []).filter(entry => entry.userId !== userId && entry.playerId !== userId);
      return { removed: removed > 0, itemsRemoved: removed };
    });
  }

  async function currentHashes() {
    const hashes = {};
    for (const file of ["manifest.json", ...DATA_FILES]) hashes[file] = await fileChecksum(path.join(databaseDir, file));
    return hashes;
  }

  async function validateBackup(directory, expectedHashes) {
    const errors = [];
    for (const [file, expected] of Object.entries(expectedHashes)) {
      const actual = await fileChecksum(path.join(directory, file)).catch(() => null);
      if (actual !== expected) errors.push(`Checksum inválido no backup: ${file}.`);
    }
    return { valid: errors.length === 0, errors, checkedAt: nowIso() };
  }

  async function createBackup() {
    await ensureInitialized();
    const validation = await validateQuizDatabase();
    if (!validation.valid) throw new Error(`Backup recusado: ${validation.errors.join(" ")}`);
    return enqueue(async () => {
      const hashes = await currentHashes();
      await fsp.mkdir(backupRoot, { recursive: true });
      for (const entry of await fsp.readdir(backupRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = path.join(backupRoot, entry.name);
        try {
          const metadata = JSON.parse(await fsp.readFile(path.join(directory, "backup-manifest.json"), "utf8"));
          if (Object.keys(hashes).every((file) => metadata.checksums?.[file]?.value === hashes[file]) && (await validateBackup(directory, hashes)).valid) {
            return { directory, reused: true, validation: await validateBackup(directory, hashes) };
          }
        } catch (_) {
          // Backups incompletos não são reutilizados nem removidos.
        }
      }
      const directory = path.join(backupRoot, nowIso().replace(/[:.]/g, "-"));
      await fsp.mkdir(directory, { recursive: false });
      for (const file of Object.keys(hashes)) await fsp.copyFile(path.join(databaseDir, file), path.join(directory, file), fs.constants.COPYFILE_EXCL);
      const backupValidation = await validateBackup(directory, hashes);
      if (!backupValidation.valid) throw new Error(`Backup inválido: ${backupValidation.errors.join(" ")}`);
      const activeManifest = await readManifest();
      const metadata = {
        schemaVersion: SCHEMA_VERSION, datasetVersion: activeManifest.datasetVersion, createdAt: nowIso(), files: Object.keys(hashes),
        checksums: Object.fromEntries(Object.entries(hashes).map(([file, value]) => [file, { algorithm: "sha256", value }])),
        validation: { status: "valid", ...backupValidation },
        restoration: { possible: true, instruction: "Validar checksums, parar escritores e usar restoreBackup com este diretório." }
      };
      await atomicWrite(path.join(directory, "backup-manifest.json"), `${JSON.stringify(metadata, null, 2)}\n`);
      return { directory, reused: false, validation: backupValidation };
    });
  }

  async function restoreBackup(backupDirectory) {
    await ensureInitialized();
    const directory = path.resolve(backupDirectory);
    const relative = path.relative(backupRoot, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Backup fora do diretório autorizado.");
    return enqueue(async () => {
      const metadata = JSON.parse(await fsp.readFile(path.join(directory, "backup-manifest.json"), "utf8"));
      const hashes = Object.fromEntries(Object.entries(metadata.checksums || {}).map(([file, value]) => [file, typeof value === "string" ? value : value.value]));
      const validation = await validateBackup(directory, hashes);
      if (!validation.valid || !["manifest.json", ...DATA_FILES].every((file) => hashes[file])) throw new Error(`Restauração recusada: ${validation.errors.join(" ") || "backup incompleto"}.`);
      for (const file of ["manifest.json", ...DATA_FILES]) await atomicWrite(path.join(databaseDir, file), await fsp.readFile(path.join(directory, file), "utf8"));
      const restoredValidation = await validateQuizDatabase();
      if (!restoredValidation.valid) throw new Error(`Base restaurada não passou na validação: ${restoredValidation.errors.join(" ")}`);
      return { restored: true, directory, validation: restoredValidation };
    });
  }

  return {
    loadQuizDatabase, validateQuizDatabase, saveQuizDatabase, getGroupSettings, updateGroupSettings,
    getActiveSession, createSession, updateSession, finishSession, deleteSession, getUserProfile,
    updateUserProfile, incrementUserStats, getGroupRanking, addHistoryEntry, listHistory, getSchedules,
    saveSchedule, updateSchedule, cancelSchedule, getRecentQuestions, getRecentPokemon, getRecentQuestionModels, getRecentCorrectAnswers, addRecentQuestion,
    clearExpiredRecentQuestions, resetUserData, createBackup, restoreBackup
  };
}

const repository = createQuizRepository();
module.exports = { ...repository, createQuizRepository };
