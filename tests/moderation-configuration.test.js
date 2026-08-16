"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const {
  createModerationRepository
} = require("../src/repositories/moderationRepository");
const {
  createModerationService
} = require("../src/services/moderationService");

async function fixture(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-mod-config-"));
  const dataDir = path.join(root, "moderation");
  const backupRoot = path.join(root, "backups");
  const repository = createModerationRepository({ dataDir, backupRoot });
  if (Object.prototype.hasOwnProperty.call(options, "persistedLimit")) {
    await repository.updateGroupConfig("group@g.us", {
      settings: { warnings: { limit: options.persistedLimit } }
    });
  }
  let calls = 0;
  let receivedContext = null;
  const configurationService = Object.prototype.hasOwnProperty.call(
    options,
    "configurationService"
  ) ? options.configurationService : {
    getResolved: (key, context) => {
      calls += 1;
      receivedContext = context;
      if (options.configurationError) throw new Error("configuration unavailable");
      return {
        key,
        value: options.configurationValue,
        source: options.configurationSource || "default"
      };
    }
  };
  const moderation = createModerationService({
    repository,
    configurationService
  });
  return {
    root,
    dataDir,
    backupRoot,
    repository,
    moderation,
    calls: () => calls,
    context: () => receivedContext
  };
}

async function addWarning(fixture, receiptId = "MSG-1") {
  return fixture.moderation.warnPlayer({
    groupId: "group@g.us",
    targetId: "member@lid",
    targetParticipant: {
      id: "member@lid",
      isAdmin: false,
      isSuperAdmin: false
    },
    actorId: "admin@lid",
    actorRole: { name: "admin", rank: 2, isAdmin: true },
    botId: "bot@lid",
    reason: "Teste",
    receiptId
  });
}

test("default interno permanece 3 sem configuração persistida", async () => {
  const f = await fixture({ configurationValue: 3, configurationSource: "default" });
  const result = await addWarning(f);
  assert.equal(result.limit, 3);
});

test("valor persistido no moderationRepository prevalece sobre default do catálogo", async () => {
  const f = await fixture({
    persistedLimit: 7,
    configurationValue: 3,
    configurationSource: "default"
  });
  const result = await addWarning(f);
  assert.equal(result.limit, 7);
});

test("override runtime válido tem precedência sobre o repository", async () => {
  const f = await fixture({
    persistedLimit: 7,
    configurationValue: 9,
    configurationSource: "runtime"
  });
  const result = await addWarning(f);
  assert.equal(result.limit, 9);
  assert.deepEqual(f.context(), {
    platform: "whatsapp",
    groupId: "group@g.us"
  });
});

test("override persistente do ConfigurationService tem precedência", async () => {
  const f = await fixture({
    persistedLimit: 7,
    configurationValue: 8,
    configurationSource: "group"
  });
  const result = await addWarning(f);
  assert.equal(result.limit, 8);
  assert.equal(f.calls(), 1);
});

test("ConfigurationService ausente usa o valor persistido", async () => {
  const f = await fixture({
    persistedLimit: 6,
    configurationService: null
  });
  assert.equal((await addWarning(f)).limit, 6);
});

test("exceção no ConfigurationService usa o valor persistido", async () => {
  const f = await fixture({
    persistedLimit: 6,
    configurationError: true
  });
  assert.equal((await addWarning(f)).limit, 6);
});

for (const [label, value] of [
  ["undefined", undefined],
  ["null", null],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["decimal", 2.5],
  ["string", "8"],
  ["boolean", true],
  ["zero", 0],
  ["negativo", -4]
]) {
  test(`override ${label} é rejeitado e usa o valor persistido`, async () => {
    const f = await fixture({
      persistedLimit: 6,
      configurationValue: value,
      configurationSource: "runtime"
    });
    assert.equal((await addWarning(f)).limit, 6);
  });
}

test("equivalência anterior é preservada sem override", async () => {
  const f = await fixture({
    persistedLimit: 4,
    configurationValue: 3,
    configurationSource: "default"
  });
  const results = [];
  for (let index = 1; index <= 4; index += 1) {
    results.push(await addWarning(f, `MSG-${index}`));
  }
  assert.deepEqual(results.map(item => item.activeCount), [1, 2, 3, 4]);
  assert.deepEqual(results.map(item => item.crossedLimit), [false, false, false, true]);
});

test("proteção de administradores e do bot permanece inalterada", async () => {
  const f = await fixture({
    configurationValue: 10,
    configurationSource: "runtime"
  });
  for (const input of [
    {
      targetId: "admin@lid",
      targetParticipant: { id: "admin@lid", isAdmin: true }
    },
    {
      targetId: "bot@lid",
      targetParticipant: { id: "bot@lid", isAdmin: true }
    }
  ]) {
    await assert.rejects(
      f.moderation.warnPlayer({
        groupId: "group@g.us",
        ...input,
        actorId: "moderator@lid",
        actorRole: { rank: 1, isModerator: true },
        botId: "bot@lid",
        reason: "Teste"
      }),
      error => ["ADMIN_PROTECTED", "BOT_PROTECTED"].includes(error.code)
    );
  }
});

test("override não modifica nem regrava o banco da Moderação", async () => {
  const f = await fixture({
    persistedLimit: 5,
    configurationValue: 11,
    configurationSource: "group"
  });
  assert.equal((await addWarning(f)).limit, 11);
  const reloadedRepository = createModerationRepository({
    dataDir: f.dataDir,
    backupRoot: f.backupRoot
  });
  const persisted = await reloadedRepository.getGroupConfig("group@g.us");
  assert.equal(persisted.settings.warnings.limit, 5);
});

