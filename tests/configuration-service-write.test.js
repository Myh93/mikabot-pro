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

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-config-write-"));
  const repository = createConfigurationRepository({
    databaseDir: path.join(root, "database"),
    backupRoot: path.join(root, "backups")
  });
  const service = createConfigurationService();
  service.attachRepository(repository);
  await service.initialize();
  return { root, repository, service };
}

async function cleanup(item) {
  await fsp.rm(item.root, { recursive: true, force: true });
}

const KEY = "quiz.ranking.pageSize";

test("escreve override global explicitamente e atualiza o cache", async () => {
  const item = await fixture();
  try {
    const result = await item.service.setPersistent(KEY, 11);
    assert.deepEqual(result, { key: KEY, value: 11, source: "global" });
    assert.equal(item.service.get(KEY), 11);
    assert.equal((await item.repository.readGlobal()).values[KEY], 11);
    assert.equal(item.service.hasPersistentOverride(KEY), true);
  } finally {
    await cleanup(item);
  }
});

test("escreve por comunidade, plataforma, comunidade-plataforma e grupo", async () => {
  const item = await fixture();
  try {
    await item.service.setPersistent(KEY, 12, { communityId: "c1" });
    await item.service.setPersistent(KEY, 13, { platform: "whatsapp" });
    await item.service.setPersistent(KEY, 14, {
      communityId: "c1", platform: "whatsapp"
    });
    await item.service.setPersistent(KEY, 15, {
      communityId: "c1", platform: "whatsapp", groupId: "g1"
    });
    assert.equal(item.service.get(KEY, { communityId: "c1" }), 12);
    assert.equal(item.service.get(KEY, { platform: "whatsapp" }), 13);
    assert.equal(item.service.get(KEY, {
      communityId: "c1", platform: "whatsapp"
    }), 14);
    assert.equal(item.service.get(KEY, {
      communityId: "c1", platform: "whatsapp", groupId: "g1"
    }), 15);
  } finally {
    await cleanup(item);
  }
});

test("remoção apaga somente o override e revela o nível inferior", async () => {
  const item = await fixture();
  try {
    await item.service.setPersistent(KEY, 11);
    await item.service.setPersistent(KEY, 12, { communityId: "c1" });
    await item.service.setPersistent(KEY, 15, {
      communityId: "c1", platform: "whatsapp", groupId: "g1"
    });
    const removed = await item.service.removePersistentOverride(KEY, {
      communityId: "c1", platform: "whatsapp", groupId: "g1"
    });
    assert.equal(removed.removed, true);
    assert.deepEqual(removed.resolved, {
      key: KEY, value: 12, source: "community"
    });
    assert.equal(item.service.hasPersistentOverride(KEY, {
      communityId: "c1", platform: "whatsapp", groupId: "g1"
    }), false);
    assert.equal((await item.repository.readGroups())
      .groups["whatsapp:g1"].values[KEY], undefined);
    assert.equal((await item.repository.readGlobal()).values[KEY], 11);
  } finally {
    await cleanup(item);
  }
});

test("lista apenas overrides do escopo solicitado em ordem estável", async () => {
  const item = await fixture();
  try {
    await item.service.setPersistent("quiz.ranking.pageSize", 11);
    await item.service.setPersistent("quiz.cooldownSeconds", 5);
    const list = item.service.listPersistentOverrides();
    assert.deepEqual(list.map((entry) => entry.key), [
      "quiz.cooldownSeconds",
      "quiz.ranking.pageSize"
    ]);
    assert.ok(list.every((entry) => entry.scope === "global"));
    assert.equal(Object.isFrozen(list), true);
  } finally {
    await cleanup(item);
  }
});

test("cada alteração efetiva registra histórico", async () => {
  const item = await fixture();
  try {
    await item.service.setPersistent(KEY, 11);
    await item.service.removePersistentOverride(KEY);
    const historyDocument = JSON.parse(await fsp.readFile(
      path.join(item.root, "database", "history.json"),
      "utf8"
    ));
    assert.deepEqual(
      historyDocument.data.entries.map((entry) => entry.action),
      ["set", "remove"]
    );
    assert.ok(historyDocument.data.entries.every((entry) => entry.key === KEY));
  } finally {
    await cleanup(item);
  }
});

test("cache é substituído após escrita e reload externo", async () => {
  const item = await fixture();
  try {
    await item.service.setPersistent(KEY, 11);
    assert.equal(item.service.get(KEY), 11);
    await item.repository.writeGlobal({ values: { [KEY]: 19 } });
    assert.equal(item.service.get(KEY), 11);
    await item.service.reload();
    assert.equal(item.service.get(KEY), 19);
  } finally {
    await cleanup(item);
  }
});

test("gravações concorrentes são serializadas sem perda", async () => {
  const item = await fixture();
  try {
    const completed = [];
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
      item.service.setPersistent(KEY, index + 1).then(() => completed.push(index + 1))
    ));
    assert.equal(completed.length, 12);
    assert.equal(item.service.get(KEY), completed.at(-1));
    assert.equal((await item.repository.readGlobal()).values[KEY], completed.at(-1));
    const historyDocument = JSON.parse(await fsp.readFile(
      path.join(item.root, "database", "history.json"),
      "utf8"
    ));
    assert.equal(historyDocument.data.entries.length, 12);
  } finally {
    await cleanup(item);
  }
});

test("recusa invariantes, segredos, chaves desconhecidas e escopos inválidos", async () => {
  const item = await fixture();
  try {
    await assert.rejects(
      item.service.setPersistent("menus.directCommandsRemainAvailable", false),
      (error) => error.code === "CONFIGURATION_WRITE_FORBIDDEN"
    );
    await assert.rejects(
      item.service.setPersistent("telegram.botToken", "secret"),
      (error) => error.code === "CONFIGURATION_WRITE_FORBIDDEN"
    );
    await assert.rejects(
      item.service.setPersistent("unknown.value", true),
      (error) => error.code === "CONFIGURATION_KEY_UNKNOWN"
    );
    await assert.rejects(
      item.service.setPersistent("events.timezone", "UTC"),
      (error) => error.code === "CONFIGURATION_SCOPE_INVALID"
    );
  } finally {
    await cleanup(item);
  }
});

test("valida tipo, enum e nulabilidade antes da gravação", async () => {
  const item = await fixture();
  try {
    await assert.rejects(
      item.service.setPersistent(KEY, "dez"),
      (error) => error.code === "CONFIGURATION_VALUE_INVALID"
    );
    await assert.rejects(
      item.service.setPersistent("events.notifications.normalDestination", "todos", {
        communityId: "c1"
      }),
      (error) => error.code === "CONFIGURATION_VALUE_INVALID"
    );
    await item.service.setPersistent("backup.retentionCount", null);
    assert.equal(item.service.get("backup.retentionCount"), null);
  } finally {
    await cleanup(item);
  }
});

test("flush aguarda escritas, recarrega persistência e preserva runtime", async () => {
  const item = await fixture();
  try {
    item.service.set("quiz.cooldownSeconds", 30);
    const pending = item.service.setPersistent(KEY, 18);
    const result = await item.service.flush();
    await pending;
    assert.deepEqual(result, {
      synchronized: true,
      repositoryAttached: true
    });
    assert.equal(item.service.get(KEY), 18);
    assert.equal(item.service.get("quiz.cooldownSeconds"), 30);
  } finally {
    await cleanup(item);
  }
});
