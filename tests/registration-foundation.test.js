"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createRegistrationRepository } = require("../src/repositories/registrationRepository");
const { createRegistrationService } = require("../src/services/registrationService");
const { migrateLegacyRegistrations } = require("../scripts/migrate-legacy-registrations");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-reg-"));
  const legacyFile = path.join(root, "cadastros.json"), databaseDir = path.join(root, "registrations"), backupRoot = path.join(root, "backups");
  await fsp.writeFile(legacyFile, JSON.stringify({
    "5511999999999": { nome: "Ana Maria", nick: "AnaGO", codigo: "1111 2222-3333", cidade: "São  Paulo" },
    "5521888888888": { nome: "Bruno", nick: "BrunoGO", cod: "444455556666", cidade: "Rio" },
    "123456789@lid": { nome: "${nome}", nick: "${nick}", codigo: "${codigo}", cidade: "${cidade}" }
  }, null, 2));
  const repository = createRegistrationRepository({ databaseDir, backupRoot });
  const service = createRegistrationService({ repository });
  return { root, legacyFile, databaseDir, backupRoot, repository, service };
}

test("migra três registros, cria backup validado e é idempotente", async () => {
  const f = await fixture();
  const first = await migrateLegacyRegistrations(f);
  assert.equal(first.status, "migrated"); assert.equal(first.total, 3); assert.equal(first.backup.validation.valid, true);
  const meta = JSON.parse(await fsp.readFile(path.join(first.backup.directory, "backup-manifest.json"), "utf8"));
  const copied = await fsp.readFile(path.join(first.backup.directory, "cadastros.json"));
  assert.equal(meta.checksums["cadastros.json"].value, crypto.createHash("sha256").update(copied).digest("hex"));
  const review = (await f.repository.listRegistrations()).find(item => item.status === "review_required");
  assert.equal(review.validationStatus, "invalid_placeholder");
  const ids = (await f.repository.listRegistrations()).map(item => item.registrationId);
  const second = await migrateLegacyRegistrations(f);
  assert.equal(second.status, "unchanged"); assert.equal(second.created, 0); assert.equal(second.updated, 0);
  assert.deepEqual((await f.repository.listRegistrations()).map(item => item.registrationId), ids);
});

test("identidades tradicionais, LID, dispositivo e nono dígito usam aliases exatos", async () => {
  const f = await fixture(); await migrateLegacyRegistrations(f);
  const ana = await f.service.getRegistrationByIdentity("5511999999999@c.us");
  assert.equal(ana.nick, "AnaGO");
  assert.equal((await f.service.getRegistrationByIdentity("5511999999999@s.whatsapp.net")).registrationId, ana.registrationId);
  assert.equal((await f.service.getRegistrationByIdentity("5511999999999:12@c.us")).registrationId, ana.registrationId);
  assert.equal((await f.service.getRegistrationByIdentity("551199999999")).registrationId, ana.registrationId);
  assert.equal((await f.service.getRegistrationByIdentity("123456789@lid")).status, "review_required");
  assert.equal(await f.service.getRegistrationByIdentity("99999999"), null);
});

test("buscas, validações, histórico e atualização preservam registrationId", async () => {
  const f = await fixture(); await migrateLegacyRegistrations(f);
  const before = await f.service.getRegistrationByIdentity("5511999999999");
  const updated = await f.service.upsertRegistration({ primaryIdentity: "5511999999999", name: "Ana Maria", nick: "Novo Nick", friendCode: "111122223333", city: "São Paulo" });
  assert.equal(updated.registrationId, before.registrationId);
  assert.equal((await f.repository.findByNick("novo nick"))[0].registrationId, before.registrationId);
  assert.equal((await f.repository.findByFriendCode("1111-2222-3333")).registrationId, before.registrationId);
  assert.equal(f.service.validateName("${nome}").valid, false); assert.equal(f.service.validateNick("  ").valid, false);
  assert.equal(f.service.validateFriendCode("123").valid, false); assert.equal(f.service.normalizeFriendCode("1111-2222 3333"), "111122223333");
  const db = await f.repository.loadDatabase(); assert.ok(db.data.history[before.registrationId].some(entry => entry.action === "updated"));
});

test("detecta duplicidade, índice órfão, corrupção e checksum incorreto", async () => {
  const f = await fixture(); await migrateLegacyRegistrations(f);
  await assert.rejects(() => f.service.createRegistration({ primaryIdentity: "5531777777777", name: "C", nick: "C", friendCode: "111122223333", city: "BH" }), /duplicado/i);
  const dataFile = path.join(f.databaseDir, "registrations.json");
  const good = await fsp.readFile(dataFile, "utf8"), parsed = JSON.parse(good); parsed.data.identityIndex.orphan = "REG999999";
  await fsp.writeFile(dataFile, JSON.stringify(parsed)); assert.equal((await f.repository.validateDatabase()).valid, false);
  await fsp.writeFile(dataFile, "{"); assert.match((await f.repository.validateDatabase()).errors.join(" "), /JSON corrompido/i);
});

test("escrita concorrente é atômica e não deixa temporários", async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 12 }, (_, index) => f.service.createRegistration({ primaryIdentity: `551190000${String(index).padStart(4, "0")}`, name: `Nome ${index}`, nick: `Nick ${index}`, friendCode: String(100000000000 + index), city: "Cidade" })));
  assert.equal((await f.repository.listRegistrations()).length, 12);
  assert.equal((await fsp.readdir(f.databaseDir)).some(file => file.endsWith(".tmp")), false);
  assert.equal((await f.repository.validateDatabase()).valid, true);
});

test("backup da base versionada pode ser restaurado", async () => {
  const f = await fixture(); await migrateLegacyRegistrations(f);
  const backup = await f.repository.createBackup();
  const dataFile = path.join(f.databaseDir, "registrations.json"), original = await fsp.readFile(dataFile, "utf8");
  await fsp.writeFile(dataFile, "{}\n");
  await f.repository.restoreBackup(backup.directory, { targetFile: dataFile });
  assert.equal(await fsp.readFile(dataFile, "utf8"), original);
});
