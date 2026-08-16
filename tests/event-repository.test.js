"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventRepository } = require("../src/repositories/eventRepository");

const REQUIRED_FILES = ["manifest.json", "events.json", "history.json", "settings.json", "schedules.json", "templates.json"];

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-events-"));
  const databaseDir = path.join(root, "events");
  const backupRoot = path.join(root, "backups");
  return { root, databaseDir, backupRoot, repository: createEventRepository({ databaseDir, backupRoot }) };
}

async function cleanup(root) {
  await fsp.rm(root, { recursive: true, force: true });
}

function eventInput(overrides = {}) {
  return { title: "Quiz Pokémon", type: "custom", platform: "whatsapp", creatorId: "user@lid", ...overrides };
}

test("inicializa todos os arquivos, manifesto e checksums válidos", async () => {
  const f = await fixture();
  try {
    const database = await f.repository.loadDatabase();
    assert.deepEqual((await fsp.readdir(f.databaseDir)).sort(), REQUIRED_FILES.sort());
    assert.equal(database.manifest.nextEventNumber, 1);
    assert.equal((await f.repository.validateDatabase()).valid, true);
  } finally { await cleanup(f.root); }
});

test("cria IDs sequenciais e persiste o próximo ID em nova instância", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.repository.createEvent(eventInput())).id, "E0001");
    assert.equal((await f.repository.createEvent(eventInput({ title: "Segundo" }))).id, "E0002");
    const reopened = createEventRepository({ databaseDir: f.databaseDir, backupRoot: f.backupRoot });
    assert.equal((await reopened.createEvent(eventInput({ title: "Terceiro" }))).id, "E0003");
    assert.equal((await reopened.getEventById("e0001")).title, "Quiz Pokémon");
  } finally { await cleanup(f.root); }
});

test("atualiza sem permitir alteração de ID ou createdAt", async () => {
  const f = await fixture();
  try {
    const created = await f.repository.createEvent(eventInput());
    const updated = await f.repository.updateEvent(created.id, { title: "Novo título" });
    assert.equal(updated.title, "Novo título");
    assert.equal(updated.createdAt, created.createdAt);
    assert.notEqual(updated.updatedAt, created.updatedAt);
    await assert.rejects(f.repository.updateEvent(created.id, { id: "E9999" }), /imutável/);
    await assert.rejects(f.repository.updateEvent(created.id, { createdAt: new Date(0).toISOString() }), /imutável/);
  } finally { await cleanup(f.root); }
});

test("executa ciclo de agendamento, publicação, início e finalização", async () => {
  const f = await fixture();
  try {
    const event = await f.repository.createEvent(eventInput({ groupId: "group@g.us" }));
    assert.equal((await f.repository.scheduleEvent(event.id, { startsAt: "2030-01-01T12:00:00.000Z" })).status, "scheduled");
    assert.equal((await f.repository.publishEvent(event.id)).status, "published");
    assert.equal((await f.repository.startEvent(event.id)).status, "running");
    const finished = await f.repository.finishEvent(event.id, { result: { winner: "team-a" } });
    assert.equal(finished.status, "finished");
    assert.equal(finished.result.winner, "team-a");
    assert.equal((await f.repository.finishEvent(event.id)).finishedAt, finished.finishedAt);
  } finally { await cleanup(f.root); }
});

test("cancela, arquiva e bloqueia transições inválidas", async () => {
  const f = await fixture();
  try {
    const event = await f.repository.createEvent(eventInput({ groupId: "group@g.us" }));
    assert.equal((await f.repository.cancelEvent(event.id)).status, "cancelled");
    await assert.rejects(f.repository.publishEvent(event.id), /Transição inválida/);
    assert.equal((await f.repository.archiveEvent(event.id)).status, "archived");
    assert.equal((await f.repository.archiveEvent(event.id)).status, "archived");
    await assert.rejects(f.repository.finishEvent(event.id), /Transição inválida/);
  } finally { await cleanup(f.root); }
});

test("exige grupo para agendar ou publicar e valida datas", async () => {
  const f = await fixture();
  try {
    const event = await f.repository.createEvent(eventInput());
    await assert.rejects(f.repository.scheduleEvent(event.id, { startsAt: "2030-01-01T00:00:00.000Z" }), /groupId/);
    await assert.rejects(f.repository.updateEvent(event.id, { startsAt: "inválida" }), /Data ISO/);
    await assert.rejects(f.repository.updateEvent(event.id, { startsAt: "2030-02-01T00:00:00.000Z", endsAt: "2030-01-01T00:00:00.000Z" }), /endsAt/);
  } finally { await cleanup(f.root); }
});

test("filtra grupo, status e plataforma com ordenação definida", async () => {
  const f = await fixture();
  try {
    await f.repository.createEvent(eventInput({ groupId: "a@g.us", title: "Sem data" }));
    const dated = await f.repository.createEvent(eventInput({ groupId: "a@g.us", title: "Com data", platform: "whatsapp" }));
    await f.repository.scheduleEvent(dated.id, { startsAt: "2030-01-01T00:00:00.000Z" });
    await f.repository.createEvent(eventInput({ groupId: "a@g.us", title: "Telegram", platform: "telegram" }));
    await f.repository.createEvent(eventInput({ groupId: "b@g.us", title: "Outro grupo" }));
    const group = await f.repository.listEventsByGroup("whatsapp", "a@g.us");
    assert.deepEqual(group.map((item) => item.title), ["Com data", "Sem data"]);
    assert.equal((await f.repository.listEventsByStatus("scheduled")).length, 1);
    assert.equal((await f.repository.listEvents({ platform: "telegram" })).length, 1);
  } finally { await cleanup(f.root); }
});

test("preserva histórico inclusive na exclusão conservadora", async () => {
  const f = await fixture();
  try {
    const draft = await f.repository.createEvent(eventInput());
    await f.repository.updateEvent(draft.id, { description: "Editado" });
    assert.equal(await f.repository.deleteEvent(draft.id), true);
    assert.deepEqual((await f.repository.listHistory({ eventId: draft.id })).map((entry) => entry.action), ["created", "updated", "deleted"]);
    const published = await f.repository.createEvent(eventInput({ groupId: "g@g.us" }));
    await f.repository.publishEvent(published.id);
    await assert.rejects(f.repository.deleteEvent(published.id), /prefira arquivar/);
  } finally { await cleanup(f.root); }
});

test("persiste settings, schedules e templates sem executar automações", async () => {
  const f = await fixture();
  try {
    await f.repository.updateSettings({ global: { timezone: "America/Fortaleza" } });
    assert.equal((await f.repository.getSettings()).global.timezone, "America/Fortaleza");
    const schedule = await f.repository.saveSchedule({ eventId: "E0001", runAt: "2030-01-01T00:00:00.000Z" });
    assert.equal((await f.repository.updateSchedule(schedule.id, { receipt: null })).status, "scheduled");
    assert.equal((await f.repository.cancelSchedule(schedule.id)).status, "cancelled");
    const template = await f.repository.saveTemplate({ name: "Quiz", body: "Evento" });
    assert.equal((await f.repository.updateTemplate(template.id, { body: "Atualizado" })).body, "Atualizado");
    assert.equal((await f.repository.getTemplates()).length, 1);
    assert.equal(await f.repository.deleteTemplate(template.id), true);
  } finally { await cleanup(f.root); }
});

test("serializa escritores concorrentes sem perder eventos ou deixar temporários", async () => {
  const f = await fixture();
  try {
    const events = await Promise.all(Array.from({ length: 20 }, (_, index) => f.repository.createEvent(eventInput({ title: `Evento ${index}` }))));
    assert.equal(new Set(events.map((item) => item.id)).size, 20);
    assert.equal((await f.repository.listEvents()).length, 20);
    assert.equal((await fsp.readdir(f.databaseDir)).some((name) => name.endsWith(".tmp")), false);
    assert.equal((await f.repository.validateDatabase()).valid, true);
  } finally { await cleanup(f.root); }
});

test("cria backup completo, validado e deduplicado", async () => {
  const f = await fixture();
  try {
    await f.repository.createEvent(eventInput());
    const first = await f.repository.createBackup();
    assert.equal(first.reused, false);
    assert.equal(first.validation.valid, true);
    assert.deepEqual((await fsp.readdir(first.directory)).sort(), [...REQUIRED_FILES, "backup-manifest.json"].sort());
    const second = await f.repository.createBackup();
    assert.equal(second.reused, true);
    assert.equal(second.directory, first.directory);
  } finally { await cleanup(f.root); }
});

test("restaura backup e não perde sequência persistente", async () => {
  const f = await fixture();
  try {
    const first = await f.repository.createEvent(eventInput({ title: "Preservado" }));
    const backup = await f.repository.createBackup();
    await f.repository.createEvent(eventInput({ title: "Removido na restauração" }));
    const restored = await f.repository.restoreBackup(backup.directory, { skipCurrentBackup: true });
    assert.equal(restored.validation.valid, true);
    assert.equal((await f.repository.listEvents()).length, 1);
    assert.equal((await f.repository.getEventById(first.id)).title, "Preservado");
    assert.equal((await f.repository.createEvent(eventInput({ title: "Após reinício" }))).id, "E0002");
  } finally { await cleanup(f.root); }
});

test("recusa manifesto inválido, checksum incorreto e JSON corrompido", async (t) => {
  await t.test("manifesto", async () => {
    const f = await fixture();
    try {
      await f.repository.loadDatabase();
      const manifestPath = path.join(f.databaseDir, "manifest.json");
      const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
      manifest.schemaVersion = 999;
      await fsp.writeFile(manifestPath, JSON.stringify(manifest));
      assert.equal((await f.repository.validateDatabase()).valid, false);
    } finally { await cleanup(f.root); }
  });
  await t.test("checksum", async () => {
    const f = await fixture();
    try {
      await f.repository.loadDatabase();
      await fsp.appendFile(path.join(f.databaseDir, "settings.json"), " ");
      assert.match((await f.repository.validateDatabase()).errors.join(" "), /Checksum inválido/);
    } finally { await cleanup(f.root); }
  });
  await t.test("json", async () => {
    const f = await fixture();
    try {
      await f.repository.loadDatabase();
      await fsp.writeFile(path.join(f.databaseDir, "events.json"), "{");
      assert.match((await f.repository.validateDatabase()).errors.join(" "), /corrompido/);
    } finally { await cleanup(f.root); }
  });
});
