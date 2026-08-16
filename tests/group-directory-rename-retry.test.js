"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createGroupDirectoryService } = require("../src/services/groupDirectoryService");

const initialDatabase = () => ({
  schemaVersion: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  groups: []
});

async function fixture(renameFile) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-group-rename-"));
  const filePath = path.join(root, "directory.json");
  await fsp.writeFile(filePath, `${JSON.stringify(initialDatabase(), null, 2)}\n`, "utf8");
  const waits = [];
  const service = createGroupDirectoryService({
    filePath,
    renameFile,
    wait: async (milliseconds) => waits.push(milliseconds)
  });
  return { root, filePath, service, waits };
}

const cleanup = (root) => fsp.rm(root, { recursive: true, force: true });
const transient = (code) => Object.assign(new Error(code), { code });

test("rename funciona na primeira tentativa com temporário já fechado", async () => {
  let calls = 0;
  let temporaryWasClosed = false;
  const f = await fixture(async (temporary, target) => {
    calls += 1;
    const handle = await fsp.open(temporary, "r+");
    await handle.close();
    temporaryWasClosed = true;
    await fsp.rename(temporary, target);
  });
  try {
    await f.service.upsertGroup({ groupId: "first@g.us", name: "Primeiro" });
    assert.equal(calls, 1);
    assert.equal(temporaryWasClosed, true);
    assert.deepEqual(f.waits, []);
  } finally { await cleanup(f.root); }
});

for (const code of ["EPERM", "EBUSY"]) {
  test(`${code} transitório reutiliza o temporário e depois conclui`, async () => {
    let calls = 0;
    const temporaries = [];
    const f = await fixture(async (temporary, target) => {
      calls += 1;
      temporaries.push(temporary);
      if (calls < 3) throw transient(code);
      await fsp.rename(temporary, target);
    });
    try {
      await f.service.upsertGroup({ groupId: `${code.toLowerCase()}@g.us`, name: code });
      assert.equal(calls, 3);
      assert.equal(new Set(temporaries).size, 1);
      assert.deepEqual(f.waits, [50, 100]);
    } finally { await cleanup(f.root); }
  });
}

test("cinco falhas preservam erro original, destino e limpam temporário", async () => {
  const original = transient("EPERM");
  let calls = 0;
  const f = await fixture(async () => {
    calls += 1;
    throw calls === 1 ? original : transient("EPERM");
  });
  const before = await fsp.readFile(f.filePath, "utf8");
  try {
    await assert.rejects(
      f.service.upsertGroup({ groupId: "failure@g.us", name: "Falha" }),
      (error) => error === original
    );
    assert.equal(calls, 5);
    assert.deepEqual(f.waits, [50, 100, 200, 400]);
    assert.equal(await fsp.readFile(f.filePath, "utf8"), before);
    assert.deepEqual((await fsp.readdir(f.root)).filter(name => name.endsWith(".tmp")), []);
  } finally { await cleanup(f.root); }
});

test("erro diferente falha imediatamente sem retry", async () => {
  let calls = 0;
  const original = transient("EACCES");
  const f = await fixture(async () => { calls += 1; throw original; });
  try {
    await assert.rejects(
      f.service.upsertGroup({ groupId: "denied@g.us", name: "Negado" }),
      (error) => error === original
    );
    assert.equal(calls, 1);
    assert.deepEqual(f.waits, []);
  } finally { await cleanup(f.root); }
});

test("fila continua serializando escritas durante retry", async () => {
  let calls = 0;
  let releaseWait;
  const blockedWait = new Promise(resolve => { releaseWait = resolve; });
  let signalRenameStarted;
  const renameStarted = new Promise(resolve => { signalRenameStarted = resolve; });
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-group-queue-"));
  const filePath = path.join(root, "directory.json");
  await fsp.writeFile(filePath, `${JSON.stringify(initialDatabase(), null, 2)}\n`, "utf8");
  const service = createGroupDirectoryService({
    filePath,
    renameFile: async (temporary, target) => {
      calls += 1;
      signalRenameStarted();
      if (calls === 1) throw transient("EPERM");
      await fsp.rename(temporary, target);
    },
    wait: async () => blockedWait
  });
  let first;
  let second;
  try {
    first = service.upsertGroup({ groupId: "one@g.us", name: "Um" });
    second = service.upsertGroup({ groupId: "two@g.us", name: "Dois" });
    await renameStarted;
    assert.equal(calls, 1);
    releaseWait();
    await Promise.all([first, second]);
    assert.equal((await service.listActiveGroups()).length, 2);
  } finally {
    releaseWait();
    await Promise.allSettled([first, second].filter(Boolean));
    await cleanup(root);
  }
});
