"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const { createRegistrationStateService, STATES } = require("../src/services/registrationStateService");
const { createRegistrationAccessService } = require("../src/services/registrationAccessService");
const { createRegistrationRepository } = require("../src/repositories/registrationRepository");
const { createRegistrationService } = require("../src/services/registrationService");
const { createRegistrationAdministrationService } = require("../src/services/registrationAdministrationService");
const { createRegistrationPublicQueryService } = require("../src/services/registrationPublicQueryService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createRegistrationGuidedFlowService } = require("../src/services/registrationGuidedFlowService");

const context = { platform: "whatsapp", conversationId: "private", groupId: null, userId: "user@lid", identity: { candidates: ["user@lid"] } };
function stateFixture(overrides = {}) {
  const registration = overrides.registration;
  return createRegistrationStateService({
    registrationService: { getRegistrationByIdentity: async () => registration || null },
    guidedFlowService: { getActiveFlow: async () => overrides.flow || null },
    joinRequestRepository: { listRequests: async () => overrides.requests || [] },
    memberLifecycleRepository: { getMember: async () => overrides.member || null },
    disciplineService: { isBlocked: async () => ({ blocked: Boolean(overrides.banned), reason: overrides.banned ? "community_ban" : null }) }
  });
}

test("estado central distingue sem cadastro, rascunho, ativo, revalidação e ban", async () => {
  assert.equal((await stateFixture().resolveRegistrationState(context)).state, STATES.NONE);
  assert.equal((await stateFixture({ flow: { flowId: "registration" } }).resolveRegistrationState(context)).state, STATES.DRAFT);
  assert.equal((await stateFixture({ registration: { status: "active", validationStatus: "valid" } }).resolveRegistrationState(context)).state, STATES.ACTIVE);
  assert.equal((await stateFixture({ registration: { status: "active" }, requests: [{ userIdentity: "user@lid", status: "revalidation_required" }] }).resolveRegistrationState(context)).state, STATES.REQUIRES_REVALIDATION);
  assert.equal((await stateFixture({ registration: { status: "active" }, banned: true }).resolveRegistrationState(context)).state, STATES.BANNED);
});

test("gate bloqueia função de membro e preserva exceções essenciais", async () => {
  const blocked = createRegistrationAccessService({ registrationStateService: { STATES, resolveRegistrationState: async () => ({ state: STATES.NONE }) } });
  assert.equal((await blocked.authorize(context, { name: "quiz" }, "quiz")).allowed, false);
  assert.equal((await blocked.authorize(context, { name: "pokemon" }, "cadastro")).allowed, true);
  assert.equal((await blocked.authorize(context, { name: "util" }, "regras")).allowed, true);
  const allowed = createRegistrationAccessService({ registrationStateService: { STATES, resolveRegistrationState: async () => ({ state: STATES.ACTIVE }) } });
  assert.equal((await allowed.authorize(context, { name: "quiz" }, "quiz")).allowed, true);
});

async function persistentFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-reg-block-"));
  const repository = createRegistrationRepository({ databaseDir: path.join(root, "db"), backupRoot: path.join(root, "backups") });
  const registrations = createRegistrationService({ repository });
  const base = { primaryIdentity: "5511999999999", name: "Ana", nick: "AnaGO", friendCode: "123456789012", city: "Sousa", mainAccount: { nick: "AnaGO", friendCode: "123456789012", team: "mystic", level: 50 }, playStyle: { fly: true, canela: false }, playSchedule: "Noite" };
  await registrations.upsertRegistration(base);
  return { root, repository, registrations, base };
}

test("edição administrativa altera só o campo e registra auditoria sanitizada", async () => {
  const f = await persistentFixture();
  const admin = createRegistrationAdministrationService({ registrationService: f.registrations, repository: f.repository });
  await admin.updateField("AnaGO", "city", "Recife", { executor: "5511888888888@c.us", reason: "Solicitação confirmada" });
  const saved = await f.registrations.getRegistrationByIdentity(f.base.primaryIdentity);
  assert.equal(saved.city, "Recife"); assert.equal(saved.mainAccount.nick, "AnaGO"); assert.equal(saved.playSchedule, "Noite");
  const history = await admin.history("AnaGO"); const audit = history.at(-1);
  assert.equal(audit.action, "administrative_field_updated"); assert.equal(audit.details.field, "city");
  assert.doesNotMatch(JSON.stringify(audit.details), /5511888888888|@c\.us/);
  const command = require("../src/commands/registrationAdministration"); assert.equal(command.adminOnly, true);
});

test("consulta encontra nome, Nick e Friend Code e nunca mostra Nick/Friend Code privados", async () => {
  const f = await persistentFixture();
  await f.registrations.updatePrivacy(f.base.primaryIdentity, { showNick: false, showFriendCode: false });
  const queries = createRegistrationPublicQueryService({ registrationService: f.registrations });
  for (const value of ["Ana", "AnaGO", "1234 5678 9012"]) {
    const found = await queries.findPublicTrainer(value, "outro@lid");
    assert.equal(found.status, "found"); assert.equal(found.trainer.mainAccount.nick, "Nick privado"); assert.equal(found.trainer.canViewFriendCode, false);
    const rendered = queries.formatTrainerProfile(found.trainer); assert.doesNotMatch(rendered, /AnaGO|1234 5678 9012/);
  }
  const own = await queries.getPublicTrainer(f.base.primaryIdentity, f.base.primaryIdentity);
  assert.equal(own.trainer.mainAccount.nick, "AnaGO"); assert.equal(own.trainer.canViewFriendCode, true);
});

test("cadastro ativo abre manutenção e recomendação aparece somente na privacidade", async () => {
  const f = await persistentFixture();
  const flows = createGuidedFlowService({ filePath: path.join(f.root, "flows.json"), ttlMs: 1_800_000 });
  const guided = createRegistrationGuidedFlowService({ guidedFlowService: flows, registrationService: f.registrations });
  const messages = [], ctx = { ...context, conversationId: f.base.primaryIdentity, userId: f.base.primaryIdentity, identity: { candidates: [f.base.primaryIdentity] }, isGroup: false, replyText: async text => messages.push(String(text)) };
  const opened = await guided.start(ctx); assert.equal(opened.status, "started"); assert.match(messages.at(-1), /Cadastro ativo/); assert.doesNotMatch(messages.at(-1), /Vamos começar/);
  await guided.handleAnswer(ctx, "privacidade"); await guided.handleAnswer(ctx, "nick");
  assert.match(messages.at(-1), /Recomendado: Visível/);
});

test("registro antigo permanece legível sem regravação destrutiva", async () => {
  const f = await persistentFixture(); const before = await f.repository.getRegistrationById("REG000001");
  const normalized = await f.registrations.getRegistrationByIdentity(f.base.primaryIdentity);
  assert.equal(normalized.privacy.showNick, undefined); assert.equal(normalized.mainAccount.nick, "AnaGO");
  const after = await f.repository.getRegistrationById("REG000001"); assert.deepEqual(after, before);
});
