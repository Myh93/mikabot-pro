"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createGroupDirectoryService } = require("../src/services/groupDirectoryService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createEventGuidedFlowService } = require("../src/services/eventGuidedFlowService");
const { createGroupSyncCommand } = require("../src/commands/groupSync");
const { createGroupDirectoryCommands } = require("../src/commands/groupDirectory");
const { createWhatsAppWarningLimiter } = require("../src/utils/whatsappWarningLimiter");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-groups-"));
  const warnings = [];
  const directory = createGroupDirectoryService({ filePath: path.join(root, "directory.json"), warn: (message) => warnings.push(message) });
  return { root, directory, warnings };
}

const cleanup = (root) => fsp.rm(root, { recursive: true, force: true });

test("registra msg.from sem chamar getChat, atualiza lastSeenAt e usa fallback", async () => {
  const f = await fixture();
  try {
    let getChatCalls = 0;
    const msg = { from: "grupo@g.us", body: "!menu", getChat: async () => { getChatCalls += 1; throw new Error("não deve chamar"); } };
    const first = await f.directory.registerFromMessage(msg);
    assert.deepEqual(Object.keys(first), ["platform", "groupId", "name", "nameSource", "lastSeenAt", "source", "active"]);
    assert.equal(first.groupId, "grupo@g.us");
    assert.equal(first.name, "Grupo cadastrado");
    assert.equal(getChatCalls, 0);
    const second = await f.directory.registerFromMessage({ from: "grupo@g.us", body: "oi" });
    assert.equal(second.name, "Grupo cadastrado");
    assert.ok(Date.parse(second.lastSeenAt));
  } finally { await cleanup(f.root); }
});

test("registro ignora msg.getChat e mantém fallback amigável sem warning", async () => {
  const f = await fixture();
  try {
    const stored = await f.directory.registerFromMessage({ from: "grupo-seguro@g.us", getChat: async () => { throw new Error("r"); } });
    assert.equal(stored.name, "Grupo cadastrado");
    assert.equal(f.warnings.length, 0);
    assert.equal(JSON.stringify(stored).includes("getChat"), false);
  } finally { await cleanup(f.root); }
});

test("não consulta formattedTitle e nunca substitui nome real por genérico", async () => {
  const f = await fixture();
  try {
    const formatted = await f.directory.registerSeenGroup({ from: "formatado@g.us", getChat: async () => ({ isGroup: true, formattedTitle: "Grupo Formatado" }) });
    assert.equal(formatted.name, "Grupo cadastrado");
    await f.directory.upsertGroup({ groupId: "real@g.us", name: "Tropa Pokémon GO" });
    const preserved = await f.directory.upsertGroup({ groupId: "real@g.us", name: "Grupo cadastrado" });
    assert.equal(preserved.name, "Tropa Pokémon GO");
    await f.directory.registerFromMessage({ from: "real@g.us", getChat: async () => { throw new Error("r"); } });
    assert.equal((await f.directory.getGroup("whatsapp", "real@g.us")).name, "Tropa Pokémon GO");
  } finally { await cleanup(f.root); }
});

test("mantém uma única entrada quando nome do mesmo groupId muda", async () => {
  const f = await fixture();
  try {
    await f.directory.upsertGroup({ groupId: "mesmo@g.us", name: "Nome antigo" });
    await f.directory.upsertGroup({ groupId: "mesmo@g.us", name: "Nome novo" });
    const groups = await f.directory.listActiveGroups();
    assert.equal(groups.length, 1);
    assert.equal(groups[0].name, "Nome novo");
  } finally { await cleanup(f.root); }
});

test("client.getChats com Error r não impede fluxo baseado no diretório", async () => {
  const f = await fixture();
  try {
    await f.directory.upsertGroup({ groupId: "grupo@g.us", name: "Grupo Seguro" });
    let getChatsCalls = 0;
    const client = {
      getChats: async () => { getChatsCalls += 1; throw new Error("r"); },
      getChatById: async () => ({ isGroup: true, participants: [{ id: "111@c.us", isAdmin: false }] })
    };
    const flowStore = createGuidedFlowService({ filePath: path.join(f.root, "flows.json") });
    const replies = [];
    const guided = createEventGuidedFlowService({
      groupDirectoryService: f.directory, guidedFlowService: flowStore,
      eventService: { listManageableEvents: async () => [] },
      menuSessionService: { closeMenu: async () => false }, warn: () => undefined
    });
    const context = { platform: "whatsapp", conversationId: "111@c.us", userId: "111@c.us", identity: { id: "111@c.us" }, isGroup: false, replyText: async (text) => replies.push(text) };
    assert.equal((await guided.startCreateFlow(client, context, { name: "member" })).status, "started");
    assert.equal(getChatsCalls, 0);
    assert.match(replies[0], /Grupo Seguro/);
  } finally { await cleanup(f.root); }
});

test("owner vê ativos e membro sem confirmação segura não recebe grupo", async () => {
  const f = await fixture();
  try {
    await f.directory.upsertGroup({ groupId: "ativo@g.us", name: "Grupo Ativo" });
    const guided = createEventGuidedFlowService({ groupDirectoryService: f.directory, warningLimiter: { warn: () => undefined } });
    const client = { getChatById: async () => { throw new Error("r"); } };
    assert.equal((await guided.listManageableGroups(client, { id: "owner@c.us", role: { name: "owner", isOwner: true } })).length, 1);
    assert.equal((await guided.listManageableGroups(client, { id: "member@c.us", role: { name: "member" } })).length, 0);
  } finally { await cleanup(f.root); }
});

test("três grupos genéricos ficam diferenciados sem expor @g.us", async () => {
  const f = await fixture();
  try {
    for (const id of ["5511999999577@g.us", "5511999991234@g.us", "5511999998888@g.us"]) await f.directory.upsertGroup({ groupId: id, name: "Grupo cadastrado" });
    const guided = createEventGuidedFlowService({ groupDirectoryService: f.directory, warn: () => undefined });
    const groups = await guided.listManageableGroups({}, { id: "owner@c.us", role: { name: "owner", isOwner: true } });
    assert.deepEqual(groups.map((group) => group.name), ["Grupo cadastrado • final 1234", "Grupo cadastrado • final 8888", "Grupo cadastrado • final 9577"]);
    assert.equal(groups.some((group) => group.name.includes("@g.us")), false);
  } finally { await cleanup(f.root); }
});

test("comandos owner-only listam, nomeiam por opção e registram pelo grupo atual", async () => {
  const f = await fixture();
  try {
    for (const id of ["5511999999577@g.us", "5511999991234@g.us", "5511999998888@g.us"]) await f.directory.upsertGroup({ groupId: id, name: "Grupo cadastrado" });
    const commands = createGroupDirectoryCommands({ groupDirectoryService: f.directory });
    assert.equal(commands.every((command) => command.ownerOnly), true);
    const replies = [];
    const reply = async (text) => { replies.push(text); return text; };
    await commands.find((command) => command.name === "grupos").execute({}, { from: "owner@c.us", reply }, []);
    assert.match(replies.at(-1), /GRUPOS CADASTRADOS[\s\S]*final 9577[\s\S]*final 1234[\s\S]*final 8888/);
    assert.equal(replies.at(-1).includes("@g.us"), false);

    await commands.find((command) => command.name === "nomear grupo").execute({}, { from: "owner@c.us", reply }, ["1", "|", "Tropa", "Pokémon", "GO"]);
    assert.equal(replies.at(-1), "✅ Grupo atualizado.\n\n📂 Nome: Tropa Pokémon GO");
    const renamed = await f.directory.getGroup("whatsapp", "5511999999577@g.us");
    assert.equal(renamed.groupId, "5511999999577@g.us");
    assert.equal(renamed.nameSource, "manual");

    await commands.find((command) => command.name === "registrar grupo").execute({}, { from: "5511999999577@g.us", reply }, ["Liga", "Pokémon"]);
    assert.equal(replies.at(-1), "✅ Grupo registrado como:\nLiga Pokémon");
    const groups = await f.directory.listActiveGroups();
    assert.equal(groups.length, 3);
    assert.equal((await f.directory.getGroup("whatsapp", "5511999999577@g.us")).nameSource, "manual");
    const guided = createEventGuidedFlowService({ groupDirectoryService: f.directory, warn: () => undefined });
    const choices = await guided.listManageableGroups({}, { id: "owner@c.us", role: { name: "owner", isOwner: true } });
    assert.equal(choices.some((group) => group.name === "Liga Pokémon"), true);
  } finally { await cleanup(f.root); }
});

test("nome manual sobrevive a mensagens e sincronizações futuras", async () => {
  const f = await fixture();
  try {
    await f.directory.setManualName("manual@g.us", "Nome da Owner");
    await f.directory.registerFromMessage({ from: "manual@g.us", getChat: async () => ({ name: "Nome automático" }) });
    let calls = 0;
    const result = await f.directory.synchronizeGroups({ getChatById: async () => { calls += 1; return { name: "Outro nome automático" }; } });
    const stored = await f.directory.getGroup("whatsapp", "manual@g.us");
    assert.equal(stored.name, "Nome da Owner");
    assert.equal(stored.nameSource, "manual");
    assert.deepEqual(result, { disabled: true, updated: 0, unchanged: 1, failures: 0 });
    assert.equal(calls, 0);
  } finally { await cleanup(f.root); }
});

test("sincronização automática fica desativada e não usa APIs de chat", async () => {
  const f = await fixture();
  try {
    await f.directory.upsertGroup({ groupId: "a@g.us", name: "Grupo cadastrado" });
    await f.directory.upsertGroup({ groupId: "b@g.us", name: "Nome B" });
    await f.directory.upsertGroup({ groupId: "c@g.us", name: "Grupo cadastrado" });
    let getChatsCalls = 0;
    const client = {
      getChats: async () => { getChatsCalls += 1; throw new Error("não deveria chamar"); },
      getChatById: async (groupId) => {
        if (groupId === "a@g.us") return { name: "Nome A" };
        if (groupId === "b@g.us") return { formattedTitle: "Nome B" };
        throw new Error("r");
      }
    };
    let getChatByIdCalls = 0;
    client.getChatById = async () => { getChatByIdCalls += 1; throw new Error("não deveria chamar"); };
    const result = await f.directory.synchronizeGroups(client);
    assert.deepEqual(result, { disabled: true, updated: 0, unchanged: 3, failures: 0 });
    assert.equal(getChatsCalls, 0);
    assert.equal(getChatByIdCalls, 0);
    assert.equal((await f.directory.getGroup("whatsapp", "a@g.us")).name, "Grupo cadastrado");
    assert.equal((await f.directory.getGroup("whatsapp", "c@g.us")).name, "Grupo cadastrado");

    const replies = [];
    const command = createGroupSyncCommand({ groupDirectoryService: f.directory });
    assert.equal(command.ownerOnly, true);
    assert.deepEqual(command.aliases, ["sync grupos", "atualizar grupos"]);
    await command.execute(client, { reply: async (text) => replies.push(text) });
    assert.match(replies[0], /sincronização automática de nomes foi desativada[\s\S]*!registrar grupo Nome do Grupo[\s\S]*!nomear grupo NÚMERO \| Novo Nome/);
    assert.equal(replies[0].includes("@g.us"), false);
  } finally { await cleanup(f.root); }
});

test("API oficial do diretório não consulta WhatsApp", async () => {
  const f = await fixture();
  try {
    await f.directory.registerSeenGroup({ from: "oficial@g.us" });
    assert.equal((await f.directory.getGroups()).length, 1);
    assert.equal((await f.directory.getGroupById("oficial@g.us")).groupId, "oficial@g.us");
    for (const name of ["getGroups", "getGroupById", "registerSeenGroup", "setManualName", "setManualNameByPosition", "formatGroupDisplayName"]) assert.equal(typeof f.directory[name], "function", name);
  } finally { await cleanup(f.root); }
});

test("warnings iguais são limitados por cinco minutos e não expõem IDs", () => {
  let now = 0;
  const output = [];
  const limiter = createWhatsAppWarningLimiter({ clock: () => now, output: (message) => output.push(message) });
  limiter.warn("permissao", "getChat");
  limiter.warn("permissao", "getChat");
  limiter.warn("permissao", "getChat");
  assert.equal(output.length, 1);
  assert.equal(limiter.getSuppressedCount("permissao", "getChat"), 2);
  now = 5 * 60 * 1000;
  limiter.warn("permissao", "getChat");
  assert.equal(output.length, 2);
  assert.match(output[1], /2 ocorrências semelhantes foram suprimidas/);
  assert.equal(output.some((message) => /@g\.us|@lid|\d{9,}/.test(message)), false);
});

test("escritas concorrentes são atômicas e não deixam temporários", async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 12 }, (_, index) => f.directory.upsertGroup({ groupId: `grupo-${index}@g.us`, name: `Grupo ${index}` })));
    assert.equal((await f.directory.listActiveGroups()).length, 12);
    assert.deepEqual((await fsp.readdir(f.root)).filter((file) => file.endsWith(".tmp")), []);
    JSON.parse(await fsp.readFile(path.join(f.root, "directory.json"), "utf8"));
  } finally { await cleanup(f.root); }
});

test("loader registra no listener existente antes do despacho e não cria listener extra", async () => {
  const loader = await fsp.readFile(path.join(__dirname, "..", "src", "loader.js"), "utf8");
  assert.equal((loader.match(/client\.on\(\s*["']message/g) || []).length, 1);
  assert.ok(loader.indexOf("groupDirectoryService.registerFromMessage") < loader.indexOf("await dispatchCommand(client, msg, commandText)"));
});
