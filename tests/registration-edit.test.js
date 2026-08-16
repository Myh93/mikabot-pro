"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const { createRegistrationRepository } = require("../src/repositories/registrationRepository");
const { createRegistrationService } = require("../src/services/registrationService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createRegistrationGuidedFlowService } = require("../src/services/registrationGuidedFlowService");
const { createRegistrationEditCommand } = require("../src/commands/registrationEdit");

async function fixture(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-registration-edit-"));
  const repository = createRegistrationRepository({ databaseDir: path.join(root, "db"), backupRoot: path.join(root, "backups") });
  const registrations = createRegistrationService({ repository });
  const flows = createGuidedFlowService({ filePath: path.join(root, "flows.json") });
  const guided = createRegistrationGuidedFlowService({ registrationService: registrations, guidedFlowService: flows });
  const messages = [], context = { platform: "whatsapp", conversationId: "5511999999999", groupId: "5511999999999", userId: "5511999999999", identity: { id: "5511999999999", candidates: ["5511999999999"] }, isGroup: false, replyText: async text => messages.push(String(text)) };
  if (options.registration !== false) await registrations.upsertRegistration({ primaryIdentity: context.userId, name: "Ana", nick: "AnaGO", friendCode: "123456789012", city: "SP", mainAccount: { nick: "AnaGO", friendCode: "123456789012", team: "mystic", level: 50 }, secondaryAccounts: [], contacts: { telegram: { enabled: true, username: "@AnaGo", groupName: "Grupo", groupLink: "https://t.me/grupo" } }, preferences: { raidNotifications: true, eventNotifications: true, quizNotifications: true, newsNotifications: true }, privacy: { showFriendCode: true, showSecondaryAccounts: true }, playStyle: { fly: true, canela: true }, playSchedule: "Noite" });
  const answer = async text => guided.handleAnswer(context, text);
  return { root, repository, registrations, flows, guided, messages, context, answer };
}

test("comando, aliases, grupo e privado", async () => {
  const f = await fixture(); const command = createRegistrationEditCommand({ registrationGuidedFlowService: f.guided });
  assert.equal(command.name, "editarcadastro"); assert.deepEqual(command.aliases, ["editar cadastro", "editarregistro", "editarperfilgo", "configcadastro"]);
  await command.execute({}, {}, [], { platformContext: { ...f.context, isGroup: true, groupId: "grupo@g.us", conversationId: undefined } });
  assert.equal(f.messages.at(-1), "📝 Para editar seu cadastro com segurança, fale comigo no privado e envie:\n\n!editarcadastro"); assert.doesNotMatch(f.messages.at(-1), /AnaGO|1234/);
  await command.execute({}, {}, [], { platformContext: f.context }); assert.match(f.messages.at(-1), /MEU CADASTRO/); assert.match(f.messages.at(-1), /Cadastro ativo/); assert.equal(await f.guided.hasActiveFlow(f.context), true);
});

test("cadastro inexistente e cadastro em revisão não abrem edição", async () => {
  const missing = await fixture({ registration: false }); assert.equal((await missing.guided.startEdit(missing.context)).status, "not_registered"); assert.match(missing.messages.at(-1), /ainda não possui cadastro/);
  const review = await fixture({ registration: false }); await review.repository.createRegistration({ registrationId: "REG000001", platform: "whatsapp", primaryIdentity: review.context.userId, identityAliases: [review.context.userId], name: "${nome}", nick: "${nick}", friendCode: "123", city: "X", status: "review_required", validationStatus: "invalid_placeholder", source: "test", metadata: {} });
  assert.equal((await review.guided.startEdit(review.context)).status, "review_required"); assert.match(review.messages.at(-1), /precisa ser revisado/);
});

test("edita nome, cidade, horários, Fly e Canela preservando registrationId", async () => {
  const f = await fixture(), before = await f.registrations.getRegistrationByIdentity(f.context.userId); await f.guided.startEdit(f.context);
  await f.answer("nome"); await f.answer("Ana Maria");
  await f.answer("cidade"); await f.answer("São Paulo");
  await f.answer("horários"); await f.answer(" Depois   das 18h ");
  await f.answer("fly"); await f.answer("fly"); await f.answer("não");
  await f.answer("4"); await f.answer("2"); await f.answer("n");
  const after = await f.registrations.getRegistrationByIdentity(f.context.userId);
  assert.equal(after.registrationId, before.registrationId); assert.equal(after.name, "Ana Maria"); assert.equal(after.city, "São Paulo"); assert.equal(after.playSchedule, "Depois das 18h"); assert.deepEqual(after.playStyle, { fly: false, canela: false });
});

test("conta principal valida confirmação, índices, nível livre e time", async () => {
  const f = await fixture(); await f.guided.startEdit(f.context);
  await f.answer("2"); await f.answer("nick"); await f.answer("NovoNick"); assert.match(f.messages.at(-1), /Confirma alterar o Nick/); await f.answer("1");
  await f.answer("conta principal"); await f.answer("friend code"); await f.answer("9999-8888 7777"); assert.match(f.messages.at(-1), /9999 8888 7777/); await f.answer("sim");
  await f.answer("2"); await f.answer("time"); await f.answer("1");
  await f.answer("2"); await f.answer("nível"); await f.answer("999");
  const stored = await f.registrations.getRegistrationByIdentity(f.context.userId); assert.equal(stored.nick, "NovoNick"); assert.equal(stored.mainAccount.nick, "NovoNick"); assert.equal(stored.friendCode, "999988887777"); assert.equal(stored.mainAccount.team, "valor"); assert.equal(stored.mainAccount.level, 999);
  const db = (await f.repository.loadDatabase()).data; assert.equal(db.friendCodeIndex["999988887777"], stored.registrationId); assert.equal(db.friendCodeIndex["123456789012"], undefined); assert.ok(db.nickIndex.novonick.includes(stored.registrationId));
  await f.answer("2"); await f.answer("4"); assert.equal((await f.answer("0")).status, "menu");
});

test("nível aceita 1 e rejeita zero, negativo, decimal e texto", async () => {
  const f = await fixture(); await f.guided.startEdit(f.context);
  for (const invalid of ["-1", "1.5", "alto"]) { await f.answer("2"); await f.answer("4"); assert.equal((await f.answer(invalid)).status, "validation_error"); await f.answer("0"); await f.answer("0"); }
  await f.answer("2"); await f.answer("4"); await f.answer("0"); assert.equal((await f.registrations.getRegistrationByIdentity(f.context.userId)).mainAccount.level, 50); await f.answer("0");
  await f.answer("2"); await f.answer("4"); await f.answer("1"); assert.equal((await f.registrations.getRegistrationByIdentity(f.context.userId)).mainAccount.level, 1);
});

test("Telegram ativa, desativa preservando dados, edita campos e limpa com confirmação", async () => {
  const f = await fixture(); await f.guided.startEdit(f.context);
  await f.answer("telegram"); await f.answer("1"); await f.answer("não"); let telegram = (await f.registrations.getRegistrationByIdentity(f.context.userId)).contacts.telegram; assert.equal(telegram.enabled, false); assert.equal(telegram.username, "@AnaGo");
  await f.answer("6"); await f.answer("2"); await f.answer("Novo_User");
  await f.answer("6"); await f.answer("3"); await f.answer("Novo Grupo");
  await f.answer("6"); await f.answer("4"); await f.answer("t.me/novo_grupo");
  await f.answer("6"); await f.answer("1"); await f.answer("s"); telegram = (await f.registrations.getRegistrationByIdentity(f.context.userId)).contacts.telegram; assert.deepEqual(telegram, { enabled: true, username: "@Novo_User", groupName: "Novo Grupo", groupLink: "https://t.me/novo_grupo" });
  await f.answer("6"); await f.answer("5"); assert.match(f.messages.at(-1), /Confirma limpar/); await f.answer("1"); telegram = (await f.registrations.getRegistrationByIdentity(f.context.userId)).contacts.telegram; assert.deepEqual(telegram, { enabled: false, username: "", groupName: "", groupLink: "" });
});

test("edita cada preferência e privacidade reutilizando serviços existentes", async () => {
  const f = await fixture(); await f.guided.startEdit(f.context);
  for (const option of [1, 2, 3, 4]) { await f.answer("7"); await f.answer(String(option)); await f.answer("não"); }
  await f.answer("9"); await f.answer("1"); await f.answer("2"); await f.answer("9"); await f.answer("2"); await f.answer("não"); await f.answer("9"); await f.answer("3"); await f.answer("2");
  const stored = await f.registrations.getRegistrationByIdentity(f.context.userId); assert.deepEqual(stored.preferences, { raidNotifications: false, eventNotifications: false, quizNotifications: false, newsNotifications: false }); assert.deepEqual(stored.privacy, { showFriendCode: false, showSecondaryAccounts: false, showNick: false });
});

test("lista, adiciona, edita e remove secundárias somente por posição", async () => {
  const f = await fixture(); await f.guided.startEdit(f.context);
  await f.answer("8"); await f.answer("2"); await f.answer("AltOne"); await f.answer("2222 3333 4444"); await f.answer("Mystic"); await f.answer("75");
  await f.answer("8"); await f.answer("listar"); assert.match(f.messages.at(-1), /AltOne/); assert.doesNotMatch(f.messages.at(-1), /ACC\d/);
  await f.answer("menu"); await f.answer("8"); await f.answer("3"); await f.answer("1"); await f.answer("4"); await f.answer("1000"); assert.equal((await f.registrations.listAccounts(f.context.userId)).secondaryAccounts[0].level, 1000);
  await f.answer("8"); await f.answer("4"); await f.answer("1"); assert.match(f.messages.at(-1), /Confirma remover/); await f.answer("1"); assert.equal((await f.registrations.listAccounts(f.context.userId)).secondaryAccounts.length, 0);
  await f.answer("8"); await f.answer("4"); assert.match(f.messages.at(-1), /Não há contas secundárias/);
});

test("cancelar mantém alterações confirmadas, voltar e repetir navegam pelo resolvedor", async () => {
  const f = await fixture(); await f.guided.startEdit(f.context); await f.answer("1"); await f.answer("Nome Confirmado"); await f.answer("2"); const repeated = await f.answer("repetir"); assert.equal(repeated.status, "repeated"); const back = await f.answer("voltar"); assert.equal(back.status, "menu"); const cancelled = await f.answer("sair"); assert.equal(cancelled.status, "cancelled"); assert.equal((await f.registrations.getRegistrationByIdentity(f.context.userId)).name, "Nome Confirmado");
});

test("duplicidades são recusadas e histórico usa ações específicas sem dados sensíveis", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration({ primaryIdentity: "5522888888888", name: "Bia", nick: "BiaGO", friendCode: "444455556666", city: "RJ", mainAccount: { nick: "BiaGO", friendCode: "444455556666", team: "valor", level: 40 }, secondaryAccounts: [] }); await f.guided.startEdit(f.context);
  await f.answer("2"); await f.answer("2"); await f.answer("444455556666"); await f.answer("1"); assert.match(f.messages.at(-1), /já cadastrado/); assert.equal((await f.registrations.getRegistrationByIdentity(f.context.userId)).friendCode, "123456789012");
  await f.answer("menu"); await f.answer("1"); await f.answer("Novo Nome"); const stored = await f.registrations.getRegistrationByIdentity(f.context.userId), db = (await f.repository.loadDatabase()).data, history = db.history[stored.registrationId]; assert.ok(history.some(entry => entry.action === "name_updated")); assert.equal(JSON.stringify(history).includes("123456789012"), false);
});

test("registro legado normalizado pode ser editado sem duplicação", async () => {
  const f = await fixture({ registration: false }); await f.registrations.upsertLegacyRegistration({ primaryIdentity: f.context.userId, nome: "Legado", nick: "LegacyGO", codigo: "777788889999", cidade: "BH" }); const before = await f.registrations.listRegistrations(); await f.guided.startEdit(f.context); await f.answer("3"); await f.answer("Nova BH"); const after = await f.registrations.listRegistrations(); assert.equal(after.length, before.length); assert.equal(after[0].city, "Nova BH"); assert.equal(after[0].registrationId, before[0].registrationId);
});

test("arquitetura mantém listener único e não acessa banco no comando", async () => {
  const files = await Promise.all(["src/commands/registrationEdit.js", "src/services/registrationEditFlowService.js"].map(file => fsp.readFile(path.join(__dirname, "..", file), "utf8"))); assert.equal(/client\.on\s*\(/.test(files.join("\n")), false); assert.equal(/registrations\.json|cadastros\.json/.test(files[0]), false);
});
