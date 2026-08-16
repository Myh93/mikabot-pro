"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventRepository } = require("../src/repositories/eventRepository");
const { createEventService, AUTHORIZATION_MESSAGE } = require("../src/services/eventService");
const { createEventsCommand, ALIASES } = require("../src/commands/events");
const { createMenuRegistry } = require("../src/services/menuRegistry");

const NOW = new Date("2026-07-16T15:00:00.000Z");
const memberRole = { name: "member", rank: 0, isAdmin: false, isOwner: false, isProtectedOwner: false };
const adminRole = { name: "admin", rank: 2, isAdmin: true, isOwner: false, isProtectedOwner: false };

async function harness() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-event-command-"));
  const repository = createEventRepository({ databaseDir: path.join(root, "events"), backupRoot: path.join(root, "backups") });
  const service = createEventService({ repository, clock: () => new Date(NOW) });
  const replies = [];
  const sent = [];
  const platformContext = {
    platform: "whatsapp", groupId: "group-a@g.us", conversationId: "group-a@g.us",
    userId: "111@lid", isGroup: true, identity: { id: "111@lid" },
    replyText: async (text) => { replies.push(String(text)); return text; }
  };
  const msg = { from: "group-a@g.us", author: "111@lid", body: "", reply: async (text) => { replies.push(String(text)); return text; } };
  const client = { sendMessage: async (groupId, text) => { sent.push({ groupId, text }); return { id: { _serialized: "message-1" } }; } };
  const menuRegistry = {
    openMenuFromCommand: async () => { replies.push("MENU_OPENED"); return { status: "opened" }; },
    resolveRole: async () => memberRole
  };
  const command = createEventsCommand({ eventService: service, menuRegistry });
  const run = (commandName, args = [], overrides = {}) => command.execute(client, { ...msg, ...(overrides.msg || {}) }, args, {
    commandName, platformContext: { ...platformContext, ...(overrides.context || {}) }, role: overrides.role || memberRole
  });
  return { root, repository, service, replies, sent, command, run, platformContext, msg, client };
}

const clean = (root) => fsp.rm(root, { recursive: true, force: true });

test("!evento e !eventos abrem o mesmo menu", async () => {
  const h = await harness();
  try {
    await h.run("evento");
    await h.run("eventos");
    assert.deepEqual(h.replies, ["MENU_OPENED", "MENU_OPENED"]);
  } finally { await clean(h.root); }
});

test("menu de membro e admin apresenta opções corretas", async () => {
  const sessions = { openMenu: async (_context, input) => input };
  const permissions = { hasPermission: (role, rule) => !rule.adminOnly || role?.isAdmin };
  const registry = createMenuRegistry({ sessionService: sessions, permissionService: permissions });
  const context = {
    platform: "whatsapp", groupId: "g@g.us", conversationId: "g@g.us",
    userId: "u", replyText: async () => undefined
  };
  const member = await registry.openMenu("events", context, memberRole);
  const admin = await registry.openMenu("events", context, adminRole);
  assert.equal(Object.keys(member.options).length, 4);
  assert.equal(member.text.includes("Criar Evento"), true);
  assert.equal(member.text.includes("Arquivar Evento"), false);
  assert.equal(Object.keys(admin.options).length, 10);
  assert.equal(admin.text.includes("Histórico"), true);
});

test("criação por comando aceita data brasileira e retorna ID", async () => {
  const h = await harness();
  try {
    await h.run("criar evento", ["Quiz de Hoje", "|", "Vai ter quiz", "|", "16/07/2026", "|", "20:00"]);
    const event = await h.repository.getEventById("E0001");
    assert.equal(event.title, "Quiz de Hoje");
    assert.equal(event.status, "scheduled");
    assert.equal(event.startsAt, "2026-07-16T23:00:00.000Z");
    assert.match(h.replies[0], /EVENTO CRIADO COM SUCESSO![\s\S]*Hoje[\s\S]*20:00[\s\S]*E0001/);
  } finally { await clean(h.root); }
});

test("datas relativas e horários abreviados são convertidos em Fortaleza", async () => {
  const h = await harness();
  try {
    const today = await h.service.createEvent({ title: "Hoje", date: "hoje", time: "20h" }, h.platformContext);
    const tomorrow = await h.service.createEvent({ title: "Amanhã", date: "amanha", time: "20h30" }, h.platformContext);
    assert.equal(today.startsAt, "2026-07-16T23:00:00.000Z");
    assert.equal(tomorrow.startsAt, "2026-07-17T23:30:00.000Z");
  } finally { await clean(h.root); }
});

test("ano omitido usa próximo ano apenas quando a data passou", async () => {
  const h = await harness();
  try {
    const event = await h.service.createEvent({ title: "Ano novo", date: "01/01", time: "20:00" }, h.platformContext);
    assert.equal(event.startsAt, "2027-01-01T23:00:00.000Z");
  } finally { await clean(h.root); }
});

test("rejeita data, horário e título inválidos", async () => {
  const h = await harness();
  try {
    await assert.rejects(h.service.createEvent({ title: "Inválido", date: "31/02/2026", time: "20:00" }, h.platformContext), /Data inválida/);
    await assert.rejects(h.service.createEvent({ title: "Inválido", date: "16/07/2026", time: "25h" }, h.platformContext), /Horário inválido/);
    await assert.rejects(h.service.createEvent({ title: " " }, h.platformContext), /título/);
  } finally { await clean(h.root); }
});

test("edita título, descrição e prêmio pelos mesmos serviços", async () => {
  const h = await harness();
  try {
    const event = await h.service.createEvent({ title: "Original" }, h.platformContext);
    await h.run("editar evento", [event.id, "titulo", "Novo", "título"]);
    await h.run("evento editar", [event.id, "descricao", "Novo", "texto"]);
    await h.run("editar evento", [event.id, "premio", "Pikachu", "Shiny"]);
    const updated = await h.repository.getEventById(event.id);
    assert.equal(updated.title, "Novo título");
    assert.equal(updated.description, "Novo texto");
    assert.equal(updated.prize, "Pikachu Shiny");
  } finally { await clean(h.root); }
});

test("edita data e hora preservando a outra parte", async () => {
  const h = await harness();
  try {
    const event = await h.service.createEvent({ title: "Agenda", date: "16/07/2026", time: "20:00" }, h.platformContext);
    await h.service.updateEvent(event.id, "data", "17/07/2026", h.platformContext);
    const updated = await h.service.updateEvent(event.id, "hora", "21h30", h.platformContext);
    assert.deepEqual(h.service.formatDateTime(updated.startsAt), { date: "17/07/2026", time: "21:30" });
  } finally { await clean(h.root); }
});

test("publica no grupo do evento com texto oficial e prêmio", async () => {
  const h = await harness();
  try {
    const event = await h.service.createEvent({ title: "Quiz", description: "Venham jogar", date: "16/07/2026", time: "20:00", prize: "Pikachu Shiny" }, h.platformContext);
    await h.run("publicar evento", [event.id]);
    assert.equal(h.sent[0].groupId, "group-a@g.us");
    assert.match(h.sent[0].text, /EVENTO CONFIRMADO[\s\S]*📌 \*Quiz\*[\s\S]*Venham jogar[\s\S]*🎁 Prêmio:[\s\S]*Pikachu Shiny/);
    assert.equal(h.sent[0].text.includes("E0001"), false);
    assert.equal((await h.repository.getEventById(event.id)).status, "published");
  } finally { await clean(h.root); }
});

test("omite bloco de prêmio e bloqueia publicação duplicada", async () => {
  const h = await harness();
  try {
    const event = await h.service.createEvent({ title: "Sem prêmio", date: "16/07/2026", time: "20:00" }, h.platformContext);
    await h.run("evento publicar", [event.id]);
    assert.equal(h.sent[0].text.includes("Prêmio"), false);
    await h.run("publicar evento", [event.id]);
    assert.match(h.replies.at(-1), /já foi publicado/);
    assert.equal(h.sent.length, 1);
  } finally { await clean(h.root); }
});

test("cancela, finaliza e arquiva preservando autorização", async () => {
  const h = await harness();
  try {
    const cancelled = await h.service.createEvent({ title: "Cancelar" }, h.platformContext);
    await h.run("cancelar evento", [cancelled.id]);
    assert.equal((await h.repository.getEventById(cancelled.id)).status, "cancelled");
    const finished = await h.service.createEvent({ title: "Finalizar", groupId: "ignored", date: "16/07/2026", time: "20:00" }, h.platformContext);
    await h.run("publicar evento", [finished.id]);
    await h.run("encerrar evento", [finished.id]);
    assert.equal((await h.repository.getEventById(finished.id)).status, "finished");
    await h.run("evento arquivar", [finished.id], { role: adminRole });
    assert.equal((await h.repository.getEventById(finished.id)).status, "archived");
  } finally { await clean(h.root); }
});

test("lista somente o grupo atual e oculta rascunho de terceiro", async () => {
  const h = await harness();
  try {
    await h.service.createEvent({ title: "Meu rascunho" }, h.platformContext);
    await h.repository.createEvent({ title: "Rascunho alheio", type: "custom", platform: "whatsapp", groupId: "group-a@g.us", creatorId: "222@lid", status: "draft" });
    await h.repository.createEvent({ title: "Outro grupo", type: "custom", platform: "whatsapp", groupId: "group-b@g.us", creatorId: "222@lid", status: "scheduled", startsAt: "2026-07-20T23:00:00.000Z" });
    const member = await h.service.listEvents({ ...h.platformContext, role: memberRole });
    const admin = await h.service.listEvents({ ...h.platformContext, role: adminRole });
    assert.deepEqual(member.map((item) => item.title), ["Meu rascunho"]);
    assert.deepEqual(new Set(admin.map((item) => item.title)), new Set(["Meu rascunho", "Rascunho alheio"]));
  } finally { await clean(h.root); }
});

test("próximos eventos inclui apenas scheduled e published futuros", async () => {
  const h = await harness();
  try {
    await h.service.createEvent({ title: "Futuro", date: "20/07/2026", time: "20:00" }, h.platformContext);
    await h.service.createEvent({ title: "Rascunho" }, h.platformContext);
    const past = await h.repository.createEvent({ title: "Passado", type: "custom", platform: "whatsapp", groupId: "group-a@g.us", creatorId: "111@lid", status: "scheduled", startsAt: "2026-07-01T23:00:00.000Z" });
    assert.ok(past);
    assert.deepEqual((await h.service.listUpcomingEvents(h.platformContext)).map((item) => item.title), ["Futuro"]);
  } finally { await clean(h.root); }
});

test("membro não altera evento de terceiro e admin não cruza grupos", async () => {
  const h = await harness();
  try {
    const thirdParty = await h.repository.createEvent({ title: "Terceiro", type: "custom", platform: "whatsapp", groupId: "group-a@g.us", creatorId: "222@lid", status: "draft" });
    await assert.rejects(h.service.updateEvent(thirdParty.id, "titulo", "Inválido", { ...h.platformContext, role: memberRole }), (error) => error.message === AUTHORIZATION_MESSAGE);
    const otherGroup = await h.repository.createEvent({ title: "Outro", type: "custom", platform: "whatsapp", groupId: "group-b@g.us", creatorId: "222@lid", status: "draft" });
    await assert.rejects(h.service.cancelEvent(otherGroup.id, { ...h.platformContext, role: adminRole }), /só pode alterar/);
  } finally { await clean(h.root); }
});

test("histórico final é protegido e não expõe logs técnicos", async () => {
  const h = await harness();
  try {
    const event = await h.service.createEvent({ title: "Cancelado" }, h.platformContext);
    await h.service.cancelEvent(event.id, h.platformContext);
    await assert.rejects(h.service.listEventHistory({ ...h.platformContext, role: memberRole }), /administradores/);
    const history = await h.service.listEventHistory({ ...h.platformContext, role: adminRole });
    assert.deepEqual(history.map((item) => item.id), [event.id]);
    assert.equal(h.service.formatEventList(history).includes("checksum"), false);
  } finally { await clean(h.root); }
});

test("todos os aliases escritos permanecem registrados", () => {
  const expected = ["evento criar", "evento editar", "evento cancelar", "evento publicar", "eventos ativos", "proximo evento", "evento ver", "encerrar evento", "evento arquivar", "eventos historico"];
  expected.forEach((alias) => assert.equal(ALIASES.includes(alias), true, alias));
});

test("menu e comando direto apontam para os mesmos comandos do serviço", () => {
  const registry = createMenuRegistry({ sessionService: {}, permissionService: { hasPermission: () => true } });
  const options = registry.getMenu("events").options;
  assert.equal(options.find((item) => item.label === "Eventos Ativos").command, "listar eventos");
  assert.equal(options.find((item) => item.label === "Próximos Eventos").command, "proximos eventos");
  assert.equal(options.some((item) => item.command && !["listar eventos", "proximos eventos", "historico eventos"].includes(item.command)), false);
});

test("comando não acessa JSON nem registra listener", async () => {
  const source = await fsp.readFile(path.join(__dirname, "..", "src", "commands", "events.js"), "utf8");
  assert.equal(/readFile|writeFile|\.json/.test(source), false);
  assert.equal(/client\.on\s*\(/.test(source), false);
});
