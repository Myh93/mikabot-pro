"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const health = require("../src/services/whatsappClientHealthService");

function clientWithEvaluate(evaluate) {
  return {
    pupBrowser: { connected: true },
    pupPage: { isClosed: () => false, evaluate },
    getChats: async () => []
  };
}

test.beforeEach(() => health.resetClientHealthForTests());

test("preserva message.id._serialized existente sem chamar toString", () => {
  let called = false;
  const id = { _serialized: "existing-id", toString() { called = true; return "other-id"; } };
  assert.deepEqual(health.ensureMessageIdSerialized({ id }), {
    ok: true, changed: false, serialized: "existing-id", errorCode: null
  });
  assert.equal(called, false);
  assert.equal(id._serialized, "existing-id");
});

test("recompõe message.id._serialized com toString e binding correto", () => {
  const id = { value: "derived-id", toString() { return this.value; } };
  assert.deepEqual(health.ensureMessageIdSerialized({ id }), {
    ok: true, changed: true, serialized: "derived-id", errorCode: null
  });
  assert.equal(id._serialized, "derived-id");
});

test("recusa IDs ausentes ou toString inválido com código controlado", () => {
  assert.equal(health.ensureMessageIdSerialized(null).errorCode, "message_invalid");
  assert.equal(health.ensureMessageIdSerialized({}).errorCode, "message_id_missing");
  assert.equal(health.ensureMessageIdSerialized({ id: Object.create(null) }).errorCode, "message_id_to_string_unavailable");
  assert.equal(health.ensureMessageIdSerialized({ id: { toString: () => "" } }).errorCode, "message_id_to_string_invalid");
  assert.equal(health.ensureMessageIdSerialized({ id: {} }).errorCode, "message_id_to_string_invalid");
  assert.equal(health.ensureMessageIdSerialized({ id: { toString() { throw new Error("unavailable"); } } }).errorCode, "message_id_to_string_failed");
});

test("resolve IDs oficiais retornados por Message e pelo modelo _data", () => {
  assert.equal(health.resolveOfficialMessageId({ id: "direct-id" }), "direct-id");
  assert.equal(health.resolveOfficialMessageId({ id: { _serialized: "serialized-id" } }), "serialized-id");
  assert.equal(health.resolveOfficialMessageId({ id: { id: "stanza-id" } }), "stanza-id");
  assert.equal(health.resolveOfficialMessageId({
    id: { value: "converted-id", toString() { return this.value; } }
  }), "converted-id");
  assert.equal(health.resolveOfficialMessageId({
    id: {},
    _data: { id: { _serialized: "model-id" } }
  }), "model-id");
});

test("resolve serialized Message ID na precedÃªncia segura sem fabricar chave", () => {
  const existing = "false_group@g.us_A1B2C3_member@lid";
  const dataExisting = "true_member@c.us_D4E5F6";
  const fromId = "false_group@g.us_F7A8B9_member@c.us";
  const fromData = "true_member@lid_C1D2E3";
  assert.equal(health.resolveSerializedMessageId({
    id: { _serialized: existing, toString: () => { throw new Error("must not win"); } },
    _data: { id: { _serialized: dataExisting } }
  }), existing);
  assert.equal(health.resolveSerializedMessageId({ id: {}, _data: { id: { _serialized: dataExisting } } }), dataExisting);
  assert.equal(health.resolveSerializedMessageId({ id: { toString() { assert.equal(this.marker, true); return fromId; }, marker: true } }), fromId);
  assert.equal(health.resolveSerializedMessageId({ id: {}, _data: { id: { toString: () => fromData } } }), fromData);
  for (const invalid of ["", "[object Object]", "stanza-only", "false_missing_remote", "false_group@g.us_"]) {
    assert.equal(health.resolveSerializedMessageId({ id: { toString: () => invalid } }), null);
  }
  assert.equal(health.resolveSerializedMessageId({}), null);
});

test("diagnÃ³stico do serialized ID contÃ©m somente estrutura e preserva prototype", () => {
  class MessageId {
    toString() { return "false_group@g.us_AABBCC_member@lid"; }
  }
  const id = new MessageId();
  const before = Object.getPrototypeOf(id);
  const details = health.resolveSerializedMessageIdDetails({ id, _data: { id: {} } });
  assert.equal(details.source, "id_toString");
  assert.equal(details.idInspection.constructorName, "MessageId");
  assert.equal(details.idInspection.toStringSucceeded, true);
  assert.equal(details.idInspection.toStringValidShape, true);
  assert.equal(details.idInspection.toStringValue, details.serializedId);
  assert.equal(Object.getPrototypeOf(id), before);
  assert.equal(id._serialized, undefined);
});

test("resolve MessageKey pela factory oficial no browser sem concatenar campos", async () => {
  const source = { fromMe: false, id: "stanza", remote: { user: "group", server: "g.us" }, participant: { user: "member", server: "lid" } };
  const page = {
    async evaluate(_callback, input) {
      assert.deepEqual(input, source);
      return {
        factoryAvailable: true,
        factoryName: "MsgKey",
        factoryAccepted: true,
        serialized: "false_group@g.us_A1B2C3_member@lid"
      };
    }
  };
  const message = { id: source, client: { pupPage: page } };
  const details = await health.resolveOfficialSerializedMessageIdDetails(message);
  assert.equal(details.serializedId, "false_group@g.us_A1B2C3_member@lid");
  assert.equal(details.source, "official_factory");
  assert.equal(details.officialFactoryAvailable, true);
  assert.equal(details.officialFactoryName, "MsgKey");
  assert.equal(details.officialFactoryAccepted, true);
  assert.equal(message.id._serialized, undefined);
});

test("factory oficial ausente ou rejeitando retorna falha controlada", async () => {
  const id = { fromMe: true, id: "stanza", remote: { user: "member", server: "c.us" } };
  const unavailable = await health.resolveOfficialSerializedMessageIdDetails({
    id,
    client: { pupPage: { evaluate: async () => ({ factoryAvailable: false, factoryName: "unavailable", factoryAccepted: false, serialized: null }) } }
  });
  assert.equal(unavailable.serializedId, null);
  assert.equal(unavailable.officialFactoryAvailable, false);
  const rejected = await health.resolveOfficialSerializedMessageIdDetails({
    id,
    client: { pupPage: { evaluate: async () => ({ factoryAvailable: true, factoryName: "MsgKey", factoryAccepted: false, serialized: null }) } }
  });
  assert.equal(rejected.serializedId, null);
  assert.equal(rejected.officialFactoryAvailable, true);
  assert.equal(rejected.officialFactoryAccepted, false);
  assert.equal(await health.resolveOfficialSerializedMessageId({ id }), null);
});

test("não fabrica ID quando o retorno oficial é ausente ou inválido", () => {
  assert.equal(health.resolveOfficialMessageId(null), null);
  assert.equal(health.resolveOfficialMessageId({}), null);
  assert.equal(health.resolveOfficialMessageId({ id: {} }), null);
  assert.equal(health.resolveOfficialMessageId({ id: { toString: () => "[object Object]" } }), null);
  assert.equal(health.resolveOfficialMessageId({ id: { toString() { throw new Error("unavailable"); } } }), null);
});

test("descreve somente a estrutura oficial do retorno sem expor valores", () => {
  const shape = health.describeOfficialMessageIdShape({
    id: { id: "secret-id", remote: "secret-group" },
    _data: { id: { _serialized: "secret-serialized" } }
  });
  const output = shape.join("\n");
  assert.match(output, /resultType=object/);
  assert.match(output, /hasId=true/);
  assert.match(output, /idKeys=id,remote/);
  assert.match(output, /hasData=true/);
  assert.match(output, /dataIdKeys=_serialized/);
  assert.match(output, /hasSerialized=true/);
  assert.doesNotMatch(output, /secret/);
});

test("descreve retorno ausente, array e método sem executar toString", () => {
  let called = false;
  const objectShape = health.describeOfficialMessageIdShape({
    id: { toString() { called = true; return "secret"; } }
  });
  assert.equal(called, false);
  assert.ok(objectShape.includes("hasToString=true"));
  assert.ok(health.describeOfficialMessageIdShape(undefined).includes("resultType=undefined"));
  assert.ok(health.describeOfficialMessageIdShape([]).includes("resultType=array"));
});

test("getQuotedMessageSafe usa o método normal após compatibilidade", async () => {
  const quoted = { author: "member@lid" };
  const message = {
    hasQuotedMsg: true,
    id: { value: "command-id", toString() { return this.value; } },
    getQuotedMessage: async function () {
      assert.equal(this.id._serialized, "command-id");
      return quoted;
    }
  };
  const result = await health.getQuotedMessageSafe(message);
  assert.equal(result.ok, true);
  assert.equal(result.quotedMessage, quoted);
});

test("getQuotedMessageSafe usa ID oficial direto de _data.quotedMsg sem carregar objeto", async () => {
  let called = false;
  const result = await health.getQuotedMessageSafe({
    hasQuotedMsg: true,
    id: {},
    _data: { quotedMsg: { id: { _serialized: "official-quoted-message" } } },
    getQuotedMessage: async () => { called = true; return null; }
  }, { allowIdOnly: true });
  assert.equal(result.ok, true);
  assert.equal(result.messageId, "official-quoted-message");
  assert.equal(result.quotedMessage, null);
  assert.equal(result.source, "direct");
  assert.equal(called, false);
});

test("getQuotedMessageSafe preserva objeto completo para consumidores da Moderação", async () => {
  const quoted = { id: { _serialized: "official-quoted-message" }, author: "member@lid" };
  let called = false;
  const result = await health.getQuotedMessageSafe({
    hasQuotedMsg: true,
    id: { _serialized: "command-message" },
    _data: { quotedMsg: { id: { _serialized: "official-quoted-message" } } },
    getQuotedMessage: async () => { called = true; return quoted; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.quotedMessage, quoted);
  assert.equal(result.messageId, "official-quoted-message");
  assert.equal(called, true);
});

test("getQuotedMessageSafe informa message_id_to_string_invalid sem chamar consulta", async () => {
  let called = false;
  const result = await health.getQuotedMessageSafe({
    hasQuotedMsg: true,
    id: { toString: () => "[object Object]" },
    getQuotedMessage: async () => { called = true; return null; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "message_id_to_string_invalid");
  assert.equal(called, false);
});

test("getQuotedMessageSafe recompõe chave estrutural no navegador após DataError", async () => {
  const previousWindow = global.window;
  const quotedModel = { author: "member@lid", id: { id: "quoted" } };
  const commandModel = { quoted: quotedModel };
  global.window = {
    require(name) {
      if (name === "WAWebMsgKey") return class MsgKey {
        constructor(data) { this._serialized = `${data.fromMe}_${data.remote._serialized}_${data.id}`; }
      };
      if (name === "WAWebWidFactory") return { createWid: value => ({ _serialized: value }) };
      if (name === "WAWebCollections") return {
        Msg: { get: key => key === "false_group@g.us_command" ? commandModel : null, getMessagesById: async () => ({ messages: [] }) }
      };
      if (name === "WAWebQuotedMsgModelUtils") return { getQuotedMsgObj: value => value.quoted };
      throw new Error("unexpected module");
    },
    WWebJS: { getMessageModel: value => value }
  };
  const client = { pupPage: { evaluate: async (callback, data) => callback(data) } };
  const message = {
    hasQuotedMsg: true,
    id: Object.preventExtensions({ toString: () => "invalid-command-key" }),
    _data: { id: { fromMe: false, remote: "group@g.us", id: "command" }, quotedMsg: true },
    client,
    getQuotedMessage: async () => {
      const error = new Error("Failed to execute 'get' on 'IDBObjectStore': No key or key range specified.");
      error.name = "DataError";
      throw error;
    }
  };
  try {
    const result = await health.getQuotedMessageSafe(message);
    assert.equal(result.ok, true);
    assert.equal(result.quotedMessage.author, "member@lid");
    assert.equal(result.quotedMessage.client, client);
    assert.equal(typeof result.quotedMessage.getContact, "function");
  } finally {
    global.window = previousWindow;
  }
});

test("getQuotedMessageSafe usa metadados estruturais após DataError", async () => {
  const previousWindow = global.window;
  const quotedModel = {
    author: "member@lid",
    id: { id: "quoted", remote: "group@g.us", fromMe: false }
  };
  global.window = {
    require(name) {
      if (name === "WAWebMsgKey") return class MsgKey {
        constructor(data) { this._serialized = `${data.fromMe}_${data.remote._serialized}_${data.id}`; }
      };
      if (name === "WAWebWidFactory") return { createWid: value => ({ _serialized: value }) };
      if (name === "WAWebCollections") return { Msg: { get: () => ({ quoted: quotedModel }), getMessagesById: async () => ({ messages: [] }) } };
      if (name === "WAWebQuotedMsgModelUtils") return { getQuotedMsgObj: value => value.quoted };
      throw new Error("unexpected module");
    },
    WWebJS: { getMessageModel: value => value }
  };
  const client = { pupPage: { evaluate: async (callback, data) => callback(data) } };
  const message = {
    hasQuotedMsg: true,
    id: { _serialized: "incompatible-key" },
    _data: { id: { fromMe: false, remote: "group@g.us", id: "command" }, quotedMsg: true },
    client,
    getQuotedMessage: async () => {
      const error = new Error("No key or key range specified");
      error.name = "DataError";
      throw error;
    }
  };
  try {
    const result = await health.getQuotedMessageSafe(message);
    assert.equal(result.ok, true);
    assert.equal(result.quotedMessage.author, "member@lid");
    assert.equal(typeof result.quotedMessage.getContact, "function");
  } finally {
    global.window = previousWindow;
  }
});

test("getQuotedMessageSafe falha de modo controlado sem citação ou método", async () => {
  const absent = await health.getQuotedMessageSafe({ id: {} });
  assert.deepEqual(absent, {
    ok: false,
    messageId: null,
    quotedMessage: null,
    source: null,
    errorCode: "quoted_message_absent"
  });
  const unavailable = await health.getQuotedMessageSafe({ hasQuotedMsg: true, id: {} });
  assert.deepEqual(unavailable, {
    ok: false,
    messageId: null,
    quotedMessage: null,
    source: null,
    errorCode: "quoted_message_method_unavailable"
  });
});

test("logs de citação não expõem IDs durante DataError", async () => {
  const lines = [], original = console.log;
  console.log = value => lines.push(String(value));
  try {
    await health.getQuotedMessageSafe({
      hasQuotedMsg: true,
      id: { _serialized: "false_group@g.us_ABCDEF1234567890" },
      getQuotedMessage: async () => {
        const error = new Error("DataError false_group@g.us_ABCDEF1234567890 https://secret.example/123456789");
        error.name = "DataError";
        throw error;
      }
    });
  } finally {
    console.log = original;
  }
  const output = lines.join("\n");
  assert.match(output, /\[QUOTED\] getQuotedSuccess=false/);
  assert.doesNotMatch(output, /group@g\.us|ABCDEF1234567890|secret\.example|123456789/);
});

test("classifica falhas centrais", () => {
  assert.equal(
    health.classifyBrowserError(new Error("Failed to execute get on IDBObjectStore: No key or key range specified")),
    "incompatible_web_version"
  );
  assert.equal(health.classifyBrowserError(new Error("Execution context was destroyed")), "execution_context_destroyed");
  assert.equal(health.classifyBrowserError(new Error("Target closed")), "target_closed");
  assert.equal(health.classifyBrowserError(new Error("Evaluation failed")), "puppeteer_evaluation_failed");
});

test("detecta navegador desconectado e página fechada", async () => {
  await assert.rejects(
    health.verifyWWebJSInjection({ pupBrowser: { connected: false } }),
    /browser disconnected/
  );
  await assert.rejects(
    health.verifyWWebJSInjection({
      pupBrowser: { connected: true },
      pupPage: { isClosed: () => true }
    }),
    /target closed/
  );
});

test("valida injeção e APIs ausentes", async () => {
  const client = clientWithEvaluate(async () => ({
    injected: false,
    getChat: false,
    getChats: false,
    require: true
  }));
  assert.deepEqual(await health.verifyWWebJSInjection(client), {
    injected: false,
    getChat: false,
    getChats: false,
    require: true
  });
  await assert.rejects(health.verifyChatApis(client), /wwebjs missing/);
});

test("diagnóstico saudável instala compatibilidade uma vez e valida getChats", async () => {
  const replies = [
    { injected: true, getChat: true, getChats: true, require: true },
    { injected: true, getChat: true, getChats: true, require: true },
    { collections: true, chatCollection: true, chatCount: 2 },
    { groupAvailable: true, participantsArray: true, participantsCount: 3 },
    { installed: true, alreadyInstalled: false },
    { installed: true, alreadyInstalled: false }
  ];
  let evaluations = 0;
  const client = clientWithEvaluate(async () => replies[evaluations++]);
  const result = await health.diagnoseClientHealth(client);
  assert.equal(result.status, "healthy");
  assert.equal(result.details.chatApis.chatsArray, true);
  assert.equal(result.details.metadata.participantsCount, 3);
  assert.equal(result.details.sendDiagnostic.installed, true);
  assert.equal(evaluations, 6);
  assert.deepEqual(await health.diagnoseClientHealth(client), result);
  assert.equal(evaluations, 6);
});

test("diagnóstico preserva falha segura quando getChats falha", async () => {
  const replies = [
    { injected: true, getChat: true, getChats: true, require: true },
    { injected: true, getChat: true, getChats: true, require: true },
    { collections: true, chatCollection: true, chatCount: 1 },
    { groupAvailable: true, participantsArray: true, participantsCount: 1 },
    { installed: true, alreadyInstalled: false },
    { installed: true, alreadyInstalled: false }
  ];
  let evaluations = 0;
  const client = clientWithEvaluate(async () => replies[evaluations++]);
  client.getChats = async () => {
    throw new Error("Failed to execute get on IDBObjectStore: No key or key range specified");
  };
  const result = await health.diagnoseClientHealth(client);
  assert.equal(result.status, "unhealthy");
  assert.equal(result.errorCode, "incompatible_web_version");
});

test("compatibilidade recompõe somente a chave serializada ausente", async () => {
  const previousWindow = global.window;
  let receivedKey = null;
  global.window = {
    WWebJS: {
      getChatModel: async chat => {
        receivedKey = chat.lastReceivedKey._serialized;
        return { isGroup: true };
      }
    }
  };
  const client = clientWithEvaluate(async callback => callback());
  try {
    assert.deepEqual(await health.installChatSerializationCompatibility(client), {
      installed: true,
      alreadyInstalled: false
    });
    const key = { toString: () => "serialized-key" };
    const result = await global.window.WWebJS.getChatModel({ lastReceivedKey: key });
    assert.deepEqual(result, { isGroup: true });
    assert.equal(receivedKey, "serialized-key");
    assert.equal(key._serialized, "serialized-key");
    assert.deepEqual(await health.installChatSerializationCompatibility(client), {
      installed: true,
      alreadyInstalled: true
    });
  } finally {
    global.window = previousWindow;
  }
});

test("diagnóstico do envio observa somente a mesma chave exata e não altera os retornos", async () => {
  const previousWindow = global.window;
  const reports = [];
  class MsgKey {
    constructor(serialized) {
      this._serialized = serialized;
      this.id = "opaque";
      this.remote = {};
      this.fromMe = true;
    }
    toString() { return this._serialized; }
    toJSON() { return { id: this.id, remote: this.remote, fromMe: this.fromMe }; }
  }
  const model = { id: new MsgKey("true_remote_id") };
  let exactReads = 0;
  const sendAction = {
    addAndSendMsgToChat() {
      return [
        Promise.resolve("msg-result"),
        Promise.resolve({ id: { _serialized: "send-key" }, message: {} })
      ];
    }
  };
  global.window = {
    WWebJS: {
      getMessageModel: value => ({ id: value.id })
    },
    require(name) {
      if (name === "WAWebSendMsgChatAction") return sendAction;
      if (name === "WAWebMsgKey") return MsgKey;
      if (name === "WAWebCollections") {
        return {
          Msg: {
            get(key) {
              assert.equal(key, "true_remote_id");
              exactReads += 1;
              return exactReads >= 3 ? model : undefined;
            }
          }
        };
      }
      throw new Error(`unexpected module ${name}`);
    },
    onMikaWWebSendDiagnostic: async report => reports.push(report)
  };
  const client = clientWithEvaluate(async callback => callback());
  try {
    assert.deepEqual(await health.installWWebSendDiagnostic(client), {
      installed: true,
      alreadyInstalled: false
    });
    global.window.WWebJS.getMessageModel({ id: {
      _serialized: "false_reference_remote",
      id: "opaque",
      remote: "opaque",
      fromMe: false
    } });
    const [msgPromise, sendResultPromise] = sendAction.addAndSendMsgToChat({}, {
      id: new MsgKey("true_remote_id")
    });
    assert.equal(await msgPromise, "msg-result");
    assert.deepEqual(await sendResultPromise, {
      id: { _serialized: "send-key" },
      message: {}
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].newMsgKeyPresent, true);
    assert.equal(reports[0].serializedKeyPresent, true);
    assert.equal(reports[0].msgPromiseResolved, true);
    assert.equal(reports[0].sendResultResolved, true);
    assert.equal(reports[0].collectionImmediateFound, false);
    assert.equal(reports[0].collectionAfterSendFound, true);
    assert.equal(reports[0].exactKeyAttemptCount, 1);
    assert.equal(reports[0].exactKeyEventuallyFound, true);
    assert.equal(reports[0].modelSerializationSucceeded, true);
    assert.equal(reports[0].newMsgKeyShape.constructorName, "MsgKey");
    assert.equal(reports[0].newMsgKeyShape.toStringOwner, "prototype");
    assert.equal(reports[0].newMsgKeyShape.toStringSucceeded, true);
    assert.equal(reports[0].newMsgKeyShape.toStringValidShape, true);
    assert.equal(reports[0].newMsgKeyShape.hasMethodToJSON, true);
    assert.equal(reports[0].referenceMessageIdShape.hasSerialized, true);
    assert.equal(reports[0].keyInstanceOfFactory, true);
    assert.equal(reports[0].factoryObjectAccepted, true);
    assert.equal(reports[0].raidCompatibilityRequested, false);
    assert.equal(reports[0].officialKeyApplied, false);
    assert.deepEqual(await health.installWWebSendDiagnostic(client), {
      installed: true,
      alreadyInstalled: true
    });
  } finally {
    global.window = previousWindow;
  }
});

test("valida newMsgKey.toString diretamente na coleção sem usar ou expor a chave", async () => {
  const previousWindow = global.window;
  const reports = [];
  class MsgKey {
    constructor() {
      this.id = "opaque";
      this.remote = {};
      this.fromMe = true;
    }
    toString() { return "true_private_key"; }
  }
  const model = { id: { _serialized: "hidden" } };
  let receivedMessage = null;
  const sendAction = {
    addAndSendMsgToChat(_chat, message) {
      receivedMessage = message;
      return [Promise.resolve(), Promise.resolve({ messageSendResult: "ok" })];
    }
  };
  global.window = {
    WWebJS: { getMessageModel: value => ({ id: value.id }) },
    require(name) {
      if (name === "WAWebSendMsgChatAction") return sendAction;
      if (name === "WAWebMsgKey") return MsgKey;
      if (name === "WAWebCollections") {
        return { Msg: { get: key => key === "true_private_key" ? model : undefined } };
      }
      throw new Error(`unexpected module ${name}`);
    },
    onMikaWWebSendDiagnostic: async report => reports.push(report)
  };
  const client = clientWithEvaluate(async callback => callback());
  try {
    await health.installWWebSendDiagnostic(client);
    const newMsgKey = new MsgKey();
    const pair = sendAction.addAndSendMsgToChat({}, {
      id: newMsgKey,
      mikaRaidResolveOfficialMessageKey: true
    });
    await Promise.all(pair);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(newMsgKey._serialized, "true_private_key");
    assert.equal(Object.prototype.hasOwnProperty.call(receivedMessage, "mikaRaidResolveOfficialMessageKey"), false);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].serializedKeyPresent, false);
    assert.equal(reports[0].newMsgKeyShape.toStringValidShape, true);
    assert.equal(reports[0].collectionByToStringAfterMsgFound, true);
    assert.equal(reports[0].collectionByToStringAfterSendFound, true);
    assert.equal(reports[0].toStringExactAttemptCount, 1);
    assert.equal(reports[0].collectionByToStringEventuallyFound, true);
    assert.equal(reports[0].toStringModelSerializationSucceeded, true);
    assert.equal(reports[0].raidCompatibilityRequested, true);
    assert.equal(reports[0].officialKeyApplied, true);
    assert.doesNotMatch(JSON.stringify(reports[0]), /true_private_key/);
  } finally {
    global.window = previousWindow;
  }
});

test("compatibilidade não altera envios comuns nem chaves oficiais inválidas", async () => {
  const previousWindow = global.window;
  class ValidKey {
    toString() { return "true_private_key"; }
  }
  class InvalidKey {
    toString() { return "[object Object]"; }
  }
  const sendAction = {
    addAndSendMsgToChat() {
      return [Promise.resolve(), Promise.resolve({ messageSendResult: "ok" })];
    }
  };
  global.window = {
    WWebJS: { getMessageModel: value => value },
    require(name) {
      if (name === "WAWebSendMsgChatAction") return sendAction;
      if (name === "WAWebMsgKey") return ValidKey;
      if (name === "WAWebCollections") return { Msg: { get: () => undefined } };
      throw new Error(`unexpected module ${name}`);
    }
  };
  const client = clientWithEvaluate(async callback => callback());
  try {
    await health.installWWebSendDiagnostic(client);
    const commonKey = new ValidKey();
    const invalidKey = new InvalidKey();
    await Promise.all(sendAction.addAndSendMsgToChat({}, { id: commonKey }));
    await Promise.all(sendAction.addAndSendMsgToChat({}, {
      id: invalidKey,
      mikaRaidResolveOfficialMessageKey: true
    }));
    assert.equal(commonKey._serialized, undefined);
    assert.equal(invalidKey._serialized, undefined);
    await new Promise(resolve => setTimeout(resolve, 120));
  } finally {
    global.window = previousWindow;
  }
});
