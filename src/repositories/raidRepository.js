const fs = require("fs");
const path = require("path");

const DEFAULT_DATABASE_FILE = path.join(__dirname, "..", "database", "raids.json");
const SCHEMA_VERSION = 3;
const FIRST_RAID_NUMBER = 1024;
const ACTIVE_STATUSES = new Set(["active", "published"]);

function createEmptyDatabase() {
  return {
    version: SCHEMA_VERSION,
    nextId: FIRST_RAID_NUMBER,
    raids: {},
    messageIndex: {}
  };
}

function normalizeRaidId(id) {
  return String(id || "").trim().toUpperCase();
}

function createBackup(databaseFile, rawData, sourceVersion = 1) {
  const directory = path.dirname(databaseFile);
  const extension = path.extname(databaseFile);
  const baseName = path.basename(databaseFile, extension);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  let backupFile = path.join(directory, `${baseName}.backup-v${sourceVersion}-${timestamp}${extension}`);
  let suffix = 1;

  while (fs.existsSync(backupFile)) {
    backupFile = path.join(directory, `${baseName}.backup-v1-${timestamp}-${suffix}${extension}`);
    suffix++;
  }

  fs.writeFileSync(backupFile, rawData, "utf8");
  return backupFile;
}

function migrateLegacyDatabase(legacyData) {
  const database = createEmptyDatabase();

  Object.entries(legacyData).forEach(([name, participants]) => {
    const id = `R${database.nextId}`;
    database.nextId++;
    database.raids[id] = {
      id,
      name,
      groupId: null,
      creatorId: null,
      messageId: null,
      participants: Array.isArray(participants) ? [...new Set(participants)] : [],
      status: "active",
      createdAt: null,
      updatedAt: null,
      migrated: true
    };
  });

  return database;
}

function migrateVersion2Database(source) {
  const database = {
    version: SCHEMA_VERSION,
    nextId: source.nextId,
    raids: {},
    messageIndex: { ...(source.messageIndex || {}) }
  };
  for (const [id, current] of Object.entries(source.raids || {})) {
    const publications = current.messageId && current.groupId
      ? [{ groupId: current.groupId, messageId: current.messageId, publishedAt: current.publishedAt || current.updatedAt || current.createdAt }]
      : [];
    database.raids[id] = {
      ...current,
      primaryGroupId: current.primaryGroupId || current.groupId || null,
      publishedGroupIds: [...new Set(publications.map(item => item.groupId))],
      publications
    };
  }
  return database;
}

function raidBelongsToGroup(raid, groupId) {
  if (!groupId) return true;
  if (raid.status === "published" && Array.isArray(raid.publications) && raid.publications.length) {
    return raid.publications.some(item => item.groupId === groupId);
  }
  return raid.groupId === groupId ||
    raid.primaryGroupId === groupId ||
    (Array.isArray(raid.publishedGroupIds) && raid.publishedGroupIds.includes(groupId)) ||
    (Array.isArray(raid.publications) && raid.publications.some(item => item.groupId === groupId));
}

function validateDatabase(database) {
  if (!database || typeof database !== "object" || Array.isArray(database)) {
    throw new TypeError("Banco de raids inválido.");
  }
  if (database.version !== SCHEMA_VERSION) {
    throw new Error(`Versão de banco de raids não suportada: ${database.version}`);
  }
  if (!Number.isInteger(database.nextId) || database.nextId < FIRST_RAID_NUMBER) {
    throw new Error("nextId inválido no banco de raids.");
  }
  if (!database.raids || typeof database.raids !== "object" || Array.isArray(database.raids)) {
    throw new TypeError("Coleção de raids inválida.");
  }
  if (!database.messageIndex || typeof database.messageIndex !== "object" || Array.isArray(database.messageIndex)) {
    throw new TypeError("Índice de mensagens inválido.");
  }
}

function createRepository(databaseFile = DEFAULT_DATABASE_FILE) {
  function saveDatabase(database) {
    validateDatabase(database);
    const serialized = `${JSON.stringify(database, null, 2)}\n`;
    const directory = path.dirname(databaseFile);
    const temporaryFile = path.join(
      directory,
      `.${path.basename(databaseFile)}.${process.pid}.${Date.now()}.tmp`
    );
    let descriptor;

    fs.mkdirSync(directory, { recursive: true });

    try {
      descriptor = fs.openSync(temporaryFile, "wx");
      fs.writeFileSync(descriptor, serialized, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryFile, databaseFile);
    } catch (err) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
      throw err;
    }

    return database;
  }

  function loadDatabase() {
    if (!fs.existsSync(databaseFile)) {
      return saveDatabase(createEmptyDatabase());
    }

    const rawData = fs.readFileSync(databaseFile, "utf8");
    const parsedData = JSON.parse(rawData);

    if (parsedData.version === SCHEMA_VERSION) {
      validateDatabase(parsedData);
      return parsedData;
    }

    createBackup(databaseFile, rawData, parsedData.version || 1);
    if (parsedData.version === 2) return saveDatabase(migrateVersion2Database(parsedData));
    return saveDatabase(migrateVersion2Database(migrateLegacyDatabase(parsedData)));
  }

  function createRaid(data = {}) {
    const database = loadDatabase();
    const id = `R${database.nextId}`;
    const now = new Date().toISOString();
    database.nextId++;

    const raid = {
      id,
      name: String(data.name || "").trim().toLowerCase(),
      groupId: data.groupId || null,
      primaryGroupId: data.primaryGroupId || data.groupId || null,
      publishedGroupIds: [],
      publications: [],
      creatorId: data.creatorId || null,
      targetGroupIds: [...new Set(Array.isArray(data.targetGroupIds) ? data.targetGroupIds.filter(Boolean) : [data.groupId].filter(Boolean))],
      messageId: data.messageId || null,
      participants: [...new Set(Array.isArray(data.participants) ? data.participants : [])],
      status: data.status || "draft",
      createdAt: data.createdAt || now,
      updatedAt: now
    };
    if (typeof data.coordinates === "string" && data.coordinates.trim()) raid.coordinates = data.coordinates.trim();
    if (typeof data.startTime === "string" && data.startTime.trim()) raid.startTime = data.startTime.trim();
    if (Number.isInteger(data.remainingMinutes) && data.remainingMinutes > 0) raid.remainingMinutes = data.remainingMinutes;
    if (data.startsAt) raid.startsAt = data.startsAt;
    if (data.expiresAt) raid.expiresAt = data.expiresAt;
    if (Number.isInteger(data.pokemonId)) raid.pokemonId = data.pokemonId;
    if (data.nomeOficial) raid.nomeOficial = String(data.nomeOficial);
    if (Array.isArray(data.pokemonTypes) && data.pokemonTypes.length) raid.pokemonTypes = [...data.pokemonTypes];
    raid.lifecycleNotifications = Array.isArray(data.lifecycleNotifications)
      ? [...new Set(data.lifecycleNotifications)]
      : [];

    database.raids[id] = raid;
    if (raid.messageId) database.messageIndex[raid.messageId] = id;
    saveDatabase(database);
    return raid;
  }

  function getRaidById(id) {
    const normalizedId = normalizeRaidId(id);
    return loadDatabase().raids[normalizedId] || null;
  }

  function listActiveRaids(groupId) {
    const now = Date.now();
    return Object.values(loadDatabase().raids).filter(raid => {
      if (!ACTIVE_STATUSES.has(raid.status)) return false;
      if (raid.migrated === true && (!raid.createdAt || !raid.groupId || !raid.messageId)) return false;
      if (!raid.createdAt || !raid.groupId) return false;
      if (raid.status === "published" && !raid.messageId) return false;
      if (raid.expiresAt && Date.parse(raid.expiresAt) <= now) return false;
      return raidBelongsToGroup(raid, groupId);
    });
  }

  function listArchivedRaids(groupId) {
    return Object.values(loadDatabase().raids).filter(raid =>
      ["completed", "archived"].includes(raid.status) &&
      (!groupId || raidBelongsToGroup(raid, groupId))
    );
  }

  function listLifecycleRaids() {
    return Object.values(loadDatabase().raids).filter(raid =>
      ["active", "published", "completed"].includes(raid.status)
    );
  }

  function updateRaid(id, changes = {}) {
    const normalizedId = normalizeRaidId(id);
    const database = loadDatabase();
    const currentRaid = database.raids[normalizedId];
    if (!currentRaid) return null;

    if (currentRaid.messageId) delete database.messageIndex[currentRaid.messageId];

    const updatedRaid = {
      ...currentRaid,
      ...changes,
      id: normalizedId,
      participants: changes.participants
        ? [...new Set(changes.participants)]
        : currentRaid.participants,
      updatedAt: new Date().toISOString()
    };

    database.raids[normalizedId] = updatedRaid;
    if (updatedRaid.messageId) database.messageIndex[updatedRaid.messageId] = normalizedId;
    saveDatabase(database);
    return updatedRaid;
  }

  function linkMessage(id, messageId, groupId) {
    const normalizedId = normalizeRaidId(id);
    const normalizedMessageId = String(messageId || "").trim();
    if (!normalizedMessageId) throw new Error("ID da mensagem publicada é obrigatório.");

    const database = loadDatabase();
    const currentRaid = database.raids[normalizedId];
    if (!currentRaid) return null;

    const linkedRaidId = database.messageIndex[normalizedMessageId];
    if (linkedRaidId && linkedRaidId !== normalizedId) {
      throw new Error(`Mensagem já vinculada à raid ${linkedRaidId}.`);
    }

    const targetGroupId = groupId || currentRaid.primaryGroupId || currentRaid.groupId || null;
    const existing = (currentRaid.publications || []).find(item => item.groupId === targetGroupId);
    if (existing?.messageId) delete database.messageIndex[existing.messageId];
    if (existing) existing.messageId = normalizedMessageId;
    else currentRaid.publications = [...(currentRaid.publications || []), { groupId: targetGroupId, messageId: normalizedMessageId, publishedAt: new Date().toISOString() }];
    currentRaid.primaryGroupId = currentRaid.primaryGroupId || targetGroupId;
    currentRaid.groupId = currentRaid.groupId || targetGroupId;
    currentRaid.messageId = currentRaid.messageId || normalizedMessageId;
    currentRaid.publishedGroupIds = [...new Set((currentRaid.publications || []).map(item => item.groupId))];
    currentRaid.updatedAt = new Date().toISOString();
    database.messageIndex[normalizedMessageId] = normalizedId;
    saveDatabase(database);
    return currentRaid;
  }

  function publishRaid(id, publication = {}) {
    const normalizedId = normalizeRaidId(id);
    const groupId = String(publication.groupId || "").trim();
    const messageId = String(publication.messageId || "").trim();
    if (!groupId) throw new Error("ID do grupo é obrigatório para publicar a raid.");
    if (!messageId) throw new Error("ID da mensagem é obrigatório para publicar a raid.");

    const database = loadDatabase();
    const currentRaid = database.raids[normalizedId];
    if (!currentRaid) return null;

    if (currentRaid.status === "cancelled") {
      const error = new Error("Não é possível publicar uma raid cancelada.");
      error.code = "RAID_CANCELLED";
      throw error;
    }
    if ((currentRaid.publications || []).some(item => item.groupId === groupId)) {
      const error = new Error(
        currentRaid.groupId === groupId
          ? "Esta raid já foi publicada neste grupo."
          : "Esta raid já foi publicada em outro grupo."
      );
      error.code = "RAID_ALREADY_PUBLISHED";
      throw error;
    }

    const linkedRaidId = database.messageIndex[messageId];
    if (linkedRaidId && linkedRaidId !== normalizedId) {
      throw new Error(`Mensagem já vinculada à raid ${linkedRaidId}.`);
    }

    const publishedAt = publication.publishedAt || new Date().toISOString();
    currentRaid.primaryGroupId = currentRaid.primaryGroupId || currentRaid.groupId || groupId;
    currentRaid.groupId = currentRaid.groupId || groupId;
    currentRaid.messageId = currentRaid.messageId || messageId;
    currentRaid.publications = [...(currentRaid.publications || []), { groupId, messageId, publishedAt }];
    currentRaid.publishedGroupIds = [...new Set(currentRaid.publications.map(item => item.groupId))];
    currentRaid.status = "published";
    currentRaid.publishedAt = currentRaid.publishedAt || publishedAt;
    currentRaid.updatedAt = new Date().toISOString();
    database.messageIndex[messageId] = normalizedId;
    saveDatabase(database);
    return currentRaid;
  }

  function getPublishedRaidByGroup(groupId) {
    return Object.values(loadDatabase().raids).filter(raid =>
      raid.status === "published" && raidBelongsToGroup(raid, groupId)
    );
  }

  function validateParticipationRaid(database, id, groupId) {
    const normalizedId = normalizeRaidId(id);
    const raid = database.raids[normalizedId];
    if (!raid) return null;

    if (raid.status !== "published") {
      const error = new Error("A raid não está publicada e ativa.");
      error.code = "RAID_NOT_PUBLISHED";
      throw error;
    }
    if (!groupId || !raidBelongsToGroup(raid, groupId)) {
      const error = new Error("A raid não pertence a este grupo.");
      error.code = "RAID_GROUP_MISMATCH";
      throw error;
    }

    return raid;
  }

  function addParticipant(id, participantId, groupId) {
    const normalizedParticipantId = String(participantId || "").trim();
    if (!normalizedParticipantId) throw new Error("Identificador do participante é obrigatório.");

    const database = loadDatabase();
    const raid = validateParticipationRaid(database, id, groupId);
    if (!raid) return null;

    if (raid.participants.includes(normalizedParticipantId)) {
      return { raid, added: false };
    }

    raid.participants.push(normalizedParticipantId);
    raid.updatedAt = new Date().toISOString();
    saveDatabase(database);
    return { raid, added: true };
  }

  function removeParticipant(id, participantId, groupId) {
    const normalizedParticipantId = String(participantId || "").trim();
    if (!normalizedParticipantId) throw new Error("Identificador do participante é obrigatório.");

    const database = loadDatabase();
    const raid = validateParticipationRaid(database, id, groupId);
    if (!raid) return null;

    const participantIndex = raid.participants.indexOf(normalizedParticipantId);
    if (participantIndex === -1) {
      return { raid, removed: false };
    }

    raid.participants.splice(participantIndex, 1);
    raid.updatedAt = new Date().toISOString();
    saveDatabase(database);
    return { raid, removed: true };
  }

  function cancelRaid(id) {
    return updateRaid(id, { status: "cancelled" });
  }

  function findRaidByMessageId(messageId) {
    if (!messageId) return null;
    const database = loadDatabase();
    const raidId = database.messageIndex[messageId];
    return raidId ? database.raids[raidId] || null : null;
  }

  function removeParticipantFromOperationalRaids(participantId) {
    const database = loadDatabase();
    let removed = 0;
    for (const raid of Object.values(database.raids)) {
      if (!ACTIVE_STATUSES.has(raid.status) || !Array.isArray(raid.participants)) continue;
      const before = raid.participants.length;
      raid.participants = raid.participants.filter(value => value !== participantId);
      if (raid.participants.length !== before) { removed += before - raid.participants.length; raid.updatedAt = new Date().toISOString(); }
    }
    if (removed) saveDatabase(database);
    return { removed: removed > 0, itemsRemoved: removed };
  }

  return {
    databaseFile,
    loadDatabase,
    saveDatabase,
    createRaid,
    getRaidById,
    listActiveRaids,
    listArchivedRaids,
    listLifecycleRaids,
    updateRaid,
    linkMessage,
    publishRaid,
    getPublishedRaidByGroup,
    addParticipant,
    removeParticipant,
    cancelRaid,
    findRaidByMessageId,
    removeParticipantFromOperationalRaids
  };
}

const defaultRepository = createRepository();

module.exports = {
  ...defaultRepository,
  createRepository
};
