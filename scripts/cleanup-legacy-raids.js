"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DATABASE_FILE = path.join(ROOT, "src", "database", "raids.json");
const DEFAULT_BACKUP_ROOT = path.join(ROOT, "src", "database", "backups", "raids");
const ARCHIVE_REASON = "legacy_migration_without_schedule";

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function validateDatabase(database) {
  const errors = [];
  if (!database || typeof database !== "object" || Array.isArray(database)) errors.push("Raiz inválida.");
  if (![2, 3].includes(database?.version)) errors.push("Versão de banco não suportada.");
  if (!Number.isInteger(database?.nextId)) errors.push("nextId inválido.");
  if (!database?.raids || typeof database.raids !== "object" || Array.isArray(database.raids)) errors.push("Coleção de raids inválida.");
  if (!database?.messageIndex || typeof database.messageIndex !== "object" || Array.isArray(database.messageIndex)) errors.push("messageIndex inválido.");
  return { valid: errors.length === 0, errors, raidCount: database?.raids ? Object.keys(database.raids).length : 0 };
}

function isLegacyCandidate(raid) {
  if (!raid || raid.migrated !== true || raid.status !== "active") return false;
  return raid.createdAt == null || raid.groupId == null || raid.messageId == null || !raid.expiresAt;
}

function validateBackup(directory, expectedChecksum) {
  const databasePath = path.join(directory, "raids.json");
  if (!fs.existsSync(databasePath)) return { valid: false, errors: ["raids.json ausente no backup."] };
  const raw = fs.readFileSync(databasePath);
  const actualChecksum = sha256(raw);
  let parsed;
  try { parsed = JSON.parse(raw.toString("utf8")); } catch (error) { return { valid: false, errors: [`JSON inválido: ${error.message}`] }; }
  const databaseValidation = validateDatabase(parsed);
  const errors = [...databaseValidation.errors];
  if (actualChecksum !== expectedChecksum) errors.push("Checksum do backup não confere.");
  return { valid: errors.length === 0, errors, checksum: actualChecksum, databaseValidation, checkedAt: new Date().toISOString() };
}

function findIdenticalBackup(backupRoot, checksum) {
  if (!fs.existsSync(backupRoot)) return null;
  for (const entry of fs.readdirSync(backupRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(backupRoot, entry.name);
    const manifestPath = path.join(directory, "backup-manifest.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.checksum?.value === checksum && validateBackup(directory, checksum).valid) return directory;
    } catch (_) {
      // Backup incompleto não é reutilizado nem removido.
    }
  }
  return null;
}

function writeFileValidated(filePath, content, exclusive = false) {
  const descriptor = fs.openSync(filePath, exclusive ? "wx" : "w", 0o600);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function createOrReuseBackup(databaseFile, backupRoot, rawData, database) {
  const checksum = sha256(rawData);
  const identical = findIdenticalBackup(backupRoot, checksum);
  if (identical) return { directory: identical, reused: true, checksum, validation: validateBackup(identical, checksum) };

  fs.mkdirSync(backupRoot, { recursive: true });
  const directory = path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(directory, { recursive: false });
  try {
    writeFileValidated(path.join(directory, "raids.json"), rawData, true);
    const validation = validateBackup(directory, checksum);
    if (!validation.valid) throw new Error(validation.errors.join(" "));
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      source: path.relative(ROOT, databaseFile).replace(/\\/g, "/"),
      databaseVersion: database.version,
      raidCount: Object.keys(database.raids).length,
      checksum: { algorithm: "sha256", value: checksum },
      validation: { status: "valid", ...validation },
      restoration: { possible: true, instruction: "Parar escritores, validar o checksum e substituir raids.json por este arquivo." }
    };
    writeFileValidated(path.join(directory, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, true);
    return { directory, reused: false, checksum, validation };
  } catch (error) {
    throw new Error(`Backup de raids não pôde ser criado e validado; limpeza interrompida: ${error.message}`);
  }
}

function atomicSave(databaseFile, database) {
  const serialized = `${JSON.stringify(database, null, 2)}\n`;
  const temporary = path.join(path.dirname(databaseFile), `.${path.basename(databaseFile)}.${process.pid}.${Date.now()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    JSON.parse(fs.readFileSync(temporary, "utf8"));
    fs.renameSync(temporary, databaseFile);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}

function cleanupLegacyRaids(options = {}) {
  const databaseFile = path.resolve(options.databaseFile || DEFAULT_DATABASE_FILE);
  const backupRoot = path.resolve(options.backupRoot || DEFAULT_BACKUP_ROOT);
  const now = options.now || new Date().toISOString();
  const rawData = fs.readFileSync(databaseFile);
  const database = JSON.parse(rawData.toString("utf8"));
  const validation = validateDatabase(database);
  if (!validation.valid) throw new Error(`Banco de raids inválido; limpeza interrompida: ${validation.errors.join(" ")}`);

  const candidates = Object.values(database.raids).filter(isLegacyCandidate);
  if (!candidates.length) return { status: "unchanged", archivedIds: [], backup: null, beforeChecksum: sha256(rawData), afterChecksum: sha256(rawData) };

  const beforeSnapshot = JSON.parse(JSON.stringify(database));
  const backup = createOrReuseBackup(databaseFile, backupRoot, rawData, database);
  if (!backup.validation.valid) throw new Error("Backup não passou na validação; limpeza interrompida.");

  for (const raid of candidates) {
    raid.status = "archived";
    raid.archivedAt = now;
    raid.archiveReason = ARCHIVE_REASON;
  }

  const afterValidation = validateDatabase(database);
  if (!afterValidation.valid || afterValidation.raidCount !== validation.raidCount) throw new Error("Validação posterior falhou; nenhum arquivo foi substituído.");
  for (const [id, previous] of Object.entries(beforeSnapshot.raids)) {
    const current = database.raids[id];
    if (!current) throw new Error(`Raid ${id} seria perdida; limpeza interrompida.`);
    if (JSON.stringify(previous.participants) !== JSON.stringify(current.participants)) throw new Error(`Participantes de ${id} seriam alterados; limpeza interrompida.`);
  }

  atomicSave(databaseFile, database);
  const persisted = JSON.parse(fs.readFileSync(databaseFile, "utf8"));
  if (!validateDatabase(persisted).valid) throw new Error("Arquivo persistido não passou na validação.");
  return {
    status: "archived",
    archivedIds: candidates.map((raid) => raid.id),
    backup,
    beforeChecksum: sha256(rawData),
    afterChecksum: sha256(fs.readFileSync(databaseFile))
  };
}

if (require.main === module) {
  try {
    const result = cleanupLegacyRaids();
    console.log(`Status: ${result.status}. Raids arquivadas: ${result.archivedIds.join(", ") || "nenhuma"}.`);
    if (result.backup) console.log(`Backup ${result.backup.reused ? "reutilizado" : "criado"}: ${path.relative(ROOT, result.backup.directory)}`);
    console.log(`Checksum: ${result.beforeChecksum} -> ${result.afterChecksum}`);
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
}

module.exports = { ARCHIVE_REASON, cleanupLegacyRaids, createOrReuseBackup, findIdenticalBackup, isLegacyCandidate, validateBackup, validateDatabase };
