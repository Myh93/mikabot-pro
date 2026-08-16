"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const { createRegistrationRepository } = require("../src/repositories/registrationRepository");
const { createRegistrationService } = require("../src/services/registrationService");
const { createRegistrationPublicQueryService } = require("../src/services/registrationPublicQueryService");
const { createRegistrationPublicQueryCommands } = require("../src/commands/registrationPublicQuery");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-privacy-query-"));
  const repository = createRegistrationRepository({ databaseDir: path.join(root, "db"), backupRoot: path.join(root, "backups") });
  const registrations = createRegistrationService({ repository });
  return { repository, registrations, service: createRegistrationPublicQueryService({ registrationService: registrations }) };
}

const secondary = (index) => ({ nick: `Sec${index}`, friendCode: String(300000000000 + index), team: "valor", level: 40 + index });
const trainer = (privacy = {}) => ({
  primaryIdentity: "5511999999999", name: "Ana", nick: "AnaGO", friendCode: "123456789012", city: "SP",
  mainAccount: { nick: "AnaGO", friendCode: "123456789012", team: "mystic", level: 50 },
  secondaryAccounts: [secondary(1), secondary(2)], privacy
});
const target = (viewerIdentity, command = "treinador", page = 1) => ({ type: "identity", value: "5511999999999", viewerIdentity, command, page });

test("funções de privacidade liberam somente o dono e respeitam padrões antigos", async () => {
  const f = await fixture();
  const privateRegistration = { primaryIdentity: "5511999999999", identityAliases: ["5511999999999@c.us"], privacy: { showFriendCode: false, showSecondaryAccounts: false } };
  assert.equal(f.service.isOwnerView(privateRegistration, "5511999999999@s.whatsapp.net"), true);
  assert.equal(f.service.canViewFriendCode(privateRegistration, "admin@lid"), false);
  assert.equal(f.service.canViewSecondaryAccounts(privateRegistration, "admin@lid"), false);
  assert.equal(f.service.canViewFriendCode({ primaryIdentity: "owner" }, "other"), true);
  assert.equal(f.service.canViewSecondaryAccounts({ primaryIdentity: "owner" }, "other"), true);
});

test("consulta própria ignora as duas preferências de privacidade", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer({ showFriendCode: false, showSecondaryAccounts: false }));
  const profile = (await f.service.getPublicAccounts(target("5511999999999"))).text;
  const codes = (await f.service.getPublicFriendCodes(target("5511999999999", "fc"))).text;
  assert.match(profile, /1234 5678 9012/); assert.match(profile, /Sec1/); assert.match(codes, /3000 0000 0001/);
});

test("terceiro vê Friend Code e contas quando ambos são públicos", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer({ showFriendCode: true, showSecondaryAccounts: true }));
  const text = (await f.service.getPublicAccounts(target("outro@lid"))).text;
  assert.match(text, /1234 5678 9012/); assert.match(text, /Sec1/);
});

test("Friend Code privado nunca é mostrado, mascarado ou parcialmente revelado", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer({ showFriendCode: false, showSecondaryAccounts: true }));
  const profile = (await f.service.getPublicAccounts(target("outro@lid"))).text;
  assert.match(profile, /🔒 Friend Code privado/); assert.doesNotMatch(profile, /1234|9012|123456789012|3000 0000 0001|300000000001/);
  assert.equal((await f.service.getPublicFriendCodes(target("outro@lid", "fc"))).text, "Este treinador optou por não divulgar o Friend Code.");
});

test("contas privadas ficam ocultas, mas quantidade total continua pública", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer({ showFriendCode: true, showSecondaryAccounts: false }));
  const text = (await f.service.getPublicAccounts(target("outro@lid"))).text;
  assert.match(text, /🔒 Contas secundárias privadas/); assert.match(text, /Total de contas:\n3/); assert.doesNotMatch(text, /Sec1|3000 0000 0001/);
  assert.equal((await f.service.getPublicAccounts(target("outro@lid", "contas"))).text, "Este treinador optou por não divulgar as contas secundárias.");
});

test("ambas privadas mantêm Nick, Time, Nível e conta principal públicos", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer({ showFriendCode: false, showSecondaryAccounts: false }));
  const text = (await f.service.getPublicAccounts(target("outro@lid"))).text;
  for (const expected of [/AnaGO/, /Mystic/, /Nível:\n50/, /Conta principal/, /Friend Code privado/, /Contas secundárias privadas/, /Total de contas:\n3/]) assert.match(text, expected);
});

test("administrador não ignora privacidade", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer({ showFriendCode: false, showSecondaryAccounts: false }));
  const resolved = f.service.resolveQueryTarget({ msg: { body: "!treinador" }, args: ["AnaGO"], context: { userId: "admin@lid", isAdmin: true } });
  const text = (await f.service.getPublicAccounts(resolved)).text;
  assert.match(text, /Friend Code privado|Contas secundárias privadas/); assert.doesNotMatch(text, /1234 5678 9012|Sec1/);
});

test("registro sem privacy mantém compatibilidade pública", async () => {
  const f = await fixture();
  await f.repository.createRegistration({ registrationId: "REG000099", platform: "whatsapp", primaryIdentity: "legacy@lid", identityAliases: ["legacy@lid"], name: "Legado", nick: "LegacyGO", friendCode: "999988887777", city: "BH", mainAccount: { nick: "LegacyGO", friendCode: "999988887777", team: "instinct", level: 99 }, secondaryAccounts: [secondary(8)], status: "active", validationStatus: "valid", source: "test", metadata: {} });
  const result = await f.service.getPublicAccounts({ type: "identity", value: "legacy@lid", viewerIdentity: "other@lid", command: "treinador", page: 1 });
  assert.match(result.text, /9999 8888 7777/); assert.match(result.text, /Sec8/);
});

test("aliases afetados permanecem disponíveis", () => {
  const commands = createRegistrationPublicQueryCommands();
  assert.deepEqual(commands[0].aliases, ["contas"]);
  for (const alias of ["friendcode", "codes", "codigo", "códigos", "friend"]) assert.ok(commands[1].aliases.includes(alias));
});

test("paginação não permite navegar pelas contas secundárias privadas", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer({ showFriendCode: true, showSecondaryAccounts: false }));
  const result = await f.service.getPublicAccounts(target("outro@lid", "treinador", 2));
  assert.equal(result.text, "❌ Esta página não possui contas."); assert.doesNotMatch(result.text, /Sec/);
});
