"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const { createRegistrationRepository } = require("../src/repositories/registrationRepository");
const { createRegistrationService } = require("../src/services/registrationService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createRegistrationGuidedFlowService, PRIVACY_GROUP_GUIDANCE } = require("../src/services/registrationGuidedFlowService");
const { createRegistrationPrivacyCommand } = require("../src/commands/registrationPrivacy");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-privacy-command-"));
  const databaseDir = path.join(root, "db"), backupRoot = path.join(root, "backups");
  const repository = createRegistrationRepository({ databaseDir, backupRoot });
  const registrations = createRegistrationService({ repository });
  const flows = createGuidedFlowService({ filePath: path.join(root, "flows.json") });
  const guided = createRegistrationGuidedFlowService({ registrationService: registrations, guidedFlowService: flows });
  const messages = [];
  const context = { platform: "whatsapp", conversationId: "5511999999999", groupId: "5511999999999", userId: "5511999999999", identity: { id: "5511999999999", candidates: ["5511999999999"] }, isGroup: false, replyText: async text => messages.push(String(text)) };
  await registrations.upsertRegistration({ primaryIdentity: context.userId, name: "Ana", nick: "AnaGO", friendCode: "123456789012", city: "SP", mainAccount: { nick: "AnaGO", friendCode: "123456789012", team: "mystic", level: 50 }, secondaryAccounts: [], privacy: { showFriendCode: true, showSecondaryAccounts: true } });
  return { root, databaseDir, backupRoot, repository, registrations, flows, guided, messages, context };
}

test("comando e aliases são privados e não aceitam alvo", async () => {
  const f = await fixture(); const command = createRegistrationPrivacyCommand({ registrationGuidedFlowService: f.guided });
  assert.equal(command.name, "privacidade"); assert.deepEqual(command.aliases, ["privacy", "privado", "configprivacidade"]);
  await command.execute({}, { mentionedIds: [] }, ["AnaGO"], { platformContext: f.context });
  assert.match(f.messages.at(-1), /somente a privacidade do seu próprio cadastro/);
  assert.equal(await f.flows.getActiveFlow("whatsapp", f.context.conversationId, f.context.userId), null);
});

test("grupo mostra somente orientação de segurança e não abre fluxo", async () => {
  const f = await fixture(); const command = createRegistrationPrivacyCommand({ registrationGuidedFlowService: f.guided });
  const group = { ...f.context, isGroup: true, groupId: "grupo@g.us", conversationId: undefined };
  await command.execute({}, {}, [], { platformContext: group });
  assert.equal(f.messages.at(-1), PRIVACY_GROUP_GUIDANCE);
  assert.equal(await f.flows.getActiveFlow("whatsapp", "grupo@g.us", f.context.userId), null);
});

test("menu privado mostra estados atuais e altera Friend Code para privado e público", async () => {
  const f = await fixture(); await f.guided.startPrivacy(f.context);
  assert.match(f.messages.at(-1), /PRIVACIDADE/); assert.match(f.messages.at(-1), /2️⃣ Friend Code/);
  await f.guided.handleAnswer(f.context, "2"); assert.match(f.messages.at(-1), /Atual:\n✅ Público/); assert.match(f.messages.at(-1), /Recomendado: Visível/);
  await f.guided.handleAnswer(f.context, "não"); assert.equal((await f.registrations.getPrivacy(f.context.userId)).showFriendCode, false); assert.match(f.messages.at(-1), /Preferência atualizada/);
  await f.guided.handleAnswer(f.context, "friend code"); assert.match(f.messages.at(-1), /Atual:\n🔒 Privado/);
  await f.guided.handleAnswer(f.context, "sim"); assert.equal((await f.registrations.getPrivacy(f.context.userId)).showFriendCode, true);
});

test("altera contas secundárias usando números e preserva todos os outros campos", async () => {
  const f = await fixture(); const before = await f.registrations.getRegistrationByIdentity(f.context.userId);
  await f.guided.startPrivacy(f.context); await f.guided.handleAnswer(f.context, "3"); await f.guided.handleAnswer(f.context, "2");
  const after = await f.registrations.getRegistrationByIdentity(f.context.userId);
  assert.equal(after.privacy.showSecondaryAccounts, false); assert.equal(after.privacy.showFriendCode, true);
  for (const key of ["registrationId", "createdAt", "name", "nick", "friendCode", "city", "mainAccount", "secondaryAccounts", "contacts", "preferences"]) assert.deepEqual(after[key], before[key]);
  assert.notEqual(after.updatedAt, before.updatedAt);
});

test("voltar retorna ao menu sem gravar e zero encerra", async () => {
  const f = await fixture(); await f.guided.startPrivacy(f.context); await f.guided.handleAnswer(f.context, "2");
  const result = await f.guided.handleAnswer(f.context, "voltar"); assert.equal(result.status, "back"); assert.match(f.messages.at(-1), /PRIVACIDADE/);
  assert.deepEqual(await f.registrations.getPrivacy(f.context.userId), { showFriendCode: true, showSecondaryAccounts: true });
  const closed = await f.guided.handleAnswer(f.context, "0"); assert.equal(closed.status, "back"); assert.equal(await f.guided.hasActiveFlow(f.context), false);
});

test("cancelar encerra sem gravar", async () => {
  const f = await fixture(); await f.guided.startPrivacy(f.context); await f.guided.handleAnswer(f.context, "2");
  const result = await f.guided.handleAnswer(f.context, "cancelar"); assert.equal(result.status, "cancelled");
  assert.deepEqual(await f.registrations.getPrivacy(f.context.userId), { showFriendCode: true, showSecondaryAccounts: true });
  assert.equal(await f.guided.hasActiveFlow(f.context), false);
});

test("persistência mantém histórico, índices e registrationId", async () => {
  const f = await fixture(); const before = await f.registrations.getRegistrationByIdentity(f.context.userId);
  await f.registrations.setFriendCodeVisibility(f.context.userId, false);
  const database = (await f.repository.loadDatabase()).data;
  assert.equal(database.identityIndex[f.context.userId], before.registrationId); assert.equal(database.friendCodeIndex[before.friendCode], before.registrationId);
  assert.equal(database.history[before.registrationId].at(-1).action, "privacy_updated");
  const restarted = createRegistrationService({ repository: createRegistrationRepository({ databaseDir: f.databaseDir, backupRoot: f.backupRoot }) });
  const stored = await restarted.getRegistrationByIdentity(f.context.userId); assert.equal(stored.registrationId, before.registrationId); assert.equal(stored.privacy.showFriendCode, false);
});

test("registro antigo sem privacy assume ambas as opções públicas", async () => {
  const f = await fixture();
  await f.repository.createRegistration({ registrationId: "REG000099", platform: "whatsapp", primaryIdentity: "legacy@lid", identityAliases: ["legacy@lid"], name: "Legado", nick: "LegacyGO", friendCode: "999988887777", city: "BH", mainAccount: { nick: "LegacyGO", friendCode: "999988887777", team: "valor", level: 80 }, secondaryAccounts: [], status: "active", validationStatus: "valid", source: "test", metadata: {} });
  assert.deepEqual(await f.registrations.getPrivacy("legacy@lid"), { showFriendCode: true, showSecondaryAccounts: true });
  await f.registrations.setSecondaryAccountsVisibility("legacy@lid", false);
  assert.deepEqual(await f.registrations.getPrivacy("legacy@lid"), { showFriendCode: true, showSecondaryAccounts: false });
});

test("arquitetura não cria listener nem acessa banco diretamente pelo comando", async () => {
  const command = await fsp.readFile(path.join(__dirname, "..", "src", "commands", "registrationPrivacy.js"), "utf8");
  const guided = await fsp.readFile(path.join(__dirname, "..", "src", "services", "registrationGuidedFlowService.js"), "utf8");
  assert.equal(/client\.on\s*\(/.test(command + guided), false); assert.equal(/registrations\.json|cadastros\.json/.test(command), false);
});
