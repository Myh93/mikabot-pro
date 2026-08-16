"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const configurationCatalog = require("../config/schema");

const SCHEMA_VERSION = 1;
const DATA_FILES = Object.freeze([
  "global.json",
  "communities.json",
  "platforms.json",
  "groups.json",
  "history.json"
]);
const DEFAULT_DATABASE_DIR = path.join(__dirname, "..", "database", "configuration");
const DEFAULT_BACKUP_ROOT = path.join(
  __dirname,
  "..",
  "database",
  "backups",
  "configuration"
);
const writerQueues = new Map();

const INITIAL_DATA = Object.freeze({
  "global.json": { values: {} },
  "communities.json": { communities: {} },
  "platforms.json": { platforms: {} },
  "groups.json": { groups: {} },
  "history.json": { entries: [] }
});

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function checksum(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function deriveCatalogRevision(catalog = configurationCatalog) {
  return checksum(JSON.stringify(catalog.listDefinitions()));
}

function repositoryError(code, message) {
  const error = new Error(message);
  error.name = "ConfigurationRepositoryError";
  error.code = code;
  return error;
}

function createConfigurationRepository(options = {}) {
  const databaseDir = path.resolve(options.databaseDir || DEFAULT_DATABASE_DIR);
  const backupRoot = path.resolve(options.backupRoot || DEFAULT_BACKUP_ROOT);
  const catalogRevision = options.catalogRevision || deriveCatalogRevision(options.catalog);
  const schemaVersion = options.schemaVersion || SCHEMA_VERSION;
  const clock = options.clock || (() => new Date());
  const beforeRename = options.beforeRename;
  const manifestPath = path.join(databaseDir, "manifest.json");
  let initialized = false;

  const now = () => clock().toISOString();
  const filePath = (file) => path.join(databaseDir, file);
  const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

  function enqueue(operation) {
    const previous = writerQueues.get(databaseDir) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    writerQueues.set(databaseDir, current);
    return current.finally(() => {
      if (writerQueues.get(databaseDir) === current) writerQueues.delete(databaseDir);
    });
  }

  async function atomicWrite(target, content) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      if (beforeRename) await beforeRename({ target, temporary });
      await fsp.rename(temporary, target);
      let directoryHandle;
      try {
        directoryHandle = await fsp.open(path.dirname(target), "r");
        await directoryHandle.sync();
      } catch (_) {
        // Windows pode não permitir fsync de diretório; o arquivo já foi sincronizado.
      } finally {
        if (directoryHandle) await directoryHandle.close().catch(() => undefined);
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  function envelope(file, data, updatedAt = now()) {
    return {
      schemaVersion,
      catalogRevision,
      updatedAt,
      data: clone(data || INITIAL_DATA[file])
    };
  }

  function validateEnvelope(file, document) {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw repositoryError("CONFIGURATION_FILE_CORRUPT", `Arquivo inválido: ${file}.`);
    }
    if (document.schemaVersion !== schemaVersion) {
      throw repositoryError("SCHEMA_VERSION_INCOMPATIBLE", `Schema incompatível: ${file}.`);
    }
    if (document.catalogRevision !== catalogRevision) {
      throw repositoryError("CATALOG_REVISION_INCOMPATIBLE", `Catálogo incompatível: ${file}.`);
    }
    if (!document.data || typeof document.data !== "object" || Array.isArray(document.data)) {
      throw repositoryError("CONFIGURATION_FILE_CORRUPT", `Dados inválidos: ${file}.`);
    }
    const required = Object.keys(INITIAL_DATA[file])[0];
    const value = document.data[required];
    if ((required === "entries" && !Array.isArray(value)) ||
        (required !== "entries" && (!value || typeof value !== "object" || Array.isArray(value)))) {
      throw repositoryError("CONFIGURATION_FILE_CORRUPT", `Estrutura inválida: ${file}.`);
    }
    return document;
  }

  function validateManifestShape(manifest) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw repositoryError("MANIFEST_CORRUPT", "Manifesto de configuração inválido.");
    }
    if (manifest.schemaVersion !== schemaVersion) {
      throw repositoryError("SCHEMA_VERSION_INCOMPATIBLE", "schemaVersion incompatível.");
    }
    if (manifest.catalogRevision !== catalogRevision) {
      throw repositoryError("CATALOG_REVISION_INCOMPATIBLE", "catalogRevision incompatível.");
    }
    if (!Array.isArray(manifest.files) ||
        DATA_FILES.some((file) => !manifest.files.includes(file)) ||
        !manifest.checksums || typeof manifest.checksums !== "object") {
      throw repositoryError("MANIFEST_CORRUPT", "Manifesto de configuração incompleto.");
    }
    for (const file of DATA_FILES) {
      const entry = manifest.checksums[file];
      if (!entry || entry.algorithm !== "sha256" || typeof entry.value !== "string") {
        throw repositoryError("MANIFEST_CORRUPT", "Checksums do manifesto inválidos.");
      }
    }
    return manifest;
  }

  async function parseJson(target, code) {
    try {
      return JSON.parse(await fsp.readFile(target, "utf8"));
    } catch (_) {
      throw repositoryError(code, "Arquivo de configuração ausente ou corrompido.");
    }
  }

  async function buildManifest(createdAt) {
    const checksums = {};
    for (const file of DATA_FILES) {
      checksums[file] = {
        algorithm: "sha256",
        value: checksum(await fsp.readFile(filePath(file)))
      };
    }
    const timestamp = now();
    return {
      schemaVersion,
      catalogRevision,
      createdAt: createdAt || timestamp,
      updatedAt: timestamp,
      files: [...DATA_FILES],
      checksums,
      status: "valid"
    };
  }

  async function loadManifest() {
    return clone(validateManifestShape(
      await parseJson(manifestPath, "MANIFEST_CORRUPT")
    ));
  }

  async function saveManifest(manifest) {
    const validated = validateManifestShape(clone(manifest));
    await enqueue(() => atomicWrite(manifestPath, serialize(validated)));
    return clone(validated);
  }

  async function validateIntegrity() {
    const manifest = await loadManifest();
    for (const file of DATA_FILES) {
      const content = await fsp.readFile(filePath(file)).catch(() => null);
      if (!content) {
        throw repositoryError("CONFIGURATION_FILE_CORRUPT", `Arquivo ausente: ${file}.`);
      }
      if (checksum(content) !== manifest.checksums[file].value) {
        throw repositoryError("CHECKSUM_MISMATCH", `Checksum inválido: ${file}.`);
      }
      validateEnvelope(
        file,
        await parseJson(filePath(file), "CONFIGURATION_FILE_CORRUPT")
      );
    }
    return { valid: true, manifest };
  }

  async function initialize() {
    if (initialized) {
      return loadManifest();
    }
    await enqueue(async () => {
      if (initialized) return;
      await fsp.mkdir(databaseDir, { recursive: true });
      const manifestExists = fs.existsSync(manifestPath);
      const existing = DATA_FILES.filter((file) => fs.existsSync(filePath(file)));
      if (manifestExists || existing.length) {
        if (!manifestExists || existing.length !== DATA_FILES.length) {
          throw repositoryError(
            "PARTIAL_DATABASE",
            "Base de configuração parcialmente inicializada."
          );
        }
        await validateIntegrity();
      } else {
        for (const file of DATA_FILES) {
          await atomicWrite(filePath(file), serialize(envelope(file, INITIAL_DATA[file])));
        }
        await atomicWrite(manifestPath, serialize(await buildManifest()));
      }
      initialized = true;
    });
    return loadManifest();
  }

  async function readDocument(file) {
    await initialize();
    const manifest = await loadManifest();
    const content = await fsp.readFile(filePath(file)).catch(() => null);
    if (!content || checksum(content) !== manifest.checksums[file].value) {
      throw repositoryError("CHECKSUM_MISMATCH", `Checksum inválido: ${file}.`);
    }
    return clone(validateEnvelope(file, JSON.parse(content.toString("utf8"))).data);
  }

  async function writeDocument(file, data) {
    await initialize();
    return enqueue(async () => {
      validateEnvelope(file, envelope(file, data));
      const currentManifest = await loadManifest();
      await atomicWrite(filePath(file), serialize(envelope(file, data)));
      const manifest = await buildManifest(currentManifest.createdAt);
      await atomicWrite(manifestPath, serialize(manifest));
      return clone(data);
    });
  }

  const readGlobal = () => readDocument("global.json");
  const writeGlobal = (data) => writeDocument("global.json", data);
  const readCommunities = () => readDocument("communities.json");
  const writeCommunities = (data) => writeDocument("communities.json", data);
  const readPlatforms = () => readDocument("platforms.json");
  const writePlatforms = (data) => writeDocument("platforms.json", data);
  const readGroups = () => readDocument("groups.json");
  const writeGroups = (data) => writeDocument("groups.json", data);

  async function appendHistory(entry) {
    await initialize();
    return enqueue(async () => {
      const document = await readDocument("history.json");
      const item = { ...clone(entry), recordedAt: entry?.recordedAt || now() };
      document.entries.push(item);
      const currentManifest = await loadManifest();
      await atomicWrite(
        filePath("history.json"),
        serialize(envelope("history.json", document))
      );
      await atomicWrite(
        manifestPath,
        serialize(await buildManifest(currentManifest.createdAt))
      );
      return clone(item);
    });
  }

  async function createBackup() {
    await initialize();
    await validateIntegrity();
    return enqueue(async () => {
      const stamp = now().replace(/[:.]/g, "-");
      const finalDirectory = path.join(backupRoot, stamp);
      const temporary = `${finalDirectory}.${crypto.randomUUID()}.tmp`;
      try {
        await fsp.mkdir(temporary, { recursive: true });
        for (const file of ["manifest.json", ...DATA_FILES]) {
          await fsp.copyFile(path.join(databaseDir, file), path.join(temporary, file));
        }
        await atomicWrite(
          path.join(temporary, "backup.json"),
          serialize({
            schemaVersion,
            catalogRevision,
            createdAt: now(),
            source: databaseDir,
            validation: { valid: true },
            restoreInstruction: "Use restoreBackup com este diretório validado."
          })
        );
        await fsp.mkdir(backupRoot, { recursive: true });
        await fsp.rename(temporary, finalDirectory);
        return finalDirectory;
      } catch (error) {
        await fsp.rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async function validateBackup(backupDirectory) {
    const backupManifest = validateManifestShape(
      await parseJson(path.join(backupDirectory, "manifest.json"), "BACKUP_CORRUPT")
    );
    for (const file of DATA_FILES) {
      const content = await fsp.readFile(path.join(backupDirectory, file)).catch(() => null);
      if (!content || checksum(content) !== backupManifest.checksums[file].value) {
        throw repositoryError("BACKUP_CORRUPT", "Backup de configuração inválido.");
      }
      validateEnvelope(file, JSON.parse(content.toString("utf8")));
    }
    return backupManifest;
  }

  async function restoreBackup(backupDirectory) {
    const source = path.resolve(backupDirectory);
    const backupManifest = await validateBackup(source);
    await initialize();
    return enqueue(async () => {
      const recoveryDirectory = path.join(
        backupRoot,
        `.recovery-${process.pid}-${crypto.randomUUID()}`
      );
      await fsp.mkdir(recoveryDirectory, { recursive: true });
      try {
        for (const file of ["manifest.json", ...DATA_FILES]) {
          await fsp.copyFile(path.join(databaseDir, file), path.join(recoveryDirectory, file));
        }
        for (const file of DATA_FILES) {
          await atomicWrite(
            filePath(file),
            await fsp.readFile(path.join(source, file), "utf8")
          );
        }
        await atomicWrite(manifestPath, serialize(backupManifest));
        await validateIntegrity();
      } catch (error) {
        for (const file of DATA_FILES) {
          const recovery = path.join(recoveryDirectory, file);
          if (fs.existsSync(recovery)) {
            await atomicWrite(filePath(file), await fsp.readFile(recovery, "utf8"));
          }
        }
        const recoveryManifest = path.join(recoveryDirectory, "manifest.json");
        if (fs.existsSync(recoveryManifest)) {
          await atomicWrite(manifestPath, await fsp.readFile(recoveryManifest, "utf8"));
        }
        throw error;
      } finally {
        await fsp.rm(recoveryDirectory, { recursive: true, force: true });
      }
      return loadManifest();
    });
  }

  return Object.freeze({
    initialize,
    loadManifest,
    saveManifest,
    readGlobal,
    writeGlobal,
    readCommunities,
    writeCommunities,
    readPlatforms,
    writePlatforms,
    readGroups,
    writeGroups,
    appendHistory,
    createBackup,
    restoreBackup
  });
}

module.exports = {
  createConfigurationRepository,
  SCHEMA_VERSION,
  DATA_FILES,
  deriveCatalogRevision
};
