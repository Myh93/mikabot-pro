"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { createRegistrationRepository } = require("../src/repositories/registrationRepository");
const { createRegistrationService } = require("../src/services/registrationService");

async function migrateLegacyRegistrations(options = {}) {
  const legacyFile = path.resolve(options.legacyFile || path.join(__dirname, "..", "src", "database", "cadastros.json"));
  const databaseDir = path.resolve(options.databaseDir || path.join(__dirname, "..", "src", "database", "registrations"));
  const backupRoot = path.resolve(options.backupRoot || path.join(__dirname, "..", "src", "database", "backups", "registrations"));
  const repository = createRegistrationRepository({ databaseDir, backupRoot });
  const service = createRegistrationService({ repository });
  const raw = await fsp.readFile(legacyFile, "utf8");
  const legacy = JSON.parse(raw);
  if (!legacy || Array.isArray(legacy) || typeof legacy !== "object") throw new Error("Cadastro legado inválido.");

  const backup = await repository.createBackup({ sourceFile: legacyFile });
  if (!backup.validation.valid) throw new Error("Migração recusada: backup inválido.");

  let created = 0, updated = 0;
  const records = [];
  for (const [legacyIdentity, item] of Object.entries(legacy)) {
    const existing = await service.findByIdentity(legacyIdentity);
    const legacyCodeField = Object.prototype.hasOwnProperty.call(item, "codigo") ? "codigo" : "cod";
    const migrationInput = {
      primaryIdentity: legacyIdentity,
      identityAliases: [legacyIdentity],
      nome: item.nome ?? item.name,
      nick: item.nick,
      friendCode: item.codigo ?? item.cod,
      cidade: item.cidade ?? item.city,
      metadata: { legacyFields: { identityKey: legacyIdentity, [legacyCodeField]: item[legacyCodeField] } }
    };
    const legacyFields = migrationInput.metadata.legacyFields;
    const alreadyMigrated = existing?.source === "legacy_migration" && JSON.stringify(existing.metadata?.legacyFields) === JSON.stringify(legacyFields);
    const migrated = alreadyMigrated ? existing : await service.upsertLegacyRegistration(migrationInput);
    if (!existing) created += 1; else if (!alreadyMigrated) updated += 1;
    records.push({ registrationId: migrated.registrationId, status: migrated.status, validationStatus: migrated.validationStatus });
  }
  const total = (await repository.listRegistrations()).length;
  const unchanged = created === 0 && records.every(record => record.registrationId);
  return { status: unchanged ? "unchanged" : "migrated", created, updated, total, backup, records };
}

if (require.main === module) migrateLegacyRegistrations().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { migrateLegacyRegistrations };
