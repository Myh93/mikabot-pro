"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createRegistrationRepository } = require("../src/repositories/registrationRepository");
const { createRegistrationService } = require("../src/services/registrationService");
const { createRegistrationGuidedFlowService, GROUP_GUIDANCE } = require("../src/services/registrationGuidedFlowService");

async function fixture(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-reg-flow-"));
  let now = new Date("2026-07-19T12:00:00.000Z");
  const flows = createGuidedFlowService({ filePath: path.join(root, "flows.json"), ttlMs: 30 * 60 * 1000, clock: () => now });
  const repository = createRegistrationRepository({ databaseDir: path.join(root, "registrations"), backupRoot: path.join(root, "backups") });
  const registrations = createRegistrationService({ repository });
  const service = createRegistrationGuidedFlowService({ guidedFlowService: flows, registrationService: registrations });
  const messages = [];
  const context = (id = "5511999999999", conversation = id, group = false) => ({ platform: "whatsapp", groupId: group ? conversation : conversation, conversationId: conversation, userId: id, identity: { id, candidates: [id, `${id}@c.us`] }, isGroup: group, replyText: async text => messages.push(String(text)) });
  return { root, flows, repository, registrations, service, messages, context, advance: ms => { now = new Date(now.getTime() + ms); } };
}

async function answer(f, context, values) { for (const value of values) await f.service.handleAnswer(context, value); }
const validAnswers = ["1", "João  Pedro", "JoaoGO", "1234 5678 9012", "2", "Sousa", "50", "1", "1", "Depois  das 18h", "2", "1", "1", "2"];

test("inicia somente no privado, aliases existem e grupo recebe apenas orientação", async () => {
  const f = await fixture(), privateContext = f.context();
  assert.equal((await f.service.start(privateContext)).status, "started");
  const initialMessage = f.messages.at(-1);
  assert.match(initialMessage, /CADASTRO DO TREINADOR/);
  assert.match(initialMessage, /1️⃣ Sim/);
  assert.match(initialMessage, /2️⃣ Cancelar/);
  for (const unavailableOption of ["0️⃣ Menu", "5️⃣ Confirmar", "6️⃣ Salvar", "7️⃣ Repetir", "8️⃣ Voltar", "9️⃣ Cancelar"]) {
    assert.doesNotMatch(initialMessage, new RegExp(unavailableOption));
  }
  const groupContext = f.context("5511888888888", "grupo@g.us", true);
  assert.equal((await f.service.start(groupContext)).status, "group_guidance"); assert.equal(f.messages.at(-1), GROUP_GUIDANCE); assert.doesNotMatch(f.messages.at(-1), /Friend Code:/);
  const command = require("../src/commands/pokemon"); for (const alias of ["cadastro", "cadastrar", "registro", "registrar"]) assert.ok(command.aliases.includes(alias));
});

test("início acionado pelo Join Request usa as mesmas opções contextuais", async () => {
  const f = await fixture();
  const joinRequestContext = f.context("requester@lid", "requester@lid", false);
  assert.equal((await f.service.start(joinRequestContext)).status, "started");
  const initialMessage = f.messages.at(-1);
  assert.match(initialMessage, /1️⃣ Sim/);
  assert.match(initialMessage, /2️⃣ Cancelar/);
  for (const unavailableOption of ["0️⃣ Menu", "5️⃣ Confirmar", "6️⃣ Salvar", "7️⃣ Repetir", "8️⃣ Voltar", "9️⃣ Cancelar"]) {
    assert.doesNotMatch(initialMessage, new RegExp(unavailableOption));
  }
});

test("confirma ou cancela o início", async () => {
  const f = await fixture(), c = f.context(); await f.service.start(c);
  assert.equal((await f.service.handleAnswer(c, "x")).status, "validation_error");
  assert.equal((await f.service.handleAnswer(c, "1")).session.step, "name");
  const other = f.context("5521888888888"); await f.service.start(other); assert.equal((await f.service.handleAnswer(other, "2")).status, "cancelled");
});

test("cadastro guiado aceita aliases universais de resposta e navegação", async () => {
  const f = await fixture(), c = f.context(); await f.service.start(c);
  await f.service.handleAnswer(c, "  Ss  "); assert.equal((await f.flows.getActiveFlow("whatsapp", c.conversationId, c.userId)).step, "name");
  assert.equal((await f.service.handleAnswer(c, "!menu")).status, "menu"); assert.match(f.messages.at(-1), /Qual é o seu nome/);
  assert.equal((await f.service.handleAnswer(c, "7")).status, "repeat");
  await f.service.handleAnswer(c, "Nome Teste"); assert.equal((await f.service.handleAnswer(c, "8")).status, "back");
  await f.service.handleAnswer(c, "Nome Teste"); assert.equal((await f.service.handleAnswer(c, "!rascunho")).status, "draft_saved");
  await f.service.start(c); await f.service.handleAnswer(c, "continuar"); assert.equal((await f.flows.getActiveFlow("whatsapp", c.conversationId, c.userId)).step, "nick");
  assert.equal((await f.service.handleAnswer(c, "!sair")).status, "cancelled");
});

test("valida nome, nick e Friend Code sem perder respostas", async () => {
  const f = await fixture(), c = f.context(); await f.service.start(c); await f.service.handleAnswer(c, "1");
  assert.equal((await f.service.handleAnswer(c, "${nome}")).status, "validation_error"); await f.service.handleAnswer(c, "João  Pedro");
  assert.equal((await f.service.handleAnswer(c, " ")).status, "validation_error"); await f.service.handleAnswer(c, "JoaoGO");
  assert.equal((await f.service.handleAnswer(c, "123")).status, "validation_error"); assert.match(f.messages.at(-1), /12 números/);
  await f.service.handleAnswer(c, "1234-5678-9012"); const session = await f.flows.getActiveFlow("whatsapp", c.conversationId, c.userId);
  assert.equal(session.data.name, "João Pedro"); assert.equal(session.data.friendCode, "123456789012");
});

test("aceita times por número e texto e rejeita valor desconhecido", async () => {
  const f = await fixture(), c = f.context(); await f.service.start(c); await answer(f, c, validAnswers.slice(0, 4));
  assert.equal((await f.service.handleAnswer(c, "Rocket")).status, "validation_error"); await f.service.handleAnswer(c, "Sabedoria");
  assert.equal((await f.flows.getActiveFlow("whatsapp", c.conversationId, c.userId)).data.team, "mystic");
  for (const [input, expected] of [["Valor", "valor"], ["Instinto", "instinct"], ["3", "instinct"]]) assert.equal(f.service.validateField("team", input).value, expected);
});

test("nível aceita qualquer inteiro positivo sem máximo", async () => {
  const f = await fixture(); for (const level of [1, 50, 51, 100, 999999999]) assert.deepEqual(f.service.validateField("level", String(level)), { valid: true, value: level, error: "❌ Nível inválido.\n\nDigite um número inteiro a partir de 1." });
  for (const level of ["0", "-1", "1.5", "texto"]) assert.equal(f.service.validateField("level", level).valid, false);
});

test("fluxo completo normaliza estrutura e cadastro ativo não é recriado", async () => {
  const f = await fixture(), c = f.context(); await f.service.start(c); await answer(f, c, validAnswers);
  assert.match(f.messages.at(-1), /REVISE SEU CADASTRO/); assert.match(f.messages.at(-1), /1234 5678 9012/);
  const finished = await f.service.handleAnswer(c, "1"); assert.equal(finished.status, "finished");
  const saved = await f.registrations.getRegistrationByIdentity(c.userId);
  assert.equal(saved.name, "João Pedro"); assert.deepEqual(saved.mainAccount, { nick: "JoaoGO", friendCode: "123456789012", team: "mystic", level: 50 });
  assert.deepEqual(saved.playStyle, { fly: true, canela: true }); assert.equal(saved.playSchedule, "Depois das 18h");
  const id = saved.registrationId;
  const reopened = await f.service.start(c); assert.equal(reopened.status, "started"); assert.match(f.messages.at(-1), /Cadastro ativo/);
  assert.equal((await f.registrations.getRegistrationByIdentity(c.userId)).registrationId, id); assert.equal((await f.registrations.listRegistrations()).length, 1);
});

test("edita cada campo na revisão sem apagar os demais", async () => {
  const replacements = ["Maria", "MariaGO", "9999-8888-7777", "Valor", "Recife", "100", "2", "2", "Fim de semana"];
  for (let index = 0; index < 9; index += 1) {
    const f = await fixture(), c = f.context(String(5511900000000 + index)); await f.service.start(c); await answer(f, c, validAnswers);
    const editChoices = ["1", "2", "3", "4", "cidade", "nível", "fly", "canela", "horários"];
    await f.service.handleAnswer(c, "2"); await f.service.handleAnswer(c, editChoices[index]); await f.service.handleAnswer(c, replacements[index]);
    const session = await f.flows.getActiveFlow("whatsapp", c.conversationId, c.userId); assert.equal(session.step, "review"); assert.equal(session.data.city, index === 4 ? "Recife" : "Sousa"); assert.equal(session.data.name, index === 0 ? "Maria" : "João Pedro");
  }
});

test("voltar preserva dados, cancelar não altera cadastro confirmado", async () => {
  const f = await fixture(), c = f.context(); await f.service.start(c); await answer(f, c, ["1", "Novo Nome"]); await f.service.handleAnswer(c, "!voltar");
  let session = await f.flows.getActiveFlow("whatsapp", c.conversationId, c.userId); assert.equal(session.step, "name"); assert.equal(session.data.name, "Novo Nome");
  await f.service.handleAnswer(c, "!cancelar"); assert.equal(await f.registrations.getRegistrationByIdentity(c.userId), null);
});

test("salva, continua, recomeça e cancela rascunho sem substituição silenciosa", async () => {
  const f = await fixture(), c = f.context(); await f.service.start(c); await answer(f, c, validAnswers); assert.equal((await f.service.handleAnswer(c, "3")).status, "draft_saved");
  assert.equal(await f.service.hasActiveFlow(c), false); assert.equal((await f.service.start(c)).status, "draft_found"); assert.equal((await f.service.handleAnswer(c, "1")).status, "resumed");
  await f.service.handleAnswer(c, "3"); await f.service.start(c); await f.service.handleAnswer(c, "2"); assert.match(f.messages.at(-1), /CADASTRO DO TREINADOR/);
  await f.service.handleAnswer(c, "2");
  await f.service.start(c); await answer(f, c, validAnswers); await f.service.handleAnswer(c, "3"); await f.service.start(c); await f.service.handleAnswer(c, "3");
  assert.equal(await f.flows.getActiveFlow("whatsapp", c.conversationId, c.userId), null);
});

test("sessão expira em 30 minutos e usuários/conversas ficam isolados", async () => {
  const f = await fixture(), a = f.context("5511111111111", "chat-a"), b = f.context("5522222222222", "chat-b"); await f.service.start(a); await f.service.start(b); await f.service.handleAnswer(a, "1");
  assert.equal((await f.flows.getActiveFlow("whatsapp", "chat-b", b.userId)).step, "confirm_start");
  f.advance(30 * 60 * 1000 + 1); assert.equal(await f.service.hasActiveFlow(a), false); assert.equal(await f.service.hasActiveFlow(b), false);
});

test("registro legado é normalizado na consulta e listener continua único", async () => {
  const f = await fixture(); await f.registrations.upsertLegacyRegistration({ primaryIdentity: "5511777777777", nome: "Legado", nick: "LegacyGO", codigo: "123456789012", cidade: "BH" });
  assert.deepEqual((await f.registrations.getRegistrationByIdentity("5511777777777")).mainAccount, { nick: "LegacyGO", friendCode: "123456789012", team: null, level: null });
  const loader = await fsp.readFile(path.join(__dirname, "..", "src", "loader.js"), "utf8"); const created = await Promise.all(["services/registrationGuidedFlowService.js", "events/registrationGuidedFlowAnswer.js"].map(file => fsp.readFile(path.join(__dirname, "..", "src", file), "utf8")));
  assert.equal((loader.match(/client\.on\s*\(\s*["']message["']/g) || []).length, 1); assert.equal(/client\.on\s*\(/.test(created.join("\n")), false);
});
