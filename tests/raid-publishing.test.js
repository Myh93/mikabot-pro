"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createRepository } = require("../src/repositories/raidRepository");
const { createRaidService } = require("../src/services/raidService");

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-raid-publish-"));
  const repository = createRepository(path.join(root, "raids.json"));
  const logs = [], joinLogs = [], shapeLogs = [], sent = [], sendOptions = [];
  const service = createRaidService(repository, {
    listRegistrations: async () => [],
    getRegistrationByIdentity: async () => null
  }, undefined, {
    publishLog: value => logs.push(value),
    joinLog: value => joinLogs.push(value),
    messageIdShapeLog: value => shapeLogs.push(value)
  });
  const chat = {
    isGroup: true,
    isReadOnly: false,
    sendMessage: async (text, messageOptions) => {
      sent.push(text);
      sendOptions.push(messageOptions);
      if (options.sendFails) throw new Error("send failed with 5511999999999@g.us");
      return options.sentMessage || { id: { _serialized: "message-safe" } };
    }
  };
  const client = {
    getChatById: async () => chat,
    sendMessage: async (_id, text, messageOptions) => chat.sendMessage(text, messageOptions)
  };
  return { repository, service, logs, joinLogs, shapeLogs, sent, sendOptions, chat, client };
}

async function create(f) {
  return f.service.createRaidFromMessage(
    { from: "source@g.us", author: "creator@lid" },
    { name: "Mega Charizard X", groupId: "source@g.us" }
  );
}

test("publica no GroupChat atual e resolve id oficial sem _serialized", async () => {
  const f = fixture({ sentMessage: { id: { toString() { return "message-safe"; } } } });
  const created = await create(f);
  const result = await f.service.publishRaidToGroups(f.client, created.raid, [{
    id: "source@g.us", name: "Grupo atual", chat: f.chat
  }]);
  assert.equal(result.successes.length, 1);
  assert.equal(result.failures.length, 0);
  assert.equal(f.sent.length, 1);
  assert.equal(result.raid.publications.length, 1);
  assert.match(f.sent[0], /Mega Charizard X/);
  assert.ok(f.logs.includes("sendAttempt=true"));
  assert.ok(f.logs.includes("sendSucceeded=true"));
  assert.ok(f.logs.includes("messageIdResolved=true"));
  assert.ok(f.logs.includes("publishRepositoryCalled=true"));
  assert.ok(f.logs.includes("publishRepositorySucceeded=true"));
  assert.ok(f.logs.includes("publicationPersisted=true"));
  assert.ok(f.shapeLogs.includes("resultType=object"));
  assert.ok(f.shapeLogs.includes("hasId=true"));
  assert.ok(f.shapeLogs.includes("hasToString=true"));
  assert.ok(f.shapeLogs.includes("constructorName=Object"));
  assert.deepEqual(f.sendOptions[0], {
    waitUntilMsgSent: true,
    extra: { mikaRaidResolveOfficialMessageKey: true }
  });
});

test("fallback Client.sendMessage também aguarda o resultado oficial", async () => {
  const f = fixture();
  const calls = [];
  f.client.sendMessage = async (groupId, text, options) => {
    calls.push({ groupId, text, options });
    return { id: { _serialized: "message-safe" } };
  };
  const created = await create(f);
  const result = await f.service.publishRaidToGroups(f.client, created.raid, [{
    id: "source@g.us",
    name: "Grupo atual",
    chat: { isGroup: true, isReadOnly: false }
  }]);
  assert.equal(result.successes.length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, {
    waitUntilMsgSent: true,
    extra: { mikaRaidResolveOfficialMessageKey: true }
  });
});

for (const [label, sentMessage] of [
  ["message.id string", { id: "message-safe" }],
  ["message.id._serialized", { id: { _serialized: "message-safe" } }],
  ["message.id.id", { id: { id: "message-safe" } }],
  ["message.id.toString()", { id: { toString() { return "message-safe"; } } }],
  ["message._data.id._serialized", { id: {}, _data: { id: { _serialized: "message-safe" } } }],
  ["message._data.id.id", { id: {}, _data: { id: { id: "message-safe" } } }],
  ["message._data.id.toString()", { id: {}, _data: { id: { toString() { return "message-safe"; } } } }]
]) {
  test(`publica quando sendMessage retorna ${label}`, async () => {
    const f = fixture({ sentMessage });
    const created = await create(f);
    const result = await f.service.publishRaidToGroups(f.client, created.raid, [{
      id: "source@g.us", name: "Grupo atual", chat: f.chat
    }]);
    assert.equal(result.successes.length, 1);
    assert.equal(result.failures.length, 0);
    assert.equal(result.raid.publications[0].messageId, "message-safe");
  });
}

test("não persiste publicação quando o retorno não contém ID oficial válido", async () => {
  const f = fixture({ sentMessage: { id: {}, _data: { id: {} } } });
  const created = await create(f);
  const result = await f.service.publishRaidToGroups(f.client, created.raid, [{
    id: "source@g.us", name: "Grupo atual", chat: f.chat
  }]);
  assert.equal(result.successes.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.raid.publications.length, 0);
  assert.ok(f.logs.includes("sendSucceeded=true"));
  assert.ok(f.logs.includes("messageIdResolved=false"));
  assert.ok(f.logs.includes("publishRepositoryCalled=false"));
});

test("instrumentação do retorno registra somente estrutura, nunca valores", async () => {
  const sensitive = "5511999999999@g.us_true_secret";
  const f = fixture({
    sentMessage: {
      id: { id: sensitive, remote: "5511999999999@g.us" },
      _data: { id: { _serialized: sensitive } }
    }
  });
  const created = await create(f);
  await f.service.publishRaidToGroups(f.client, created.raid, [{
    id: "source@g.us", name: "Grupo atual", chat: f.chat
  }]);
  const output = f.shapeLogs.join("\n");
  assert.match(output, /idKeys=id,remote/);
  assert.match(output, /dataIdKeys=_serialized/);
  assert.doesNotMatch(output, /5511999999999|@g\.us|secret/);
});

test("falha de envio não salva publicação e não expõe destino nos logs", async () => {
  const f = fixture({ sendFails: true });
  const created = await create(f);
  const result = await f.service.publishRaidToGroups(f.client, created.raid, [{
    id: "source@g.us", name: "Grupo atual"
  }]);
  assert.equal(result.failures.length, 1);
  assert.equal(result.raid.publications.length, 0);
  assert.ok(f.logs.includes("sendAttempt=true"));
  assert.ok(f.logs.includes("sendSucceeded=false"));
  assert.ok(f.logs.includes("publishRepositoryCalled=false"));
  assert.ok(f.logs.includes("publicationPersisted=false"));
  assert.doesNotMatch(f.logs.join("\n"), /5511999999999|@g\.us|@lid|@c\.us/);
});

test("falha ao persistir ocorre depois do envio e não registra publicação inexistente", async () => {
  const f = fixture();
  const created = await create(f);
  const original = f.repository.publishRaid;
  f.repository.publishRaid = () => { throw new Error("database failure"); };
  try {
    const result = await f.service.publishRaidToGroups(f.client, created.raid, [{
      id: "source@g.us", name: "Grupo atual"
    }]);
    assert.equal(f.sent.length, 1);
    assert.equal(result.failures.length, 1);
    assert.equal(result.raid.publications.length, 0);
    assert.ok(f.logs.includes("sendSucceeded=true"));
    assert.ok(f.logs.includes("messageIdResolved=true"));
    assert.ok(f.logs.includes("publishRepositoryCalled=true"));
    assert.ok(f.logs.includes("publishRepositorySucceeded=false"));
    assert.ok(f.logs.includes("publicationPersisted=false"));
  } finally {
    f.repository.publishRaid = original;
  }
});

test("publicação repetida mantém uma Raid, um envio e um vínculo", async () => {
  const f = fixture();
  const created = await create(f);
  await f.service.publishRaidToGroups(f.client, created.raid, [{ id: "source@g.us", name: "A" }]);
  const repeated = await f.service.publishRaidToGroups(f.client, created.raid, [{ id: "source@g.us", name: "A" }]);
  assert.equal(f.sent.length, 1);
  assert.equal(Object.keys(f.repository.loadDatabase().raids).length, 1);
  assert.equal(repeated.raid.publications.length, 1);
  assert.equal(repeated.successes[0].skipped, true);
});

test("consulta sem publicação registra exatamente o estágio join", async () => {
  const f = fixture({ sendFails: true });
  const created = await create(f);
  await f.service.publishRaidToGroups(f.client, created.raid, [{ id: "source@g.us", name: "A" }]);
  await assert.rejects(
    () => f.service.resolveRaid({ from: "source@g.us", hasQuotedMsg: false }, []),
    error => error.code === "NO_PUBLISHED_RAID"
  );
  assert.ok(f.joinLogs.includes("activeRaidFound=false"));
  assert.ok(f.joinLogs.includes("publicationFound=false"));
  assert.ok(f.joinLogs.includes("lookupStage=join"));
});
