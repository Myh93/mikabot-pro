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

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-secondary-"));
  const repository = createRegistrationRepository({ databaseDir: path.join(root, "db"), backupRoot: path.join(root, "backups") });
  const registrations = createRegistrationService({ repository });
  const flows = createGuidedFlowService({ filePath: path.join(root, "flows.json"), ttlMs: 1_800_000 });
  const guided = createRegistrationGuidedFlowService({ guidedFlowService: flows, registrationService: registrations });
  const messages = [], context = { platform: "whatsapp", conversationId: "5511999999999", groupId: "5511999999999", userId: "5511999999999", identity: { id: "5511999999999", candidates: ["5511999999999"] }, isGroup: false, replyText: async text => messages.push(String(text)) };
  return { root, repository, registrations, flows, guided, messages, context };
}
const primary = { primaryIdentity: "5511999999999", name: "João", nick: "PrincipalGO", friendCode: "111122223333", city: "Sousa", mainAccount: { nick: "PrincipalGO", friendCode: "111122223333", team: "mystic", level: 50 }, secondaryAccounts: [] };
const secondary = index => ({ nick: `Conta ${index}`, friendCode: String(200000000000 + index), team: index % 2 ? "valor" : "instinct", level: index + 1 });

test("registro sem secundárias e legado continuam normalizados", async () => {
  const f = await fixture(); await f.registrations.upsertLegacyRegistration({ primaryIdentity: "5511888888888", nome: "Legado", nick: "Legacy", codigo: "999988887777", cidade: "BH" });
  assert.deepEqual((await f.registrations.getRegistrationByIdentity("5511888888888")).secondaryAccounts, []);
  const saved = await f.registrations.upsertRegistration(primary); assert.deepEqual(saved.secondaryAccounts, []);
});

test("adiciona uma, várias e dezenas de contas com IDs únicos", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(primary);
  const created = []; for (let index = 1; index <= 30; index += 1) created.push(await f.registrations.addSecondaryAccount(primary.primaryIdentity, secondary(index)));
  assert.equal(new Set(created.map(item => item.accountId)).size, 30); assert.equal(created[0].accountId, "ACC000001"); assert.equal(created[29].accountId, "ACC000030");
  assert.equal((await f.registrations.listAccounts(primary.primaryIdentity)).secondaryAccounts.length, 30);
});

test("rejeita Nick e Friend Code repetidos dentro do treinador", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(primary); await f.registrations.addSecondaryAccount(primary.primaryIdentity, secondary(1));
  await assert.rejects(() => f.registrations.addSecondaryAccount(primary.primaryIdentity, { ...secondary(2), nick: "conta 1" }), /Nick duplicado/);
  await assert.rejects(() => f.registrations.addSecondaryAccount(primary.primaryIdentity, { ...secondary(2), friendCode: secondary(1).friendCode }), /Friend Code duplicado/);
  await assert.rejects(() => f.registrations.addSecondaryAccount(primary.primaryIdentity, { ...secondary(2), nick: "PrincipalGO" }), /Nick duplicado/);
});

test("índice impede Friend Code duplicado entre treinadores", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(primary); await f.registrations.addSecondaryAccount(primary.primaryIdentity, secondary(1));
  await f.registrations.upsertRegistration({ ...primary, primaryIdentity: "5521888888888", nick: "Outro", friendCode: "444455556666", mainAccount: { ...primary.mainAccount, nick: "Outro", friendCode: "444455556666" } });
  await assert.rejects(() => f.registrations.addSecondaryAccount("5521888888888", { ...secondary(3), friendCode: secondary(1).friendCode }), /duplicado/);
});

test("edita, remove e nunca reutiliza accountId", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(primary); const first = await f.registrations.addSecondaryAccount(primary.primaryIdentity, secondary(1));
  const edited = await f.registrations.updateSecondaryAccount(primary.primaryIdentity, first.accountId, { nick: "Conta Editada", level: 999 }); assert.equal(edited.level, 999);
  await f.registrations.removeSecondaryAccount(primary.primaryIdentity, first.accountId); assert.equal((await f.registrations.listAccounts(primary.primaryIdentity)).secondaryAccounts.length, 0);
  const next = await f.registrations.addSecondaryAccount(primary.primaryIdentity, secondary(2)); assert.equal(next.accountId, "ACC000002");
  await assert.rejects(() => f.registrations.removeSecondaryAccount(primary.primaryIdentity, "MAIN"), /não encontrada/);
});

async function answer(f, values) { for (const value of values) await f.guided.handleAnswer(f.context, value); }
const principalAnswers = ["1", "João", "PrincipalGO", "111122223333", "Mystic", "Sousa", "50", "não", "sim", "Noite"];
const privateAnswers = ["1", "1", "não"];

test("fluxo permite nenhuma, uma e várias secundárias antes da confirmação", async () => {
  const f = await fixture(); await f.guided.start(f.context); await answer(f, principalAnswers);
  assert.equal((await f.flows.getActiveFlow("whatsapp", f.context.conversationId, f.context.userId)).step, "secondary_offer", f.messages.slice(-8).join(" | "));
  await answer(f, ["sim", "Sec 1", "222233334444", "Valor", "51", "sim", "Sec 2", "555566667777", "Instinto", "100", "não", ...privateAnswers]);
  assert.match(f.messages.at(-1), /Sec 1/); assert.match(f.messages.at(-1), /Sec 2/);
  const result = await f.guided.handleAnswer(f.context, "confirmar"); assert.equal(result.status, "finished");
  const saved = await f.registrations.getRegistrationByIdentity(f.context.userId); assert.equal(saved.secondaryAccounts.length, 2); assert.ok(saved.secondaryAccounts.every(item => /^ACC\d{6}$/.test(item.accountId)));
});

test("revisão adiciona, edita e remove secundária sem remover principal", async () => {
  const f = await fixture(); await f.guided.start(f.context); await answer(f, [...principalAnswers, "não", ...privateAnswers]);
  await answer(f, ["adicionar conta", "Sec", "222233334444", "Valor", "40", "não"]);
  await answer(f, ["editar conta secundária", "1", "1", "Sec Editada"]); assert.match(f.messages.at(-1), /Sec Editada/);
  await answer(f, ["remover conta secundária", "1"]); assert.match(f.messages.at(-1), /secundárias: nenhuma/);
  await f.guided.handleAnswer(f.context, "5"); const saved = await f.registrations.getRegistrationByIdentity(f.context.userId); assert.equal(saved.mainAccount.nick, "PrincipalGO"); assert.equal(saved.secondaryAccounts.length, 0);
});

test("cancelamento não persiste contas coletadas", async () => {
  const f = await fixture(); await f.guided.start(f.context); await answer(f, [...principalAnswers, "sim", "Temporária", "222233334444", "Valor", "40"]); await f.guided.handleAnswer(f.context, "cancelar");
  assert.equal(await f.registrations.getRegistrationByIdentity(f.context.userId), null);
});

test("identityService continua expondo somente o Nick principal", async () => {
  const f = await fixture(); const saved = await f.registrations.upsertRegistration({ ...primary, secondaryAccounts: [secondary(1)] });
  const identity = require("../src/services/identityService"); const registrationService = { getRegistrationByIdentity: async () => saved };
  assert.equal(await identity.resolveDisplayName(primary.primaryIdentity, { registrationService }), "PrincipalGO");
});
