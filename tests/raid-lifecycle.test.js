"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRepository } = require("../src/repositories/raidRepository");
const {
  createRaidLifecycleService,
  ARCHIVE_AFTER_MS
} = require("../src/services/raidLifecycleService");

const BASE = Date.parse("2026-08-05T18:00:00.000Z");
let sequence = 0;

async function fixture(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-raid-life-"));
  const repository = createRepository(path.join(root, "raids.json"));
  let now = options.now ?? BASE;
  const sent = [];
  const client = {
    sendMessage: async (groupId, text) => {
      sent.push({ groupId, text });
      return {};
    }
  };
  const makeService = (extra = {}) => createRaidLifecycleService({
    repository,
    client,
    clock: () => new Date(now),
    schedulerKey: `raid-life-${++sequence}`,
    logInfo: () => undefined,
    logError: (context, error) => { throw Object.assign(error, { context }); },
    ...extra
  });
  const createPublished = (changes = {}) => {
    const raid = repository.createRaid({
      name: changes.name || "mimikyu",
      groupId: "group@g.us",
      creatorId: "creator@lid",
      participants: changes.participants || ["one@lid", "two@lid"],
      status: "active",
      startsAt: changes.startsAt || new Date(BASE + 20 * 60 * 1000).toISOString(),
      expiresAt: changes.expiresAt || new Date(BASE + 40 * 60 * 1000).toISOString()
    });
    repository.publishRaid(raid.id, {
      groupId: "group@g.us",
      messageId: `message-${raid.id}`,
      publishedAt: new Date(BASE).toISOString()
    });
    return repository.getRaidById(raid.id);
  };
  return {
    root, repository, sent, client, makeService, createPublished,
    setNow: value => { now = value; }
  };
}

const cleanup = root => fsp.rm(root, { recursive: true, force: true });

test("envia lembretes de 15, 5 minutos e início exatamente uma vez", async () => {
  const f = await fixture();
  try {
    const raid = f.createPublished();
    const scheduler = f.makeService();
    f.setNow(BASE + 5 * 60 * 1000);
    await scheduler.checkNow();
    assert.match(f.sent.at(-1).text, /15 minutos/);
    f.setNow(BASE + 15 * 60 * 1000);
    await scheduler.checkNow();
    assert.match(f.sent.at(-1).text, /5 minutos/);
    f.setNow(BASE + 20 * 60 * 1000);
    await scheduler.checkNow();
    assert.match(f.sent.at(-1).text, /começou agora/);
    await scheduler.checkNow();
    assert.equal(f.sent.length, 3);
    assert.equal(f.repository.getRaidById(raid.id).lifecycleNotifications.length, 3);
  } finally { await cleanup(f.root); }
});

test("encerramento bloqueia entrada, cancela lembretes e envia mensagem final curta", async () => {
  const f = await fixture();
  try {
    const raid = f.createPublished({ participants: ["a@lid", "b@lid", "c@lid", "d@lid"] });
    f.setNow(BASE + 40 * 60 * 1000);
    await f.makeService().checkNow();
    const completed = f.repository.getRaidById(raid.id);
    assert.equal(completed.status, "completed");
    assert.ok(completed.completedAt);
    assert.equal(f.repository.listActiveRaids().length, 0);
    assert.throws(
      () => f.repository.addParticipant(raid.id, "late@lid", "group@g.us"),
      error => error.code === "RAID_NOT_PUBLISHED"
    );
    assert.equal(f.sent.at(-1).text, `🏁 Raid ${raid.id} encerrada.\n👾 Mimikyu\n👥 4 participantes.`);
    assert.equal(f.sent.length, 1);
    const sentAfterEnd = f.sent.length;
    await f.makeService().checkNow();
    assert.equal(f.sent.length, sentAfterEnd);
  } finally { await cleanup(f.root); }
});

test("Raid encerrada fica no histórico por 24 horas e depois é arquivada", async () => {
  const f = await fixture();
  try {
    const raid = f.createPublished();
    const scheduler = f.makeService();
    f.setNow(BASE + 40 * 60 * 1000);
    await scheduler.checkNow();
    const completed = f.repository.getRaidById(raid.id);
    const completedAt = Date.parse(completed.completedAt);
    f.setNow(completedAt + ARCHIVE_AFTER_MS - 1);
    await scheduler.checkNow();
    assert.equal(f.repository.getRaidById(raid.id).status, "completed");
    assert.equal(f.repository.listArchivedRaids("group@g.us").length, 1);
    f.setNow(completedAt + ARCHIVE_AFTER_MS);
    await scheduler.checkNow();
    const archived = f.repository.getRaidById(raid.id);
    assert.equal(archived.status, "archived");
    assert.equal(f.repository.listActiveRaids().length, 0);
    for (const field of ["id", "name", "creatorId", "startsAt", "participants", "groupId", "completedAt"]) {
      assert.deepEqual(archived[field], completed[field], field);
    }
  } finally { await cleanup(f.root); }
});

test("reinício retoma pelo banco sem duplicar lembretes ou encerramento", async () => {
  const f = await fixture();
  try {
    const raid = f.createPublished();
    f.setNow(BASE + 5 * 60 * 1000);
    await f.makeService().checkNow();
    const sentBeforeRestart = f.sent.length;
    await f.makeService().checkNow();
    assert.equal(f.sent.length, sentBeforeRestart);
    f.setNow(BASE + 40 * 60 * 1000);
    await f.makeService().checkNow();
    assert.equal(f.repository.getRaidById(raid.id).status, "completed");
    const finals = f.sent.filter(item => item.text.includes("encerrada."));
    assert.equal(finals.length, 1);
  } finally { await cleanup(f.root); }
});

test("start evita timer duplicado para a mesma chave", async () => {
  const f = await fixture();
  let timers = 0;
  let cleared = 0;
  const key = `shared-${++sequence}`;
  const options = {
    schedulerKey: key,
    setIntervalFn: () => { timers += 1; return { unref() {} }; },
    clearIntervalFn: () => { cleared += 1; }
  };
  const first = f.makeService(options);
  const second = f.makeService(options);
  try {
    assert.equal((await first.start(f.client)).started, true);
    assert.equal((await second.start(f.client)).alreadyRunning, true);
    assert.equal(timers, 1);
    assert.equal(first.stop(), true);
    assert.equal(cleared, 1);
  } finally {
    first.stop();
    second.stop();
    await cleanup(f.root);
  }
});

test("Raid já encerrada não recebe lembretes e múltiplas Raids são independentes", async () => {
  const f = await fixture();
  try {
    const first = f.createPublished({ name: "pikachu" });
    const second = f.createPublished({ name: "rayquaza" });
    f.repository.updateRaid(first.id, {
      status: "completed",
      completedAt: new Date(BASE).toISOString()
    });
    f.setNow(BASE + 5 * 60 * 1000);
    await f.makeService().checkNow();
    assert.equal(f.sent.length, 2);
    assert.equal(f.sent.filter(item => item.text.includes("encerrada.")).length, 1);
    assert.equal(f.sent.filter(item => /15 minutos/.test(item.text)).length, 1);
    assert.match(f.sent.find(item => /15 minutos/.test(item.text)).text, /Rayquaza/);
    assert.deepEqual(
      f.repository.getRaidById(first.id).lifecycleNotifications,
      ["end:group@g.us"]
    );
    assert.equal(f.repository.getRaidById(second.id).lifecycleNotifications.length, 1);
  } finally { await cleanup(f.root); }
});
