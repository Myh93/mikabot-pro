"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { cleanupLegacyRaids, ARCHIVE_REASON } = require("../scripts/cleanup-legacy-raids");
const { createRepository } = require("../src/repositories/raidRepository");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-legacy-raids-"));
  const databaseFile = path.join(root, "raids.json");
  const backupRoot = path.join(root, "backups");
  const source = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "database", "raids.json"), "utf8"));
  source.raids = Object.fromEntries(Object.entries(source.raids).filter(([id]) => ["R1024", "R1025"].includes(id)));
  source.messageIndex = {};
  for (const id of ["R1024", "R1025"]) {
    source.raids[id].status = "active";
    source.raids[id].createdAt = null;
    source.raids[id].groupId = null;
    source.raids[id].messageId = null;
    source.raids[id].migrated = true;
    delete source.raids[id].archivedAt;
    delete source.raids[id].archiveReason;
    delete source.raids[id].expiresAt;
  }
  source.raids.R2000 = {
    id: "R2000", name: "rayquaza", groupId: "group@g.us", creatorId: "user-2", messageId: null,
    participants: ["user-2"], status: "active", createdAt: "2026-07-15T20:00:00.000Z", updatedAt: "2026-07-15T20:00:00.000Z"
  };
  source.nextId = Math.max(source.nextId, 2001);
  fs.writeFileSync(databaseFile, `${JSON.stringify(source, null, 2)}\n`, "utf8");
  return { root, databaseFile, backupRoot, before: source };
}

function checksum(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("arquiva R1024 e R1025 preservando participantes e todos os registros", () => {
  const data = fixture();
  const result = cleanupLegacyRaids({ ...data, now: "2026-07-15T21:00:00.000Z" });
  assert.deepStrictEqual(result.archivedIds, ["R1024", "R1025"]);
  const after = JSON.parse(fs.readFileSync(data.databaseFile, "utf8"));
  for (const id of ["R1024", "R1025"]) {
    assert.strictEqual(after.raids[id].status, "archived");
    assert.strictEqual(after.raids[id].archivedAt, "2026-07-15T21:00:00.000Z");
    assert.strictEqual(after.raids[id].archiveReason, ARCHIVE_REASON);
    assert.deepStrictEqual(after.raids[id].participants, data.before.raids[id].participants);
    for (const [field, value] of Object.entries(data.before.raids[id])) {
      if (field !== "status") assert.deepStrictEqual(after.raids[id][field], value);
    }
  }
  assert.deepStrictEqual(Object.keys(after.raids).sort(), Object.keys(data.before.raids).sort());
});

test("arquivadas não aparecem nas ativas e raid nova válida permanece", () => {
  const data = fixture();
  cleanupLegacyRaids(data);
  const repository = createRepository(data.databaseFile);
  assert.deepStrictEqual(repository.listActiveRaids().map((raid) => raid.id), ["R2000"]);
  assert.deepStrictEqual(repository.listArchivedRaids().map((raid) => raid.id).sort(), ["R1024", "R1025"]);
});

test("backup contém banco original, checksum e validação", () => {
  const data = fixture();
  const beforeChecksum = checksum(data.databaseFile);
  const result = cleanupLegacyRaids(data);
  assert.strictEqual(result.backup.validation.valid, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(result.backup.directory, "backup-manifest.json"), "utf8"));
  assert.strictEqual(manifest.validation.status, "valid");
  assert.strictEqual(manifest.checksum.value, beforeChecksum);
  assert.strictEqual(checksum(path.join(result.backup.directory, "raids.json")), beforeChecksum);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(result.backup.directory, "raids.json"), "utf8")), data.before);
});

test("segunda execução é idempotente e não arquiva novamente", () => {
  const data = fixture();
  const first = cleanupLegacyRaids({ ...data, now: "2026-07-15T21:00:00.000Z" });
  const archivedSnapshot = fs.readFileSync(data.databaseFile, "utf8");
  const second = cleanupLegacyRaids({ ...data, now: "2026-07-16T21:00:00.000Z" });
  assert.strictEqual(first.status, "archived");
  assert.strictEqual(second.status, "unchanged");
  assert.deepStrictEqual(second.archivedIds, []);
  assert.strictEqual(fs.readFileSync(data.databaseFile, "utf8"), archivedSnapshot);
  assert.strictEqual(fs.readdirSync(data.backupRoot).length, 1);
});

test("listActiveRaids exclui todos os estados inativos e expirados", () => {
  const data = fixture();
  const database = JSON.parse(fs.readFileSync(data.databaseFile, "utf8"));
  for (const [index, status] of ["archived", "cancelled", "completed", "expired"].entries()) {
    database.raids[`R30${index}`] = { id: `R30${index}`, name: status, groupId: "group@g.us", createdAt: "2026-01-01T00:00:00.000Z", participants: [], status };
  }
  database.raids.R4000 = { id: "R4000", name: "old", groupId: "group@g.us", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z", participants: [], status: "active" };
  fs.writeFileSync(data.databaseFile, JSON.stringify(database), "utf8");
  const active = createRepository(data.databaseFile).listActiveRaids().map((raid) => raid.id);
  assert.deepStrictEqual(active, ["R2000"]);
});

test("comando listar usa mensagem nova e consulta de arquivadas exige admin", async () => {
  const raidRepository = require("../src/repositories/raidRepository");
  const commands = require("../src/commands/raid");
  const list = commands.find((command) => command.name === "listar raids");
  const archived = commands.find((command) => command.name === "listar raids arquivadas");
  assert.strictEqual(archived.adminOnly, true);
  const original = raidRepository.listActiveRaids;
  const replies = [];
  raidRepository.listActiveRaids = () => [];
  try {
    await list.execute({}, { from: "group@g.us", reply: async (text) => replies.push(text) });
  } finally {
    raidRepository.listActiveRaids = original;
  }
  assert.deepStrictEqual(replies, ["📋 Não há raids ativas no momento."]);
});
