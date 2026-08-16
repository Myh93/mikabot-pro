"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createRepository } = require("../src/repositories/raidRepository");
const { createRaidService } = require("../src/services/raidService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createRaidGuidedFlowService } = require("../src/services/raidGuidedFlowService");
const { createRaidGroupAccessService } = require("../src/services/raidGroupAccessService");
const { createRaidPokemonCatalogService } = require("../src/services/raidPokemonCatalogService");

async function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-raid-consolidation-"));
  const repository = createRepository(path.join(root, "raids.json"));
  const registrations = {
    listRegistrations: async () => [],
    getRegistrationByIdentity: async identity => {
      const value = JSON.stringify(identity);
      if (value.includes("111")) return { mainAccount: { nick: "MikaTreinador" }, name: "Nome Cadastro" };
      if (value.includes("222")) return { name: "Somente Nome" };
      return null;
    }
  };
  const raidService = createRaidService(repository, registrations);
  const groups = [
    { groupId: "a@g.us", name: "Grupo A", active: true },
    { groupId: "b@g.us", name: "Grupo B", active: true },
    { groupId: "c@g.us", name: "Grupo C", active: true }
  ];
  const chats = new Map(groups.map(group => [group.groupId, {
    id: { _serialized: group.groupId },
    isGroup: true,
    name: group.name,
    participants: [{ id: "111@lid" }, { id: "999999@c.us", isAdmin: true }]
  }]));
  const sent = [];
  const client = {
    info: { wid: "999999@c.us" },
    getChatById: async id => chats.get(id) || null,
    sendMessage: async (groupId, text) => {
      if (options.failGroup === groupId) throw new Error("send failed");
      sent.push({ groupId, text });
      return { id: { _serialized: `message-${groupId}-${sent.length}` } };
    }
  };
  const directory = {
    listActiveGroups: async () => groups,
    getGroupById: async id => groups.find(group => group.groupId === id) || null,
    formatGroupDisplayName: group => group.name
  };
  const permissions = {
    resolveRole: async () => ({ name: "member", rank: 0 }),
    hasPermission: () => true
  };
  const access = createRaidGroupAccessService({
    groupDirectoryService: directory,
    permissionService: permissions,
    maxGroups: 10
  });
  const guided = createGuidedFlowService({ filePath: path.join(root, "flows.json") });
  const flow = createRaidGuidedFlowService({
    guidedFlowService: guided,
    raidService,
    raidGroupAccessService: access,
    menuSessionService: { closeMenu: async () => true }
  });
  const replies = [];
  const context = {
    platform: "whatsapp", groupId: "111@lid", conversationId: "111@lid",
    userId: "111@lid", identity: { id: "111@lid" }, isGroup: false, client, replies,
    message: { from: "111@lid", getContact: async () => ({ id: { _serialized: "111@lid" } }) },
    replyText: async text => { replies.push(String(text)); return text; }
  };
  return { root, repository, raidService, flow, guided, access, groups, chats, client, sent, context, replies };
}

async function reachDestination(f) {
  await f.flow.start(f.context);
  for (const answer of ["PIKACHU", "-7.1,-38.5", "18:30", "45", "pular", "1"]) {
    await f.flow.handleAnswer(f.context, answer);
  }
  return f.guided.getActiveFlow("whatsapp", "111@lid", "111@lid");
}

test("catálogo central de Raid reconhece Pikachu, caixa, espaços, Rayquaza e Mega Gengar", () => {
  const catalog = createRaidPokemonCatalogService();
  assert.equal(catalog.resolve("Pikachu"), "Pikachu");
  assert.equal(catalog.resolve("PIKACHU"), "Pikachu");
  assert.equal(catalog.resolve("  pikachu  "), "Pikachu");
  assert.equal(catalog.resolve("Rayquaza"), "Rayquaza");
  assert.equal(catalog.resolve("Mega Gengar"), "Mega Gengar");
  assert.equal(catalog.resolve("nome inexistente"), null);
});

test("grupo autorizado exige diretório ativo, participação do usuário e presença do bot", async () => {
  const f = await fixture();
  assert.deepEqual((await f.access.listAuthorizedGroups(f.client, "111@lid")).map(group => group.id), ["a@g.us", "b@g.us", "c@g.us"]);
  f.chats.get("b@g.us").participants = [{ id: "999999@c.us" }];
  f.chats.get("c@g.us").isReadOnly = true;
  assert.deepEqual((await f.access.listAuthorizedGroups(f.client, "111@lid")).map(group => group.id), ["a@g.us"]);
});

test("seleção aceita um, vários, intervalos e elimina duplicados", async () => {
  const f = await fixture();
  const groups = [{ name: "A" }, { name: "B" }, { name: "C" }];
  assert.deepEqual(f.flow.parseGroupSelection("2", groups, false), [groups[1]]);
  assert.deepEqual(f.flow.parseGroupSelection("A", groups, false), [groups[0]]);
  assert.deepEqual(f.flow.parseGroupSelection("1,3,1", groups, true), [groups[0], groups[2]]);
  assert.deepEqual(f.flow.parseGroupSelection("1-3", groups, true), groups);
  assert.equal(f.flow.parseGroupSelection("1,9", groups, true), null);
});

test("privado escolhe um grupo e cria/publica uma única Raid central", async () => {
  const f = await fixture();
  assert.equal((await reachDestination(f)).step, "destination_mode");
  await f.flow.handleAnswer(f.context, "1");
  await f.flow.handleAnswer(f.context, "Grupo A");
  const result = await f.flow.handleAnswer(f.context, "confirmar");
  assert.equal(result.status, "created");
  assert.equal(Object.keys(f.repository.loadDatabase().raids).length, 1);
  assert.deepEqual(result.raid.publishedGroupIds, ["a@g.us"]);
  assert.deepEqual(f.sent.map(item => item.groupId), ["a@g.us"]);
});

test("fluxo iniciado no grupo usa e publica automaticamente no grupo atual", async () => {
  const f = await fixture();
  const replies = [];
  const groupContext = {
    ...f.context,
    groupId: "a@g.us",
    conversationId: "a@g.us",
    isGroup: true,
    message: { from: "a@g.us", author: "111@lid" },
    replies,
    replyText: async text => { replies.push(String(text)); return text; }
  };
  await f.flow.start(groupContext);
  for (const answer of ["Pikachu", "-7,-38", "18:30", "45", "5", "1"]) {
    await f.flow.handleAnswer(groupContext, answer);
  }
  const [raid] = f.repository.listActiveRaids("a@g.us");
  assert.ok(raid);
  assert.deepEqual(raid.publishedGroupIds, ["a@g.us"]);
  assert.deepEqual(f.sent.map(item => item.groupId), ["a@g.us"]);
  assert.doesNotMatch(replies.join("\n"), /ONDE DESEJA PUBLICAR/);
});

test("privado seleciona vários grupos sem duplicar Raid nem publicação", async () => {
  const f = await fixture();
  await reachDestination(f);
  await f.flow.handleAnswer(f.context, "2");
  await f.flow.handleAnswer(f.context, "1,3,1");
  const result = await f.flow.handleAnswer(f.context, "1");
  assert.equal(Object.keys(f.repository.loadDatabase().raids).length, 1);
  assert.deepEqual(result.raid.publishedGroupIds, ["a@g.us", "c@g.us"]);
  assert.equal(result.raid.id, f.repository.getPublishedRaidByGroup("c@g.us")[0].id);
});

test("todos os grupos exige confirmação explícita", async () => {
  const f = await fixture();
  await reachDestination(f);
  const selection = await f.flow.handleAnswer(f.context, "3");
  assert.equal(selection.session.step, "destination_confirm");
  assert.equal(Object.keys(f.repository.loadDatabase().raids).length, 0);
  const result = await f.flow.handleAnswer(f.context, "1");
  assert.equal(result.publication.successes.length, 3);
  assert.equal(Object.keys(f.repository.loadDatabase().raids).length, 1);
});

test("cancelar ou perder todos os acessos antes da confirmação não cria Raid", async () => {
  const cancelled = await fixture();
  await reachDestination(cancelled);
  await cancelled.flow.handleAnswer(cancelled.context, "cancelar");
  assert.equal(Object.keys(cancelled.repository.loadDatabase().raids).length, 0);

  const denied = await fixture();
  await reachDestination(denied);
  await denied.flow.handleAnswer(denied.context, "1");
  await denied.flow.handleAnswer(denied.context, "1");
  denied.chats.get("a@g.us").participants = [];
  assert.equal((await denied.flow.handleAnswer(denied.context, "1")).status, "denied");
  assert.equal(Object.keys(denied.repository.loadDatabase().raids).length, 0);
});

test("alterar seleção retorna ao modo sem criar", async () => {
  const f = await fixture();
  await reachDestination(f);
  await f.flow.handleAnswer(f.context, "1");
  await f.flow.handleAnswer(f.context, "1");
  const altered = await f.flow.handleAnswer(f.context, "2");
  assert.equal(altered.session.step, "destination_mode");
  assert.equal(Object.keys(f.repository.loadDatabase().raids).length, 0);
});

test("falha parcial mantém Raid central e registra somente publicações bem-sucedidas", async () => {
  const f = await fixture({ failGroup: "b@g.us" });
  await reachDestination(f);
  await f.flow.handleAnswer(f.context, "3");
  const result = await f.flow.handleAnswer(f.context, "1");
  assert.equal(result.publication.successes.length, 2);
  assert.equal(result.publication.failures.length, 1);
  assert.deepEqual(result.raid.publishedGroupIds, ["a@g.us", "c@g.us"]);
  assert.equal(f.repository.getPublishedRaidByGroup("b@g.us").length, 0);
});

test("publicação é idempotente por Raid e grupo", async () => {
  const f = await fixture();
  const created = await f.raidService.createRaidFromMessage(f.context.message, { name: "Pikachu", groupId: "a@g.us" });
  const first = await f.raidService.publishRaidToGroups(f.client, created.raid, [{ id: "a@g.us", name: "A" }]);
  const second = await f.raidService.publishRaidToGroups(f.client, created.raid, [{ id: "a@g.us", name: "A" }]);
  assert.equal(first.successes.length, 1);
  assert.equal(second.successes[0].skipped, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.repository.getRaidById(created.raid.id).publications.length, 1);
});

test("listagem privada consulta um, vários ou todos sem misturar grupos", async () => {
  const f = await fixture();
  const a = await f.raidService.createRaidFromMessage(f.context.message, { name: "Pikachu", groupId: "a@g.us", startTime: "18:30" });
  const b = await f.raidService.createRaidFromMessage(f.context.message, { name: "Rayquaza", groupId: "b@g.us", startTime: "19:00" });
  await f.raidService.publishRaidToGroups(f.client, a.raid, [{ id: "a@g.us", name: "Grupo A" }]);
  await f.raidService.publishRaidToGroups(f.client, b.raid, [{ id: "b@g.us", name: "Grupo B" }]);

  await f.flow.startList(f.context);
  await f.flow.handleAnswer(f.context, "1");
  await f.flow.handleAnswer(f.context, "1");
  assert.match(f.replies.at(-1), /GRUPO A[\s\S]*Pikachu/i);
  assert.doesNotMatch(f.replies.at(-1), /Rayquaza/i);

  await f.flow.startList(f.context);
  await f.flow.handleAnswer(f.context, "2");
  await f.flow.handleAnswer(f.context, "1;2");
  assert.match(f.replies.at(-1), /GRUPO A[\s\S]*GRUPO B/);
});

test("nome público prioriza Nick, nome e fallback sem criar wa.me ou expor LID", async () => {
  const f = await fixture();
  const text = await f.raidService.formatCreatedRaid({ id: "R1", name: "pikachu", participants: ["111@lid", "222@lid", "999@lid"] });
  assert.match(text, /MikaTreinador/);
  assert.match(text, /Somente Nome/);
  assert.match(text, /Treinador/);
  assert.doesNotMatch(text, /wa\.me|@lid|@c\.us|@g\.us|999/);
});

test("migração v2 cria backup e preserva Raid antiga como publicação única", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-raid-v2-"));
  const file = path.join(root, "raids.json");
  fs.writeFileSync(file, JSON.stringify({
    version: 2, nextId: 1025,
    raids: { R1024: { id: "R1024", name: "pikachu", groupId: "a@g.us", messageId: "m1", participants: [], status: "published", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } },
    messageIndex: { m1: "R1024" }
  }));
  const repository = createRepository(file);
  const raid = repository.getRaidById("R1024");
  assert.equal(repository.loadDatabase().version, 3);
  assert.deepEqual(raid.publishedGroupIds, ["a@g.us"]);
  assert.equal(raid.publications[0].messageId, "m1");
  assert.equal(fs.readdirSync(root).some(name => name.startsWith("raids.backup-v2-")), true);
});
