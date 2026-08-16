"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createConfigurationRepository
} = require("../src/repositories/configurationRepository");
const {
  createConfigurationService
} = require("../src/services/configurationService");
const {
  createConfigurationAdministrationService
} = require("../src/services/configurationAdministrationService");

async function fixture(authorize = () => true) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-config-admin-"));
  const repository = createConfigurationRepository({
    databaseDir: path.join(root, "database"),
    backupRoot: path.join(root, "backups"),
    clock: () => new Date("2026-07-30T12:00:00.000Z")
  });
  const configurationService = createConfigurationService();
  configurationService.attachRepository(repository);
  await configurationService.initialize();
  const service = createConfigurationAdministrationService({
    configurationService,
    authorize,
    clock: () => new Date("2026-07-30T12:00:00.000Z")
  });
  return { root, repository, configurationService, service };
}

async function cleanup(item) {
  await fsp.rm(item.root, { recursive: true, force: true });
}

const KEY = "quiz.ranking.pageSize";
const ACTOR = { authorCanonical: "canonical:owner", origin: "unit-test" };

test("lê configuração, lista catálogo e informa a origem", async () => {
  const item = await fixture();
  try {
    assert.equal((await item.service.getConfiguration(KEY)).value, 10);
    assert.equal(await item.service.getConfigurationSource(KEY), "default");
    const configurations = await item.service.listConfigurations();
    assert.ok(configurations.some((entry) => entry.key === KEY && entry.value === 10));
    assert.ok(Object.isFrozen(configurations));
  } finally {
    await cleanup(item);
  }
});

test("grava e lista overrides em todos os escopos administrativos", async () => {
  const item = await fixture();
  try {
    const cases = [
      [{}, 11, "global"],
      [{ communityId: "community-1" }, 12, "community"],
      [{ platform: "whatsapp" }, 13, "platform"],
      [{ communityId: "community-1", platform: "whatsapp" }, 14, "communityPlatform"],
      [{ platform: "whatsapp", groupId: "group-1" }, 15, "group"]
    ];
    for (const [context, value, scope] of cases) {
      const complete = { ...context, ...ACTOR };
      const result = await item.service.setConfiguration(KEY, value, complete);
      assert.equal(result.value, value);
      const overrides = await item.service.listOverrides(context);
      assert.deepEqual(overrides.map((entry) => [entry.key, entry.value, entry.scope]), [
        [KEY, value, scope]
      ]);
    }
  } finally {
    await cleanup(item);
  }
});

test("remove override com motivo e revela o nível inferior", async () => {
  const item = await fixture();
  try {
    await item.service.setConfiguration(KEY, 11, ACTOR);
    await item.service.setConfiguration(KEY, 15, {
      ...ACTOR, platform: "whatsapp", groupId: "group-1"
    });
    const result = await item.service.removeConfiguration(KEY, {
      ...ACTOR,
      platform: "whatsapp",
      groupId: "group-1",
      reason: "Correção administrativa"
    });
    assert.equal(result.removed, true);
    assert.equal(result.resolved.value, 11);
    assert.equal(result.resolved.source, "global");
  } finally {
    await cleanup(item);
  }
});

test("respeita autorização aceita e nega sem mutação", async () => {
  const actions = [];
  const allowed = await fixture((action) => {
    actions.push(action);
    return true;
  });
  try {
    await allowed.service.getConfiguration(KEY);
    assert.deepEqual(actions, ["getConfiguration"]);
  } finally {
    await cleanup(allowed);
  }

  const denied = await fixture(() => false);
  try {
    await assert.rejects(
      denied.service.setConfiguration(KEY, 20, ACTOR),
      (error) => error.code === "CONFIGURATION_ADMINISTRATION_DENIED"
    );
    assert.equal(denied.configurationService.get(KEY), 10);
  } finally {
    await cleanup(denied);
  }
});

test("exige motivo em chave restrita e em toda remoção", async () => {
  const item = await fixture();
  try {
    await assert.rejects(
      item.service.setConfiguration("registration.defaultPrivacy", {}, {
        ...ACTOR,
        communityId: "community-1"
      }),
      (error) => error.code === "CONFIGURATION_REASON_REQUIRED"
    );
    await assert.rejects(
      item.service.removeConfiguration(KEY, ACTOR),
      (error) => error.code === "CONFIGURATION_REASON_REQUIRED"
    );
    await item.service.setConfiguration("registration.defaultPrivacy", {}, {
      ...ACTOR,
      reason: "Manutenção programada",
      communityId: "community-1"
    });
  } finally {
    await cleanup(item);
  }
});

test("delega validação ao configurationService sem gravar", async () => {
  const item = await fixture();
  try {
    const result = await item.service.validateConfiguration(KEY, 25, {});
    assert.equal(result.valid, true);
    assert.equal(result.scope, "global");
    assert.equal(item.configurationService.get(KEY), 10);
    await assert.rejects(
      item.service.validateConfiguration(KEY, "25", {}),
      (error) => error.code === "CONFIGURATION_VALUE_INVALID"
    );
  } finally {
    await cleanup(item);
  }
});

test("registra auditoria completa das alterações", async () => {
  const item = await fixture();
  try {
    await item.service.setConfiguration("joinRequest.enabled", false, {
      ...ACTOR,
      reason: "Janela operacional",
      communityId: "community-1"
    });
    await item.service.removeConfiguration("joinRequest.enabled", {
      ...ACTOR,
      reason: "Fim da janela",
      communityId: "community-1"
    });
    const history = JSON.parse(await fsp.readFile(
      path.join(item.root, "database", "history.json"),
      "utf8"
    )).data.entries;
    assert.deepEqual(history.map((entry) => ({
      action: entry.action,
      author: entry.author,
      origin: entry.origin,
      scope: entry.scope,
      key: entry.key,
      reason: entry.reason,
      date: entry.date
    })), [
      {
        action: "set",
        author: "canonical:owner",
        origin: "unit-test",
        scope: "community",
        key: "joinRequest.enabled",
        reason: "Janela operacional",
        date: "2026-07-30T12:00:00.000Z"
      },
      {
        action: "remove",
        author: "canonical:owner",
        origin: "unit-test",
        scope: "community",
        key: "joinRequest.enabled",
        reason: "Fim da janela",
        date: "2026-07-30T12:00:00.000Z"
      }
    ]);
  } finally {
    await cleanup(item);
  }
});

test("mantém override runtime como prioridade", async () => {
  const item = await fixture();
  try {
    item.configurationService.set(KEY, 30);
    const persisted = await item.service.setConfiguration(KEY, 18, ACTOR);
    assert.equal(persisted.value, 30);
    assert.equal(persisted.source, "runtime");
    assert.equal(await item.service.getConfigurationSource(KEY), "runtime");
    assert.equal((await item.repository.readGlobal()).values[KEY], 18);
  } finally {
    await cleanup(item);
  }
});

test("requer autorizador externo e autor canônico para alterações", async () => {
  assert.throws(
    () => createConfigurationAdministrationService({
      configurationService: createConfigurationService()
    }),
    (error) => error.code === "CONFIGURATION_AUTHORIZER_REQUIRED"
  );
  const item = await fixture();
  try {
    await assert.rejects(
      item.service.setConfiguration(KEY, 11, {}),
      (error) => error.code === "CONFIGURATION_AUDIT_AUTHOR_REQUIRED"
    );
  } finally {
    await cleanup(item);
  }
});
