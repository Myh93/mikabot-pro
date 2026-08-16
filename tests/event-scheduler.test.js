"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createEventRepository } = require("../src/repositories/eventRepository");
const { createEventService } = require("../src/services/eventService");
const { createEventSchedulerService, INTERVAL_MS } = require("../src/services/eventSchedulerService");

let sequence = 0;
const BASE = Date.parse("2026-07-16T15:00:00.000Z");

async function fixture(startTime = BASE) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-event-scheduler-"));
  const repository = createEventRepository({ databaseDir: path.join(root, "events"), backupRoot: path.join(root, "backups") });
  let now = startTime;
  const sent = [];
  const errors = [];
  const intervals = [];
  const cleared = [];
  const client = { sendMessage: async (groupId, text) => { sent.push({ groupId, text }); return { id: `m${sent.length}` }; } };
  const eventService = createEventService({ repository, clock: () => new Date(now) });
  const makeScheduler = (overrides = {}) => createEventSchedulerService({
    repository, eventService, client, clock: () => new Date(now), schedulerKey: `test-${++sequence}`,
    setIntervalFn: (callback, delay) => { const timer = { callback, delay, unref() {} }; intervals.push(timer); return timer; },
    clearIntervalFn: (timer) => cleared.push(timer), logInfo: () => undefined,
    logError: (context, error) => errors.push({ context, error }), ...overrides
  });
  async function createEvent(overrides = {}) {
    return repository.createEvent({
      title: "Quiz Pokémon", type: "custom", platform: "whatsapp", groupId: "group-a@g.us", creatorId: "user@lid",
      status: "scheduled", startsAt: new Date(now + 48 * 60 * 60 * 1000).toISOString(), endsAt: null,
      settings: {}, ...overrides
    });
  }
  return { root, repository, eventService, client, sent, errors, intervals, cleared, makeScheduler, createEvent, setNow: (value) => { now = value; }, getNow: () => now };
}

const cleanup = (root) => fsp.rm(root, { recursive: true, force: true });

test("scheduler inicia uma vez e configura exatamente um intervalo de 30 segundos", async () => {
  const f = await fixture();
  try {
    const key = `unique-${++sequence}`;
    const first = f.makeScheduler({ schedulerKey: key });
    const second = f.makeScheduler({ schedulerKey: key });
    assert.equal((await first.start()).started, true);
    assert.equal((await first.start()).alreadyRunning, true);
    assert.equal((await second.start()).alreadyRunning, true);
    assert.equal(f.intervals.length, 1);
    assert.equal(f.intervals[0].delay, 30_000);
    assert.equal(first.getIntervalMs(), INTERVAL_MS);
    assert.equal(first.stop(), true);
    assert.equal(f.cleared.length, 1);
  } finally { await cleanup(f.root); }
});

for (const notice of [
  ["24h", 24 * 60, "📅 *LEMBRETE DE EVENTO*", "Falta 1 dia"],
  ["1h", 60, "⏰ *FALTA 1 HORA!*", "Quiz Pokémon"],
  ["30m", 30, "⏰ *FALTAM 30 MINUTOS!*", "📌 *Quiz Pokémon*"],
  ["10m", 10, "🚨 *ATENÇÃO!*", "📌 *Quiz Pokémon*"]
]) {
  test(`envia aviso ${notice[0]} somente quando devido`, async () => {
    const f = await fixture();
    try {
      const startsAt = BASE + notice[1] * 60 * 1000;
      const event = await f.createEvent({ startsAt: new Date(startsAt).toISOString(), settings: { notifications: [notice[0]] } });
      f.setNow(BASE - 1);
      const scheduler = f.makeScheduler();
      await scheduler.checkNow();
      assert.equal(f.sent.length, 0);
      f.setNow(BASE);
      await scheduler.checkNow();
      assert.equal(f.sent.length, 1);
      assert.match(f.sent[0].text, new RegExp(notice[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(f.sent[0].text.includes(notice[3]), true);
      assert.equal((await f.repository.getEventById(event.id)).notifications[0].key, notice[0]);
    } finally { await cleanup(f.root); }
  });
}

test("inicia automaticamente, registra startedAt, histórico e mensagem", async () => {
  const f = await fixture();
  try {
    const event = await f.createEvent({ startsAt: new Date(BASE).toISOString(), settings: { notifications: ["start"] } });
    const scheduler = f.makeScheduler();
    await scheduler.checkNow();
    const updated = await f.repository.getEventById(event.id);
    assert.equal(updated.status, "running");
    assert.equal(updated.startedAt, new Date(BASE).toISOString());
    assert.match(f.sent[0].text, /🎉 \*O EVENTO COMEÇOU!\*[\s\S]*Quiz Pokémon/);
    assert.equal((await f.repository.listHistory({ eventId: event.id })).some((entry) => entry.action === "started"), true);
  } finally { await cleanup(f.root); }
});

test("finaliza automaticamente com endsAt, histórico e mensagem", async () => {
  const f = await fixture();
  try {
    const event = await f.createEvent({ status: "running", startsAt: new Date(BASE - 3_600_000).toISOString(), endsAt: new Date(BASE).toISOString(), settings: { notifications: ["end"] } });
    const scheduler = f.makeScheduler();
    await scheduler.checkNow();
    const updated = await f.repository.getEventById(event.id);
    assert.equal(updated.status, "finished");
    assert.equal(updated.finishedAt, new Date(BASE).toISOString());
    assert.match(f.sent[0].text, /🏁 \*EVENTO ENCERRADO\*/);
    assert.equal((await f.repository.listHistory({ eventId: event.id })).some((entry) => entry.action === "finished"), true);
  } finally { await cleanup(f.root); }
});

test("recibos persistidos impedem duplicação no ciclo e após reinício", async () => {
  const f = await fixture();
  try {
    await f.createEvent({ startsAt: new Date(BASE + 30 * 60 * 1000).toISOString(), settings: { notifications: ["30m"] } });
    const first = f.makeScheduler();
    await first.checkNow();
    await first.checkNow();
    const restarted = f.makeScheduler();
    await restarted.checkNow();
    assert.equal(f.sent.length, 1);
  } finally { await cleanup(f.root); }
});

test("recupera aviso pendente imediatamente depois do reinício", async () => {
  const f = await fixture();
  try {
    await f.createEvent({ startsAt: new Date(BASE + 5 * 60 * 1000).toISOString(), settings: { notifications: ["10m"] } });
    const restarted = f.makeScheduler();
    const result = await restarted.start();
    assert.equal(result.started, true);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /ATENÇÃO/);
    restarted.stop();
  } finally { await cleanup(f.root); }
});

test("eventos cancelados e arquivados são ignorados", async () => {
  const f = await fixture();
  try {
    await f.createEvent({ status: "cancelled", startsAt: new Date(BASE).toISOString() });
    await f.createEvent({ status: "archived", startsAt: new Date(BASE).toISOString() });
    const result = await f.makeScheduler().checkNow();
    assert.equal(result.processed, 0);
    assert.equal(f.sent.length, 0);
  } finally { await cleanup(f.root); }
});

test("processa múltiplos grupos e eventos simultâneos sem misturar destinos", async () => {
  const f = await fixture();
  try {
    await f.createEvent({ title: "Evento A", groupId: "group-a@g.us", startsAt: new Date(BASE + 10 * 60 * 1000).toISOString(), settings: { notifications: ["10m"] } });
    await f.createEvent({ title: "Evento B", groupId: "group-b@g.us", startsAt: new Date(BASE + 10 * 60 * 1000).toISOString(), settings: { notifications: ["10m"] } });
    await f.createEvent({ title: "Evento C", groupId: "group-c@g.us", startsAt: new Date(BASE + 10 * 60 * 1000).toISOString(), settings: { notifications: ["10m"] } });
    await f.makeScheduler().checkNow();
    assert.deepEqual(new Set(f.sent.map((entry) => entry.groupId)), new Set(["group-a@g.us", "group-b@g.us", "group-c@g.us"]));
    assert.equal(f.sent.length, 3);
  } finally { await cleanup(f.root); }
});

test("classifica níveis e prepara destino privado sem painel da dona", async () => {
  const f = await fixture();
  try {
    const scheduler = f.makeScheduler();
    assert.deepEqual(scheduler.getLevelDestinations(), { critical: "group", important: "group", normal: "group", administrative: "owner", debug: "owner" });
    assert.equal(scheduler.getTimezone(), "America/Fortaleza");
    assert.deepEqual(scheduler.getNotificationDefinitions().map((item) => item.key), ["24h", "1h", "30m", "10m"]);
  } finally { await cleanup(f.root); }
});

test("trava impede ciclos simultâneos", async () => {
  const f = await fixture();
  try {
    let release;
    f.client.sendMessage = () => new Promise((resolve) => { release = resolve; });
    await f.createEvent({ startsAt: new Date(BASE + 10 * 60 * 1000).toISOString(), settings: { notifications: ["10m"] } });
    const scheduler = f.makeScheduler();
    const first = scheduler.checkNow();
    while (!release) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await scheduler.checkNow()).status, "busy");
    release({ id: "message" });
    await first;
  } finally { await cleanup(f.root); }
});

test("não registra listener de mensagem nem timers fora do scheduler", async () => {
  const schedulerSource = await fsp.readFile(path.join(__dirname, "..", "src", "services", "eventSchedulerService.js"), "utf8");
  const indexSource = await fsp.readFile(path.join(__dirname, "..", "index.js"), "utf8");
  assert.equal(/client\.on\s*\(\s*["']message/.test(schedulerSource), false);
  assert.equal((indexSource.match(/eventScheduler\.start\s*\(/g) || []).length, 1);
  assert.equal((schedulerSource.match(/setIntervalFn\s*\(/g) || []).length, 1);
});
