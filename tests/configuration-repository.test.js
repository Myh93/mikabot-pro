"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createConfigurationRepository,
  DATA_FILES,
  deriveCatalogRevision
} = require("../src/repositories/configurationRepository");

async function fixture(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-config-repository-"));
  const databaseDir = path.join(root, "database");
  const backupRoot = path.join(root, "backups");
  const repository = createConfigurationRepository({
    databaseDir,
    backupRoot,
    ...options
  });
  return { root, databaseDir, backupRoot, repository };
}

async function cleanup(item) {
  await fsp.rm(item.root, { recursive: true, force: true });
}

test("criação inicial gera manifesto e cinco arquivos íntegros", async () => {
  const item = await fixture();
  try {
    const manifest = await item.repository.initialize();
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.catalogRevision, deriveCatalogRevision());
    assert.deepEqual(manifest.files, DATA_FILES);
    assert.equal(manifest.status, "valid");
    for (const file of ["manifest.json", ...DATA_FILES]) {
      assert.equal(fs.existsSync(path.join(item.databaseDir, file)), true, file);
    }
    assert.deepEqual(await item.repository.readGlobal(), { values: {} });
    assert.deepEqual(await item.repository.readCommunities(), { communities: {} });
    assert.deepEqual(await item.repository.readPlatforms(), { platforms: {} });
    assert.deepEqual(await item.repository.readGroups(), { groups: {} });
  } finally {
    await cleanup(item);
  }
});

test("leitura e escrita preservam todos os documentos", async () => {
  const item = await fixture();
  try {
    await item.repository.writeGlobal({ values: { "events.timezone": "UTC" } });
    await item.repository.writeCommunities({ communities: { c1: { values: {} } } });
    await item.repository.writePlatforms({ platforms: { whatsapp: { values: {} } } });
    await item.repository.writeGroups({ groups: { g1: { values: {} } } });
    assert.equal((await item.repository.readGlobal()).values["events.timezone"], "UTC");
    assert.ok((await item.repository.readCommunities()).communities.c1);
    assert.ok((await item.repository.readPlatforms()).platforms.whatsapp);
    assert.ok((await item.repository.readGroups()).groups.g1);
  } finally {
    await cleanup(item);
  }
});

test("histórico é anexado sem substituir entradas anteriores", async () => {
  const item = await fixture();
  try {
    await item.repository.appendHistory({ action: "first" });
    await item.repository.appendHistory({ action: "second" });
    const history = JSON.parse(
      await fsp.readFile(path.join(item.databaseDir, "history.json"), "utf8")
    );
    assert.deepEqual(history.data.entries.map((entry) => entry.action), ["first", "second"]);
    assert.ok(history.data.entries.every((entry) => entry.recordedAt));
  } finally {
    await cleanup(item);
  }
});

test("escrita atômica mantém original e remove temporário em falha", async () => {
  let fail = false;
  const item = await fixture({
    beforeRename: async ({ target }) => {
      if (fail && target.endsWith("global.json")) throw new Error("simulated");
    }
  });
  try {
    await item.repository.initialize();
    const original = await fsp.readFile(path.join(item.databaseDir, "global.json"), "utf8");
    fail = true;
    await assert.rejects(
      item.repository.writeGlobal({ values: { broken: true } }),
      /simulated/
    );
    assert.equal(
      await fsp.readFile(path.join(item.databaseDir, "global.json"), "utf8"),
      original
    );
    assert.deepEqual(
      (await fsp.readdir(item.databaseDir)).filter((file) => file.endsWith(".tmp")),
      []
    );
  } finally {
    await cleanup(item);
  }
});

test("checksum detecta alteração e corrupção de JSON", async () => {
  const item = await fixture();
  try {
    await item.repository.initialize();
    const globalPath = path.join(item.databaseDir, "global.json");
    await fsp.writeFile(globalPath, "{}\n", "utf8");
    await assert.rejects(
      item.repository.readGlobal(),
      (error) => error.code === "CHECKSUM_MISMATCH"
    );
  } finally {
    await cleanup(item);
  }

  const corrupt = await fixture();
  try {
    await corrupt.repository.initialize();
    const manifestPath = path.join(corrupt.databaseDir, "manifest.json");
    await fsp.writeFile(manifestPath, "{", "utf8");
    await assert.rejects(
      corrupt.repository.loadManifest(),
      (error) => error.code === "MANIFEST_CORRUPT"
    );
  } finally {
    await cleanup(corrupt);
  }
});

test("schemaVersion e catalogRevision incompatíveis são recusados", async () => {
  for (const mutation of [
    (manifest) => { manifest.schemaVersion = 999; },
    (manifest) => { manifest.catalogRevision = "outro-catalogo"; }
  ]) {
    const item = await fixture();
    try {
      await item.repository.initialize();
      const manifestPath = path.join(item.databaseDir, "manifest.json");
      const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
      mutation(manifest);
      await fsp.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
      const fresh = createConfigurationRepository({
        databaseDir: item.databaseDir,
        backupRoot: item.backupRoot
      });
      await assert.rejects(
        fresh.initialize(),
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

test("backup validado restaura os documentos", async () => {
  const item = await fixture();
  try {
    await item.repository.writeGlobal({ values: { sample: "before" } });
    const backup = await item.repository.createBackup();
    assert.equal(fs.existsSync(path.join(backup, "backup.json")), true);
    await item.repository.writeGlobal({ values: { sample: "after" } });
    await item.repository.restoreBackup(backup);
    assert.equal((await item.repository.readGlobal()).values.sample, "before");
  } finally {
    await cleanup(item);
  }
});

test("backup corrompido é recusado sem alterar a base atual", async () => {
  const item = await fixture();
  try {
    await item.repository.writeGlobal({ values: { sample: "safe" } });
    const backup = await item.repository.createBackup();
    await fsp.writeFile(path.join(backup, "global.json"), "{}\n", "utf8");
    await assert.rejects(
      item.repository.restoreBackup(backup),
      (error) => error.code === "BACKUP_CORRUPT"
    );
    assert.equal((await item.repository.readGlobal()).values.sample, "safe");
  } finally {
    await cleanup(item);
  }
});

test("gravações concorrentes são serializadas e não deixam temporários", async () => {
  const item = await fixture();
  try {
    await item.repository.initialize();
    const order = [];
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      item.repository.writeGlobal({ values: { index } }).then(() => order.push(index))
    ));
    assert.equal(order.length, 20);
    assert.deepEqual([...order].sort((left, right) => left - right), Array.from({ length: 20 }, (_, index) => index));
    assert.equal((await item.repository.readGlobal()).values.index, order.at(-1));
    assert.deepEqual(
      (await fsp.readdir(item.databaseDir)).filter((file) => file.endsWith(".tmp")),
      []
    );
  } finally {
    await cleanup(item);
  }
});
