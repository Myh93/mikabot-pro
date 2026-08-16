"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const { createRegistrationRepository } = require("../src/repositories/registrationRepository");
const { createRegistrationService } = require("../src/services/registrationService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createRegistrationGuidedFlowService, OFFICIAL_TELEGRAM_INVITE } = require("../src/services/registrationGuidedFlowService");
const { createRegistrationPublicQueryService } = require("../src/services/registrationPublicQueryService");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-contacts-"));
  const repository = createRegistrationRepository({ databaseDir: path.join(root, "db"), backupRoot: path.join(root, "backups") });
  const registrations = createRegistrationService({ repository });
  const flows = createGuidedFlowService({ filePath: path.join(root, "flows.json"), ttlMs: 1_800_000 });
  const guided = createRegistrationGuidedFlowService({ guidedFlowService: flows, registrationService: registrations });
  const messages = [], context = { platform: "whatsapp", conversationId: "5511999999999", groupId: "5511999999999", userId: "5511999999999", identity: { id: "5511999999999", candidates: ["5511999999999"] }, isGroup: false, replyText: async text => messages.push(String(text)) };
  return { root, repository, registrations, flows, guided, messages, context };
}
async function answer(f, values) { for (const value of values) await f.guided.handleAnswer(f.context, value); }
const base = ["1", "João", "JoaoGO", "123456789012", "Mystic", "Sousa", "100", "não", "sim", "Noite", "não"];

test("defaults e registros antigos são normalizados sem migração destrutiva", async () => {
  const f = await fixture(); await f.registrations.upsertLegacyRegistration({ primaryIdentity: "5511888888888", nome: "Legado", nick: "LegacyGO", codigo: "999988887777", cidade: "BH" });
  const item = await f.registrations.getRegistrationByIdentity("5511888888888");
  assert.deepEqual(item.contacts, f.registrations.getDefaultContacts()); assert.deepEqual(item.preferences, f.registrations.getDefaultPreferences()); assert.deepEqual(item.privacy, f.registrations.getDefaultPrivacy());
});

test("normaliza e valida username do Telegram", async () => {
  const f = await fixture(); assert.deepEqual(f.registrations.validateTelegramUsername("MeuNick"), { valid: true, value: "@MeuNick", error: null }); assert.equal(f.registrations.validateTelegramUsername("@MeuNick").value, "@MeuNick");
  for (const invalid of ["abc", "@nome-com-hifen", "@nome com espaço", "@"] ) assert.equal(f.registrations.validateTelegramUsername(invalid).valid, false);
});

test("normaliza links permitidos e rejeita domínios perigosos", async () => {
  const f = await fixture(); for (const value of ["https://t.me/grupo", "https://telegram.me/grupo", "t.me/grupo"]) assert.equal(f.registrations.validateTelegramGroupLink(value).valid, true, value);
  assert.equal(f.registrations.validateTelegramGroupLink("t.me/grupo").value, "https://t.me/grupo");
  for (const value of ["https://example.com/grupo", "javascript:alert(1)", "t.me/", "http://evil.t.me.example/grupo"]) assert.equal(f.registrations.validateTelegramGroupLink(value).valid, false, value);
});

test("fluxo sem Telegram persiste preferências e privacidade Sim", async () => {
  const f = await fixture(); await f.guided.start(f.context); await answer(f, [...base, "1", "1", "não", "confirmar"]);
  const item = await f.registrations.getRegistrationByIdentity(f.context.userId); assert.equal(item.contacts.telegram.enabled, false); assert.deepEqual(item.preferences, { raidNotifications: true, eventNotifications: true, quizNotifications: true, newsNotifications: true }); assert.deepEqual(item.privacy, { showFriendCode: true, showSecondaryAccounts: true, showNick: true });
});

test("fluxo com Telegram fica no final, oferece convite e preserva preferências", async () => {
  const f = await fixture(); await f.guided.start(f.context); await answer(f, [...base, "3", "sim", "não", "yes", "no", "3", "sim", "não", "sim", "sim"]);
  assert.match(f.messages.at(-1), /grupo oficial da Tropa Pokémon GO/);
  await f.guided.handleAnswer(f.context, "sim");
  assert.ok(f.messages.some(message => message.includes(OFFICIAL_TELEGRAM_INVITE)));
  assert.match(f.messages.at(-1), /REVISE SEU CADASTRO/);
  assert.match(f.messages.at(-1), /Mesmo número do WhatsApp/); assert.doesNotMatch(f.messages.at(-1), /Nome do grupo|Link do grupo|Grupo GO|t\.me\//); assert.match(f.messages.at(-1), /Avisos/); assert.match(f.messages.at(-1), /Privacidade/);
  await f.guided.handleAnswer(f.context, "1"); const item = await f.registrations.getRegistrationByIdentity(f.context.userId);
  assert.deepEqual(item.contacts.telegram, { enabled: true, username: "+5511999999999", groupName: "", groupLink: "" });
  assert.deepEqual(item.preferences, { raidNotifications: true, eventNotifications: false, quizNotifications: true, newsNotifications: false }); assert.deepEqual(item.privacy, { showFriendCode: true, showSecondaryAccounts: false });
});

test("recusar convite oficial segue para revisão sem abandonar o cadastro", async () => {
  const f = await fixture(); await f.guided.start(f.context); await answer(f, [...base, "1", "1", "sim", "não", "5583999999999"]);
  await f.guided.handleAnswer(f.context, "não");
  assert.equal((await f.flows.getActiveFlow("whatsapp", f.context.conversationId, f.context.userId)).step, "review");
  assert.match(f.messages.at(-1), /REVISE SEU CADASTRO/);
  assert.equal(f.messages.some(message => message.includes(OFFICIAL_TELEGRAM_INVITE)), false);
});

test("revisão permite editar Telegram, preferências e privacidade", async () => {
  const f = await fixture(); await f.guided.start(f.context); await answer(f, [...base, "1", "1", "não"]);
  await answer(f, ["15", "não", "16", "2"]); assert.match(f.messages.at(-1), /Nenhum/);
  await answer(f, ["17", "2"]); assert.match(f.messages.at(-1), /Tudo privado/);
});

test("rascunho e retomada preservam respostas privadas", async () => {
  const f = await fixture(); await f.guided.start(f.context); await answer(f, [...base, "1", "1", "sim"]); assert.equal((await f.guided.handleAnswer(f.context, "6")).status, "draft_saved");
  await f.guided.start(f.context); await f.guided.handleAnswer(f.context, "continuar"); const session = await f.flows.getActiveFlow("whatsapp", f.context.conversationId, f.context.userId); assert.equal(session.step, "telegram_same_number");
});

test("cancelamento não persiste Telegram ou preferências", async () => {
  const f = await fixture(); await f.guided.start(f.context); await answer(f, [...base, "1", "1", "sim"]); await f.guided.handleAnswer(f.context, "cancelar"); assert.equal(await f.registrations.getRegistrationByIdentity(f.context.userId), null);
});

test("consulta pública não revela contatos, preferências ou privacidade", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration({ primaryIdentity: f.context.userId, name: "João", nick: "JoaoGO", friendCode: "123456789012", city: "Privada", mainAccount: { nick: "JoaoGO", friendCode: "123456789012", team: "mystic", level: 50 }, contacts: { telegram: { enabled: true, username: "@Segredo", groupName: "Grupo Secreto", groupLink: "https://t.me/segredo" } }, preferences: { raidNotifications: false }, privacy: { showFriendCode: false } });
  const query = createRegistrationPublicQueryService({ registrationService: f.registrations }); const text = (await query.getPublicAccounts({ type: "identity", value: f.context.userId, page: 1 })).text;
  for (const secret of ["Segredo", "Grupo Secreto", "raidNotifications", "showFriendCode", "telegram"]) assert.doesNotMatch(text, new RegExp(secret, "i"));
});
