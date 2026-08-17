"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const path = require("node:path");
const os = require("node:os");
const { createModerationRepository } = require("../src/repositories/moderationRepository");
const { createModerationService } = require("../src/services/moderationService");
const { createGroupRulesService } = require("../src/services/groupRulesService");
const { createGroupRulesFlowService } = require("../src/services/groupRulesFlowService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createAutomationAdministrationService } = require("../src/services/automationAdministrationService");
const { createMenuRegistry } = require("../src/services/menuRegistry");

async function rulesFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rules-32-"));
  const repository = createModerationRepository({ dataDir: path.join(root, "moderation"), backupRoot: path.join(root, "backup") });
  const moderation = createModerationService({ repository, configurationService: null });
  const rules = createGroupRulesService({ moderationService: moderation, moderationRepository: repository });
  const guided = createGuidedFlowService({ filePath: path.join(root, "flows.json") });
  const flow = createGroupRulesFlowService({ guidedFlowService: guided, groupRulesService: rules });
  const replies = [];
  const context = { platform: "whatsapp", conversationId: "group@g.us", groupId: "group@g.us", userId: "admin@lid", isGroup: true, replyText: async text => replies.push(String(text)), chat: {} };
  return { root, repository, moderation, rules, flow, replies, context };
}

test("Fase 32 publica uma fonte oficial, cria versões e restaura sem apagar histórico", async () => {
  const f = await rulesFixture();
  assert.match((await f.rules.getRules(f.context)).value, /ainda não foram publicadas/);
  await f.rules.publishRules(f.context, "1. Respeitar todos.");
  await f.rules.publishRules(f.context, "1. Respeitar todos.\n2. Sem spam.");
  assert.equal((await f.rules.getRules(f.context)).value.includes("Sem spam"), true);
  assert.equal((await f.rules.listVersions(f.context)).length, 2);
  await f.rules.restoreVersion(f.context, 1);
  assert.equal((await f.rules.getRules(f.context)).value, "1. Respeitar todos.");
  assert.equal((await f.rules.listVersions(f.context)).length, 3);
});

test("Fase 32 revisa antes de publicar e falha externa preserva regra interna", async () => {
  const f = await rulesFixture();
  await f.flow.start(f.context);
  await f.flow.handleAnswer(f.context, "2");
  await f.flow.handleAnswer(f.context, "Regra oficial revisada");
  assert.match(f.replies.at(-1), /REVISÃO/);
  assert.match((await f.rules.getRules(f.context)).value, /ainda não foram publicadas/);
  await f.flow.handleAnswer(f.context, "4");
  await f.flow.handleAnswer(f.context, "1");
  assert.equal((await f.rules.getRules(f.context)).value, "Regra oficial revisada");
  assert.match(f.replies.at(-1), /fonte oficial interna foi preservada/);
});

test("Fases 33 a 37 expõem menus reais e nenhum placeholder em Warn ou Ban", async () => {
  const registry = createMenuRegistry({ sessionService: { openMenu: async (_, state) => state }, permissionService: { hasPermission: role => Boolean(role?.isAdmin) } });
  const role = { isAdmin: true };
  const context = { platform: "whatsapp", conversationId: "g@g.us", groupId: "g@g.us", userId: "a@lid", isGroup: true, replyText: async () => undefined };
  for (const id of ["admin", "admin.security", "admin.automations", "admin.warnings", "admin.bans", "admin.rules"]) {
    const opened = await registry.openMenu(id, context, role);
    assert.equal(opened.status, "opened");
    assert.doesNotMatch(opened.text, /Em desenvolvimento/);
  }
  assert.equal(registry.getMenu("admin.warnings").options[2].command, "resetwarn");
  assert.equal(registry.getMenu("admin.bans").options[1].command, "banidos");
  assert.equal(registry.getMenu("admin.security").options[0].menuId, "admin.warnings");
});

test("Fase 34 calcula status somente de fontes reais", async () => {
  const service = createAutomationAdministrationService({
    configurationService: { get: key => ({ "moderation.antiSpam.enabled": true, "moderation.antiFlood.enabled": false, "joinRequest.enabled": true, "events.scheduler.enabled": true, "quiz.enabled": false, "joinRequest.requireCompletedRegistration": true })[key] },
    moderationService: { getGroupConfig: async () => ({ settings: { antiLink: { enabled: true }, warnings: { enabled: true }, ban: { enabled: false } } }) },
    memberExperienceRepository: { getGroupConfig: async () => ({ welcome: { enabled: true }, farewell: { enabled: false } }) }
  });
  const items = await service.getStatus({ platform: "whatsapp", groupId: "g@g.us" });
  assert.equal(items.find(item => item.label === "Anti-spam").status, "✅ Ativo");
  assert.equal(items.find(item => item.label === "Anti-flood").status, "❌ Desativado");
  assert.equal(items.find(item => item.label === "Antilink").source, "moderationService");
  assert.equal(items.length, 12);
});

test("reset de warnings e desbanimento continuam operações independentes", async () => {
  const f = await rulesFixture();
  await f.moderation.addWarning({ groupId: "group@g.us", userId: "member@lid", actorId: "admin@lid", reason: "teste" });
  const ban = await f.moderation.banPlayer({ groupId: "group@g.us", targetId: "member@lid", actorId: "admin@lid", receiptId: "ban-1" });
  await f.moderation.resetWarnings({ groupId: "group@g.us", targetId: "member@lid", actorId: "admin@lid", actorRole: { isAdmin: true } });
  assert.equal(await f.moderation.getWarningCount("group@g.us", "member@lid"), 0);
  assert.equal(await f.moderation.isPlayerBanned("group@g.us", "member@lid"), true);
  await f.moderation.unbanPlayer({ banId: ban.ban.banId, actorId: "admin@lid" });
  assert.equal(await f.moderation.isPlayerBanned("group@g.us", "member@lid"), false);
  assert.equal((await f.repository.listHistory({ action: "ban_revoked" })).total, 1);
});
