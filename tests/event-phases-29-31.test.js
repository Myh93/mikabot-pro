"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const formatter = require("../src/services/eventMessageFormatter");
const { createEventRepository } = require("../src/repositories/eventRepository");
const { createEventService } = require("../src/services/eventService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createEventGuidedFlowService } = require("../src/services/eventGuidedFlowService");
const { createMenuSessionService } = require("../src/services/menuSessionService");
const { createGroupDirectoryService } = require("../src/services/groupDirectoryService");

const NOW = new Date("2026-08-16T15:00:00.000Z");
const owner = { name: "owner", isAdmin: true, isOwner: true };

function event(status, startsAt, endsAt = null) {
  return { id: "E0001", title: "Evento", type: "quiz", status, startsAt, endsAt, timezone: "America/Fortaleza" };
}

test("ciclo derivado distingue próximo, ativo e passado e preserva estados explícitos", () => {
  assert.equal(formatter.resolveLifecycleStatus(event("scheduled", "2026-08-17T15:00:00.000Z"), NOW), "upcoming");
  assert.equal(formatter.resolveLifecycleStatus(event("running", "2026-08-16T14:00:00.000Z", "2026-08-16T16:00:00.000Z"), NOW), "active");
  assert.equal(formatter.resolveLifecycleStatus(event("running", "2026-08-15T14:00:00.000Z"), NOW), "past");
  for (const status of ["cancelled", "finished", "archived"]) assert.equal(formatter.resolveLifecycleStatus(event(status, "2026-08-01T14:00:00.000Z"), NOW), status);
});

test("interface amigável não expõe ID e diferencia títulos iguais por data, hora e tipo", () => {
  const first = formatter.formatEventListItem(event("scheduled", "2026-08-17T15:00:00.000Z"), 1, { now: NOW });
  const second = formatter.formatEventListItem({ ...event("scheduled", "2026-08-18T18:30:00.000Z"), id: "E0002", type: "raid" }, 2, { now: NOW });
  const text = `${first}\n${second}`;
  assert.doesNotMatch(text, /E0001|E0002/);
  assert.match(text, /1️⃣ Evento[\s\S]*Quiz/);
  assert.match(text, /2️⃣ Evento[\s\S]*Raid/);
  assert.notEqual(first, second);
});

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-event-29-31-"));
  const repository = createEventRepository({ databaseDir: path.join(root, "events"), backupRoot: path.join(root, "backups") });
  const eventService = createEventService({ repository, clock: () => NOW });
  const flows = createGuidedFlowService({ filePath: path.join(root, "flows.json"), clock: () => NOW });
  const menus = createMenuSessionService({ filePath: path.join(root, "menus.json"), clock: () => NOW });
  const directory = createGroupDirectoryService({ filePath: path.join(root, "groups.json"), clock: () => NOW, warn: () => undefined });
  await directory.upsertGroup({ groupId: "group@g.us", name: "Grupo", source: "message" });
  const replies = [];
  const client = { getChatById: async () => ({ isGroup: true, participants: [{ id: "user@c.us", isAdmin: true }] }), sendMessage: async () => ({ id: "message" }) };
  const guided = createEventGuidedFlowService({ guidedFlowService: flows, eventService, menuSessionService: menus, groupDirectoryService: directory });
  const context = { platform: "whatsapp", conversationId: "user@c.us", groupId: "user@c.us", userId: "user@c.us", identity: { id: "user@c.us" }, isGroup: false, replyText: async text => replies.push(String(text)) };
  return { root, repository, eventService, flows, guided, client, context, replies };
}

test("evento passado sai da lista operacional e permanece no histórico sem reescrita", async () => {
  const f = await fixture();
  try {
    const old = await f.repository.createEvent({ title: "Antigo", type: "custom", platform: "whatsapp", groupId: "group@g.us", creatorId: "user@c.us", status: "running", startsAt: "2026-08-15T14:00:00.000Z" });
    const context = { platform: "whatsapp", groupId: "group@g.us", userId: "user@c.us", role: owner };
    assert.equal((await f.eventService.listEvents(context)).some(item => item.id === old.id), false);
    assert.equal((await f.eventService.listEventHistory(context)).some(item => item.id === old.id), true);
    assert.equal((await f.repository.getEventById(old.id)).status, "running");
  } finally { await fsp.rm(f.root, { recursive: true, force: true }); }
});

test("seleção numérica resolve ID interno, revisão antecede edição e arquivamento é guiado", async () => {
  const f = await fixture();
  try {
    const item = await f.repository.createEvent({ title: "Mesmo título", type: "quiz", platform: "whatsapp", groupId: "group@g.us", creatorId: "user@c.us", status: "scheduled", startsAt: "2026-08-20T15:00:00.000Z" });
    await f.guided.startActionFlow("edit_event", f.client, f.context, owner);
    assert.doesNotMatch(f.replies.at(-1), /E\d{4}/);
    await f.guided.handleAnswer(f.client, f.context, "1");
    await f.guided.handleAnswer(f.client, f.context, "1");
    assert.match(f.replies.at(-1), /Valor atual:[\s\S]*Mesmo título/);
    await f.guided.handleAnswer(f.client, f.context, "Novo título");
    assert.equal((await f.repository.getEventById(item.id)).title, "Mesmo título");
    assert.match(f.replies.at(-1), /REVISÃO DA ALTERAÇÃO/);
    await f.guided.handleAnswer(f.client, f.context, "1");
    assert.equal((await f.repository.getEventById(item.id)).title, "Novo título");
    await f.flows.cancelFlow("whatsapp", "user@c.us", "user@c.us");
    await f.repository.publishEvent(item.id);
    await f.eventService.finishEvent(item.id, { platform: "whatsapp", groupId: "group@g.us", userId: "user@c.us", role: owner });
    await f.guided.startActionFlow("archive_event", f.client, f.context, owner);
    await f.guided.handleAnswer(f.client, f.context, "1");
    await f.guided.handleAnswer(f.client, f.context, "1");
    assert.equal((await f.repository.getEventById(item.id)).status, "archived");
  } finally { await fsp.rm(f.root, { recursive: true, force: true }); }
});

test("entrada pelo menu de grupo pode continuar no fluxo canônico sem prompt de ID", async () => {
  const f = await fixture();
  try {
    const groupContext = { ...f.context, conversationId: "group@g.us", groupId: "group@g.us", isGroup: true };
    const started = await f.guided.startCreateFlow(f.client, groupContext, owner);
    assert.equal(started.status, "started");
    assert.ok(await f.flows.getActiveFlow("whatsapp", "group@g.us", "user@c.us"));
    const menu = require("../src/services/menuRegistry").DEFINITIONS.events;
    for (const option of menu.options.filter(item => /Evento/.test(item.label))) assert.equal(/E0001|Informe o ID/.test(String(option.prompt || "")), false);
  } finally { await fsp.rm(f.root, { recursive: true, force: true }); }
});
