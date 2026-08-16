"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createEventGuidedFlowService } = require("../src/services/eventGuidedFlowService");
const { createEventRepository } = require("../src/repositories/eventRepository");
const { createEventService } = require("../src/services/eventService");
const { createMenuSessionService } = require("../src/services/menuSessionService");
const { createEventsCommand, ALIASES } = require("../src/commands/events");
const { createGroupDirectoryService } = require("../src/services/groupDirectoryService");

const BASE = Date.parse("2026-07-16T15:00:00.000Z");
const member = { name: "member", isAdmin: false, isOwner: false, isProtectedOwner: false };
const owner = { name: "owner", isAdmin: true, isOwner: true, isProtectedOwner: false };

async function fixture(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-guided-"));
  let now = BASE;
  const repository = createEventRepository({ databaseDir: path.join(root, "events"), backupRoot: path.join(root, "backups") });
  const eventService = createEventService({ repository, clock: () => new Date(now) });
  const flowService = createGuidedFlowService({ filePath: path.join(root, "flows.json"), clock: () => new Date(now), ttlMs: 15 * 60 * 1000 });
  const menuSessions = createMenuSessionService({ filePath: path.join(root, "menus.json"), clock: () => new Date(now) });
  const groupDirectory = createGroupDirectoryService({ filePath: path.join(root, "groups.json"), clock: () => new Date(now), warn: () => undefined });
  const replies = [];
  const sent = [];
  const chats = [
    { isGroup: true, name: "Grupo A", id: { _serialized: "group-a@g.us" }, participants: [{ id: "111@c.us", isAdmin: false }] },
    { isGroup: true, name: "Grupo B", id: { _serialized: "group-b@g.us" }, participants: [{ id: "111@c.us", isAdmin: true }] },
    { isGroup: true, name: "Grupo C", id: { _serialized: "group-c@g.us" }, participants: [{ id: "222@c.us", isAdmin: true }] }
  ];
  if (options.seedDirectory !== false) for (const chat of chats) await groupDirectory.upsertGroup({ groupId: chat.id._serialized, name: chat.name, source: "message" });
  const client = {
    getChats: async () => chats,
    getChatById: async (groupId) => chats.find((chat) => chat.id._serialized === groupId) || null,
    sendMessage: async (groupId, text) => { sent.push({ groupId, text }); return { id: "m1" }; }
  };
  const guided = createEventGuidedFlowService({ guidedFlowService: flowService, eventService, menuSessionService: menuSessions, groupDirectoryService: groupDirectory, warn: () => undefined });
  const context = {
    platform: "whatsapp", conversationId: "111@c.us", groupId: "111@c.us", userId: "111@c.us", identity: { id: "111@c.us" }, isGroup: false,
    replyText: async (text) => { replies.push(String(text)); return text; }
  };
  return { root, repository, eventService, flowService, menuSessions, groupDirectory, replies, sent, chats, client, guided, context, setNow: (value) => { now = value; } };
}

const cleanup = (root) => fsp.rm(root, { recursive: true, force: true });

async function answer(f, text, context = f.context) { return f.guided.handleAnswer(f.client, context, text); }

async function reachReview(f, choices = {}) {
  await f.guided.startCreateFlow(f.client, f.context, choices.role || member);
  for (const value of [choices.group || "1", choices.title || "Quiz de Hoje", choices.description || "Vai ter quiz", choices.date || "hoje", choices.time || "20h", choices.type || "1", choices.endChoice || "2", choices.prizeChoice || "2", choices.notices || "3"]) await answer(f, value);
  return f.flowService.getActiveFlow("whatsapp", "111@c.us", "111@c.us");
}

test("inicia no privado, lista apenas grupos seguros e owner vê todos", async () => {
  const f = await fixture();
  try {
    const started = await f.guided.startCreateFlow(f.client, f.context, member);
    assert.equal(started.status, "started");
    assert.match(f.replies[0], /Grupo A[\s\S]*Grupo B/);
    assert.equal(f.replies[0].includes("Grupo C"), false);
    await f.flowService.cancelFlow("whatsapp", "111@c.us", "111@c.us");
    await f.guided.startCreateFlow(f.client, f.context, owner);
    assert.match(f.replies.at(-1), /Grupo A[\s\S]*Grupo B[\s\S]*Grupo C/);
  } finally { await cleanup(f.root); }
});

test("usuário sem grupos recebe mensagem exata", async () => {
  const f = await fixture({ seedDirectory: false });
  try {
    assert.equal((await f.guided.startCreateFlow(f.client, f.context, member)).status, "empty");
    assert.equal(f.replies[0], "📂 Ainda não encontrei nenhum grupo.\n\nEnvie qualquer comando do MikaBot dentro do grupo desejado e tente novamente no privado.");
  } finally { await cleanup(f.root); }
});

test("admin dinâmico é marcado somente no grupo autorizado", async () => {
  const f = await fixture();
  try {
    const groups = await f.guided.listManageableGroups(f.client, { id: "111@c.us", role: member });
    assert.equal(groups.find((group) => group.id === "group-a@g.us").isAdmin, false);
    assert.equal(groups.find((group) => group.id === "group-b@g.us").isAdmin, true);
  } finally { await cleanup(f.root); }
});

test("fluxo completo valida grupo, tipo, título, descrição, hoje e 20h", async () => {
  const f = await fixture();
  try {
    const session = await reachReview(f);
    assert.equal(session.step, "review");
    assert.equal(session.data.groupId, "group-a@g.us");
    assert.equal(session.data.type, "quiz");
    assert.equal(session.data.title, "Quiz de Hoje");
    assert.equal(session.data.description, "Vai ter quiz");
    assert.deepEqual(session.data.noticeKeys, ["1h", "30m", "10m", "start", "end"]);
    assert.match(f.replies.at(-1), /REVISÃO DO EVENTO[\s\S]*Grupo A[\s\S]*Quiz de Hoje/);
  } finally { await cleanup(f.root); }
});

test("aceita amanhã, 20h30, término e prêmio", async () => {
  const f = await fixture();
  try {
    await f.guided.startCreateFlow(f.client, f.context, member);
    for (const value of ["1", "Evento", "Descrição", "amanhã", "20h30", "7", "1", "17/07/2026", "22h", "1", "Pikachu Shiny", "4"]) await answer(f, value);
    const session = await f.flowService.getActiveFlow("whatsapp", "111@c.us", "111@c.us");
    assert.equal(session.step, "review");
    assert.equal(session.data.endTime, "22h");
    assert.equal(session.data.prize, "Pikachu Shiny");
    assert.deepEqual(session.data.noticeKeys.slice(0, 4), ["24h", "1h", "30m", "10m"]);
  } finally { await cleanup(f.root); }
});

test("término inválido mantém etapa e dados anteriores", async () => {
  const f = await fixture();
  try {
    await f.guided.startCreateFlow(f.client, f.context, member);
    for (const value of ["1", "Evento", "Descrição", "17/07/2026", "20h", "1", "1", "16/07/2026"]) await answer(f, value);
    assert.equal((await answer(f, "19h")).status, "validation_error");
    const session = await f.flowService.getActiveFlow("whatsapp", "111@c.us", "111@c.us");
    assert.equal(session.step, "end_time");
    assert.equal(session.data.title, "Evento");
    assert.match(f.replies.at(-1), /término não pode ser anterior/);
  } finally { await cleanup(f.root); }
});

test("salva rascunho e agenda usando eventService", async () => {
  const f = await fixture();
  try {
    await reachReview(f);
    const draft = await answer(f, "1");
    assert.equal(draft.event.status, "draft");
    assert.equal(await f.flowService.getActiveFlow("whatsapp", "111@c.us", "111@c.us"), null);
    await reachReview(f, { title: "Agendado" });
    const scheduled = await answer(f, "2");
    assert.equal(scheduled.event.status, "scheduled");
    assert.match(f.replies.at(-1), /EVENTO CRIADO COM SUCESSO/);
  } finally { await cleanup(f.root); }
});

test("agenda e publica, confirmando somente no privado", async () => {
  const f = await fixture();
  try {
    await reachReview(f);
    const result = await answer(f, "3");
    assert.equal(result.published, true);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].groupId, "group-a@g.us");
    assert.equal(f.sent[0].text.includes("EVENTO SALVO"), false);
    assert.match(f.replies.at(-1), /também foi enviado ao grupo/);
  } finally { await cleanup(f.root); }
});

test("permite editar antes de salvar e retorna à revisão", async () => {
  const f = await fixture();
  try {
    await reachReview(f);
    await answer(f, "4"); await answer(f, "1"); await answer(f, "Título corrigido");
    const session = await f.flowService.getActiveFlow("whatsapp", "111@c.us", "111@c.us");
    assert.equal(session.step, "review");
    assert.equal(session.data.title, "Título corrigido");
  } finally { await cleanup(f.root); }
});

test("cancelar, sair e voltar controlam sessão sem salvar", async () => {
  const f = await fixture();
  try {
    await f.guided.startCreateFlow(f.client, f.context, member); await answer(f, "1");
    assert.equal((await f.guided.handleControl("voltar", f.context)).status, "back");
    assert.equal((await f.flowService.getActiveFlow("whatsapp", "111@c.us", "111@c.us")).step, "select_group");
    await f.guided.handleControl("cancelar", f.context);
    assert.equal((await f.repository.listEvents({ includeArchived: true })).length, 0);
    await f.guided.startCreateFlow(f.client, f.context, member);
    await f.guided.handleControl("sair", f.context);
    assert.equal(await f.flowService.getActiveFlow("whatsapp", "111@c.us", "111@c.us"), null);
  } finally { await cleanup(f.root); }
});

test("conflito não substitui fluxo silenciosamente e menu é fechado", async () => {
  const f = await fixture();
  try {
    await f.menuSessions.openMenu({ menuId: "events_private", platform: "whatsapp", groupId: "111@c.us", userId: "111@c.us", options: {} });
    await f.guided.startCreateFlow(f.client, f.context, member);
    assert.equal(await f.menuSessions.getActiveMenu("whatsapp", "111@c.us", "111@c.us"), null);
    assert.equal((await f.guided.startCreateFlow(f.client, f.context, member)).status, "conflict");
    assert.match(f.replies.at(-1), /já possui um fluxo/);
  } finally { await cleanup(f.root); }
});

test("expira em 15 minutos, renova e isola usuário e conversa", async () => {
  const f = await fixture();
  try {
    await f.guided.startCreateFlow(f.client, f.context, member);
    f.setNow(BASE + 14 * 60 * 1000); await answer(f, "1");
    f.setNow(BASE + 20 * 60 * 1000);
    assert.ok(await f.flowService.getActiveFlow("whatsapp", "111@c.us", "111@c.us"));
    const other = { ...f.context, conversationId: "222@c.us", groupId: "222@c.us", userId: "222@c.us", identity: { id: "222@c.us" } };
    assert.equal(await f.guided.hasActiveFlow(other), false);
    f.setNow(BASE + 30 * 60 * 1000);
    assert.equal(await f.flowService.getActiveFlow("whatsapp", "111@c.us", "111@c.us"), null);
  } finally { await cleanup(f.root); }
});

test("edição guiada altera título pelo mesmo eventService", async () => {
  const f = await fixture();
  try {
    const event = await f.repository.createEvent({ title: "Original", type: "custom", platform: "whatsapp", groupId: "group-a@g.us", creatorId: "111@c.us", status: "draft" });
    await f.guided.startActionFlow("edit_event", f.client, f.context, member);
    await answer(f, "1"); await answer(f, "1"); await answer(f, "Novo título"); await answer(f, "1"); await answer(f, "10");
    assert.equal((await f.repository.getEventById(event.id)).title, "Novo título");
    assert.match(f.replies.at(-1), /Edição concluída/);
  } finally { await cleanup(f.root); }
});

test("publicação, cancelamento e finalização guiados enviam somente mensagens relevantes ao grupo", async () => {
  const f = await fixture();
  try {
    const publish = await f.repository.createEvent({ title: "Publicar", type: "custom", platform: "whatsapp", groupId: "group-a@g.us", creatorId: "111@c.us", status: "scheduled", startsAt: "2026-07-20T23:00:00.000Z" });
    await f.guided.startActionFlow("publish_event", f.client, f.context, member); await answer(f, "1"); await answer(f, "1");
    assert.equal((await f.repository.getEventById(publish.id)).status, "published");
    await f.guided.startActionFlow("cancel_event", f.client, f.context, member); await answer(f, "1"); await answer(f, "1");
    assert.equal((await f.repository.getEventById(publish.id)).status, "cancelled");
    assert.equal(f.sent.some((message) => message.text.includes("EVENTO CANCELADO")), true);
    const finish = await f.repository.createEvent({ title: "Finalizar", type: "custom", platform: "whatsapp", groupId: "group-a@g.us", creatorId: "111@c.us", status: "published", startsAt: "2026-07-20T23:00:00.000Z" });
    await f.guided.startActionFlow("finish_event", f.client, f.context, member); await answer(f, "1"); await answer(f, "1");
    assert.equal((await f.repository.getEventById(finish.id)).status, "finished");
    assert.equal(f.sent.some((message) => message.text.includes("EVENTO ENCERRADO")), true);
  } finally { await cleanup(f.root); }
});

test("comando privado inicia fluxo e comando de grupo permanece direto", async () => {
  const f = await fixture();
  try {
    const menuRegistry = { openMenuFromCommand: async () => undefined, resolveRole: async () => member };
    const permissionService = { resolveRole: async () => member };
    const command = createEventsCommand({ eventService: f.eventService, eventGuidedFlow: f.guided, menuRegistry, permissionService });
    let getChatsCalls = 0;
    f.client.getChats = async () => { getChatsCalls += 1; throw new Error("r"); };
    const privateMsg = { from: "111@c.us", reply: f.context.replyText };
    await command.execute(f.client, privateMsg, [], { commandName: "criar evento", platformContext: f.context });
    assert.ok(await f.flowService.getActiveFlow("whatsapp", "111@c.us", "111@c.us"));
    await f.flowService.cancelFlow("whatsapp", "111@c.us", "111@c.us");
    const groupContext = { ...f.context, conversationId: undefined, groupId: "group-a@g.us", isGroup: true, replyText: f.context.replyText };
    await command.execute(f.client, { from: "group-a@g.us", reply: f.context.replyText }, ["Direto", "|", "Descrição", "|", "16/07/2026", "|", "20:00"], { commandName: "criar evento", platformContext: groupContext, role: member });
    assert.equal((await f.repository.listEvents({ groupId: "group-a@g.us" })).length, 1);
    assert.equal(getChatsCalls, 0);
  } finally { await cleanup(f.root); }
});

test("criação privada com argumentos inicia fluxo e nunca retorna groupOnly", async () => {
  const f = await fixture();
  try {
    const command = createEventsCommand({
      eventService: f.eventService, eventGuidedFlow: f.guided,
      menuRegistry: { openMenuFromCommand: async () => undefined, resolveRole: async () => member },
      permissionService: { resolveRole: async () => member }
    });
    await command.execute(
      f.client,
      { from: "111@c.us", reply: f.context.replyText },
      ["Quiz de Hoje", "|", "Vai ter quiz", "|", "amanhã", "|", "20h"],
      { commandName: "criar evento", platformContext: f.context }
    );
    assert.ok(await f.flowService.getActiveFlow("whatsapp", "111@c.us", "111@c.us"));
    assert.equal(f.replies.some((message) => message.includes("só pode ser usado em grupos")), false);
    assert.match(f.replies[0], /ESCOLHA O GRUPO/);
  } finally { await cleanup(f.root); }
});

test("listagens privadas são gerenciáveis e agrupadas, enquanto grupo permanece isolado", async () => {
  const f = await fixture();
  try {
    await f.repository.createEvent({ title: "Meu A", type: "custom", platform: "whatsapp", groupId: "group-a@g.us", creatorId: "111@c.us", status: "draft" });
    await f.repository.createEvent({ title: "Futuro B", type: "custom", platform: "whatsapp", groupId: "group-b@g.us", creatorId: "999@c.us", status: "scheduled", startsAt: "2026-07-20T23:00:00.000Z" });
    await f.repository.createEvent({ title: "Invisível C", type: "custom", platform: "whatsapp", groupId: "group-c@g.us", creatorId: "222@c.us", status: "scheduled", startsAt: "2026-07-20T23:00:00.000Z" });
    const command = createEventsCommand({
      eventService: f.eventService, eventGuidedFlow: f.guided,
      menuRegistry: { openMenuFromCommand: async () => undefined, resolveRole: async () => member },
      permissionService: { resolveRole: async () => member }
    });
    let getChatsCalls = 0;
    f.client.getChats = async () => { getChatsCalls += 1; throw new Error("r"); };
    const privateMsg = { from: "111@c.us", reply: f.context.replyText };
    await command.execute(f.client, privateMsg, [], { commandName: "listar eventos", platformContext: f.context });
    assert.match(f.replies.at(-1), /Grupo A[\s\S]*Meu A[\s\S]*Grupo B[\s\S]*Futuro B/);
    assert.equal(f.replies.at(-1).includes("Invisível C"), false);
    await command.execute(f.client, privateMsg, [], { commandName: "proximos eventos", platformContext: f.context });
    assert.match(f.replies.at(-1), /Grupo B[\s\S]*Futuro B/);
    assert.equal(f.replies.at(-1).includes("Meu A"), false);

    const groupContext = { ...f.context, groupId: "group-a@g.us", conversationId: undefined, isGroup: true };
    await command.execute(f.client, { from: "group-a@g.us", reply: f.context.replyText }, [], { commandName: "listar eventos", platformContext: groupContext, role: member });
    assert.match(f.replies.at(-1), /Meu A/);
    assert.equal(f.replies.at(-1).includes("Futuro B"), false);
    assert.equal(getChatsCalls, 0);
  } finally { await cleanup(f.root); }
});

test("consulta privada permite evento gerenciável e oculta evento sem autorização", async () => {
  const f = await fixture();
  try {
    const allowed = await f.repository.createEvent({ title: "Permitido", type: "custom", platform: "whatsapp", groupId: "group-a@g.us", creatorId: "111@c.us", status: "draft" });
    const denied = await f.repository.createEvent({ title: "Negado", type: "custom", platform: "whatsapp", groupId: "group-c@g.us", creatorId: "222@c.us", status: "draft" });
    const command = createEventsCommand({
      eventService: f.eventService, eventGuidedFlow: f.guided,
      menuRegistry: { openMenuFromCommand: async () => undefined, resolveRole: async () => member },
      permissionService: { resolveRole: async () => member }
    });
    const privateMsg = { from: "111@c.us", reply: f.context.replyText };
    await command.execute(f.client, privateMsg, [allowed.id], { commandName: "ver evento", platformContext: f.context });
    assert.match(f.replies.at(-1), /Permitido/);
    await command.execute(f.client, privateMsg, [denied.id], { commandName: "ver evento", platformContext: f.context });
    assert.match(f.replies.at(-1), /não encontrado ou você não possui permissão/);
    assert.equal(f.replies.at(-1).includes("Negado"), false);
  } finally { await cleanup(f.root); }
});

test("aliases, prioridade e arquitetura permanecem preservados", async () => {
  for (const alias of ["criar evento", "evento criar", "editar evento", "evento editar", "publicar evento", "evento publicar", "cancelar evento", "evento cancelar", "finalizar evento", "encerrar evento"]) assert.equal(ALIASES.includes(alias), true, alias);
  const loader = await fsp.readFile(path.join(__dirname, "..", "src", "loader.js"), "utf8");
  assert.ok(loader.indexOf("quizAnswer.hasActiveRound") < loader.indexOf("guidedFlowAnswer.hasActiveFlow"));
  assert.ok(loader.indexOf("guidedFlowAnswer.hasActiveFlow") < loader.indexOf("menuAnswer.hasActiveMenu"));
  assert.equal((loader.match(/client\.on\(\s*["']message/g) || []).length, 1);
  const command = await fsp.readFile(path.join(__dirname, "..", "src", "commands", "events.js"), "utf8");
  assert.equal(/readFile|writeFile|\.json/.test(command), false);
});
