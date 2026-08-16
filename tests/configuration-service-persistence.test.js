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

async function fixture(repositoryOptions = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-config-integration-"));
  const databaseDir = path.join(root, "database");
  const backupRoot = path.join(root, "backups");
  const repository = createConfigurationRepository({
    databaseDir,
    backupRoot,
    ...repositoryOptions
  });
  return { root, databaseDir, backupRoot, repository };
}

async function cleanup(item) {
  await fsp.rm(item.root, { recursive: true, force: true });
}

test("sem repository preserva defaults e overrides em memória", async () => {
  const service = createConfigurationService();
  assert.deepEqual(
    await service.initialize(),
    { initialized: true, repositoryAttached: false }
  );
  assert.equal(service.get("quiz.ranking.pageSize"), 10);
  assert.equal(service.getResolved("quiz.ranking.pageSize").source, "default");
  service.set("quiz.ranking.pageSize", 12);
  assert.equal(service.get("quiz.ranking.pageSize"), 12);
  assert.equal(service.getResolved("quiz.ranking.pageSize").source, "runtime");
});

test("attachRepository não inicializa nem cria banco implicitamente", async () => {
  const item = await fixture();
  try {
    const service = createConfigurationService();
    assert.equal(service.attachRepository(item.repository), true);
    await assert.rejects(fsp.access(item.databaseDir));
    assert.equal(service.get("quiz.ranking.pageSize"), 10);
  } finally {
    await cleanup(item);
  }
});

test("repository carrega global e mantém runtime como maior prioridade", async () => {
  const item = await fixture();
  try {
    await item.repository.writeGlobal({
      values: { "quiz.ranking.pageSize": 11 }
    });
    const service = createConfigurationService();
    service.attachRepository(item.repository);
    await service.initialize();
    assert.deepEqual(
      service.getResolved("quiz.ranking.pageSize"),
      { key: "quiz.ranking.pageSize", value: 11, source: "global" }
    );
    service.set("quiz.ranking.pageSize", 20);
    assert.deepEqual(
      service.getResolved("quiz.ranking.pageSize"),
      { key: "quiz.ranking.pageSize", value: 20, source: "runtime" }
    );
  } finally {
    await cleanup(item);
  }
});

test("hierarquia resolve grupo, comunidade-plataforma, plataforma, comunidade, global e default", async () => {
  const item = await fixture();
  try {
    await item.repository.writeGlobal({
      values: { "quiz.ranking.pageSize": 11 }
    });
    await item.repository.writeCommunities({
      communities: {
        c1: { values: { "quiz.ranking.pageSize": 12 } }
      }
    });
    await item.repository.writePlatforms({
      platforms: {
        whatsapp: { values: { "quiz.ranking.pageSize": 13 } },
        "c1:whatsapp": { values: { "quiz.ranking.pageSize": 14 } }
      }
    });
    await item.repository.writeGroups({
      groups: {
        "whatsapp:g1": { values: { "quiz.ranking.pageSize": 15 } }
      }
    });
    const service = createConfigurationService();
    service.attachRepository(item.repository);
    await service.initialize();

    assert.equal(service.getResolved("quiz.ranking.pageSize", {
      communityId: "c1", platform: "whatsapp", groupId: "g1"
    }).value, 15);
    assert.equal(service.getResolved("quiz.ranking.pageSize", {
      communityId: "c1", platform: "whatsapp"
    }).value, 14);
    assert.equal(service.getResolved("quiz.ranking.pageSize", {
      platform: "whatsapp"
    }).value, 13);
    assert.equal(service.getResolved("quiz.ranking.pageSize", {
      communityId: "c1"
    }).value, 12);
    assert.equal(service.getResolved("quiz.ranking.pageSize").value, 11);

    const detached = createConfigurationService();
    assert.equal(detached.getResolved("quiz.ranking.pageSize").value, 10);
  } finally {
    await cleanup(item);
  }
});

test("escopos não permitidos são recusados durante reload", async () => {
  const item = await fixture();
  try {
    await item.repository.writeGlobal({
      values: { "events.timezone": "UTC" }
    });
    const service = createConfigurationService();
    service.attachRepository(item.repository);
    await assert.rejects(
      service.initialize(),
      (error) => error.code === "CONFIGURATION_SCOPE_INVALID"
    );
  } finally {
    await cleanup(item);
  }
});

test("detachRepository remove persistência sem apagar runtime", async () => {
  const item = await fixture();
  try {
    await item.repository.writeGlobal({
      values: { "quiz.ranking.pageSize": 11 }
    });
    const service = createConfigurationService();
    service.attachRepository(item.repository);
    await service.initialize();
    service.set("quiz.cooldownSeconds", 5);
    assert.equal(service.detachRepository(), true);
    assert.equal(service.get("quiz.ranking.pageSize"), 10);
    assert.equal(service.get("quiz.cooldownSeconds"), 5);
    assert.equal(service.detachRepository(), false);
  } finally {
    await cleanup(item);
  }
});

test("reload observa alterações persistidas posteriores", async () => {
  const item = await fixture();
  try {
    await item.repository.writeGlobal({
      values: { "quiz.ranking.pageSize": 11 }
    });
    const service = createConfigurationService();
    service.attachRepository(item.repository);
    await service.initialize();
    await item.repository.writeGlobal({
      values: { "quiz.ranking.pageSize": 17 }
    });
    assert.equal(service.get("quiz.ranking.pageSize"), 11);
    await service.reload();
    assert.equal(service.get("quiz.ranking.pageSize"), 17);
  } finally {
    await cleanup(item);
  }
});

test("incompatibilidade de schema e catálogo é propagada sem fallback silencioso", async () => {
  for (const configuration of [
    { initial: { schemaVersion: 2 }, incompatible: {} },
    { initial: { catalogRevision: "revision-a" }, incompatible: { catalogRevision: "revision-b" } }
  ]) {
    const item = await fixture(configuration.initial);
    try {
      await item.repository.initialize();
      const incompatible = createConfigurationRepository({
        databaseDir: item.databaseDir,
        backupRoot: item.backupRoot,
        ...configuration.incompatible
      });
      const service = createConfigurationService();
      service.attachRepository(incompatible);
      await assert.rejects(
        service.initialize(),
        (error) => [
          "SCHEMA_VERSION_INCOMPATIBLE",
          "CATALOG_REVISION_INCOMPATIBLE"
        ].includes(error.code)
      );
    } finally {
      await cleanup(item);
    }
  }
});

test("API antiga permanece idêntica quando nenhuma persistência é anexada", () => {
  const current = createConfigurationService();
  const reference = createConfigurationService();
  for (const key of [
    "system.commandPrefix",
    "moderation.enabled",
    "quiz.cooldownSeconds",
    "quiz.language.accepted",
    "quiz.ranking.pageSize"
  ]) {
    assert.deepEqual(current.get(key), reference.get(key));
    assert.deepEqual(current.getDefault(key), reference.getDefault(key));
  }
  current.set("quiz.cooldownSeconds", 30);
  assert.equal(current.get("quiz.cooldownSeconds"), 30);
  assert.equal(reference.get("quiz.cooldownSeconds"), 0);
});
