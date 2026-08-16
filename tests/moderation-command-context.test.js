"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { isGroupMessage } = require("../src/utils/messageContext");
const antiLinkCommands = require("../src/commands/moderationAntiLink");

function commandFixture() {
  const updates = [], replies = [];
  const commands = antiLinkCommands.createModerationAntiLinkCommands({
    moderationService: {
      updateGroupConfig: async (groupId, patch) => { updates.push({ groupId, patch }); }
    }
  });
  const byName = Object.fromEntries(commands.map(command => [command.name, command]));
  const role = { isAdmin: true, rank: 2 };
  const message = overrides => ({
    from: "120363000000000000@g.us",
    to: "5511999999999@c.us",
    body: "!antilink on",
    fromMe: false,
    getChat: async () => ({ isGroup: true, id: { _serialized: "120363000000000000@g.us" } }),
    reply: async text => replies.push(text),
    ...overrides
  });
  return { updates, replies, byName, role, message };
}

test("isGroupMessage central aceita todas as fontes confiáveis", async () => {
  assert.equal(await isGroupMessage({ from: "grupo@g.us" }), true);
  assert.equal(await isGroupMessage({ from: "usuario@c.us", to: "grupo@g.us", fromMe: true }), true);
  assert.equal(await isGroupMessage({ from: "usuario@c.us", getChat: async () => ({ isGroup: true }) }), true);
  assert.equal(await isGroupMessage({ from: "usuario@c.us" }, { isGroup: false, id: { _serialized: "grupo@g.us" } }), true);
});

test("!antilink on enviado no grupo é processado mesmo sem loader.chat", async () => {
  const f = commandFixture(), msg = f.message();
  await f.byName.antilink.execute(null, msg, ["on"], { chat: null, role: f.role });
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].patch.settings.antiLink.enabled, true);
  assert.doesNotMatch(f.replies.join(" "), /somente em grupos/i);
});

test("!aprovacaolink on e !linksaprovacao on enviados no grupo são processados", async () => {
  const f = commandFixture(), msg = f.message({ body: "!aprovacaolink on" });
  await f.byName.aprovacaolink.execute(null, msg, ["on"], { chat: null, role: f.role });
  await f.byName.aprovacaolink.execute(null, f.message({ body: "!linksaprovacao on" }), ["on"], { chat: { isGroup: true }, role: f.role });
  assert.equal(f.updates.length, 2);
  assert.ok(f.updates.every(update => update.patch.settings.approval.enabled === true));
});

test("mensagem enviada pelo número conectado dentro do grupo usa message.to", async () => {
  const f = commandFixture(), msg = f.message({ from: "5511999999999@c.us", to: "120363000000000000@g.us", fromMe: true, getChat: async () => ({ isGroup: true }) });
  await f.byName.antilink.execute(null, msg, ["on"], { chat: null, role: f.role });
  assert.equal(f.updates.length, 1);
});

test("mensagem realmente privada continua recusada e não ativa proteção", async () => {
  const f = commandFixture(), msg = f.message({ from: "5511888888888@c.us", to: "5511999999999@c.us", getChat: async () => ({ isGroup: false, id: { _serialized: "5511888888888@c.us" } }) });
  await f.byName.antilink.execute(null, msg, ["on"], { chat: null, role: f.role });
  await f.byName.aprovacaolink.execute(null, msg, ["on"], { chat: null, role: f.role });
  assert.equal(f.updates.length, 0);
  assert.equal(f.replies.filter(reply => /somente em grupos/i.test(reply)).length, 2);
});

test("falha temporária de getChat usa @g.us como fallback sem falso grupo privado", async () => {
  const failure = async () => { throw new Error("temporário"); };
  assert.equal(await isGroupMessage({ from: "grupo@g.us", getChat: failure }), true);
  assert.equal(await isGroupMessage({ from: "usuario@c.us", to: "bot@c.us", getChat: failure }), false);
});

test("detector central não depende de author, participant, nome ou @lid", async () => {
  const privateMessage = { from: "usuario@c.us", to: "bot@c.us", author: "membro@lid", participant: { id: "membro@lid" }, name: "Área 51" };
  assert.equal(await isGroupMessage(privateMessage), false);
});

test("correção não cria listener e comandos não duplicam a detecção", async () => {
  const fsp = require("node:fs").promises, path = require("node:path");
  const utility = await fsp.readFile(path.join(__dirname, "..", "src", "utils", "messageContext.js"), "utf8");
  assert.doesNotMatch(utility, /client\.on|client\.once/);
  for (const file of ["moderationAntiLink.js", "moderationBans.js", "moderationWarnings.js", "linkApprovalAdmin.js"]) {
    const source = await fsp.readFile(path.join(__dirname, "..", "src", "commands", file), "utf8");
    assert.match(source, /isGroupMessage/);
  }
});
