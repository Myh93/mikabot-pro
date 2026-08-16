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
  createEventService,
  DEFAULT_TIMEZONE
} = require("../src/services/eventService");

const CONTEXT = {
  communityId: "community-1",
  platform: "whatsapp",
  groupId: "group-1@g.us",
  userId: "creator"
};

function repositoryStub() {
  const created = [];
  return {
    created,
    async createEvent(event) {
      created.push(event);
      return { id: "E0001", ...event };
    }
  };
}

function serviceWith(configurationService) {
  const repository = repositoryStub();
  return {
    repository,
    service: createEventService({
      repository,
      configurationService,
      clock: () => new Date("2026-07-30T12:00:00.000Z")
    })
  };
}

test("preserva o comportamento antigo e o default oficial", async () => {
  const item = serviceWith(createConfigurationService());
  const event = await item.service.createEvent({
    title: "Evento", date: "30/07/2026", time: "20h"
  }, CONTEXT);
  assert.equal(DEFAULT_TIMEZONE, "America/Fortaleza");
  assert.equal(event.timezone, "America/Fortaleza");
  assert.equal(event.startsAt, "2026-07-30T23:00:00.000Z");
  assert.deepEqual(item.service.formatDateTime(event.startsAt, CONTEXT), {
    date: "30/07/2026",
    time: "20:00"
  });
});

test("override runtime contextual tem prioridade sem alterar a API", async () => {
  const configuration = createConfigurationService();
  configuration.set("events.timezone", "UTC", CONTEXT);
  const item = serviceWith(configuration);
  const event = await item.service.createEvent({
    title: "Evento", date: "30/07/2026", time: "20h"
  }, CONTEXT);
  assert.equal(event.timezone, "UTC");
  assert.equal(event.startsAt, "2026-07-30T20:00:00.000Z");
});

test("override persistente de grupo é resolvido pelo contexto", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-event-config-"));
  try {
    const repository = createConfigurationRepository({
      databaseDir: path.join(root, "database"),
      backupRoot: path.join(root, "backups")
    });
    const configuration = createConfigurationService();
    configuration.attachRepository(repository);
    await configuration.initialize();
    await configuration.setPersistent("events.timezone", "UTC", CONTEXT);
    const item = serviceWith(configuration);
    const event = await item.service.createEvent({
      title: "Evento", date: "30/07/2026", time: "20h"
    }, CONTEXT);
    assert.equal(event.timezone, "UTC");
    assert.equal(event.startsAt, "2026-07-30T20:00:00.000Z");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hierarquia prioriza grupo sobre comunidade e preserva fallback", async () => {
  const configuration = createConfigurationService();
  configuration.set("events.timezone", "America/Sao_Paulo");
  configuration.set("events.timezone", "UTC", CONTEXT);
  const item = serviceWith(configuration);
  const event = await item.service.createEvent({
    title: "Evento", date: "30/07/2026", time: "20h"
  }, CONTEXT);
  assert.equal(event.timezone, "UTC");

  const fallback = serviceWith(configuration);
  const communityEvent = await fallback.service.createEvent({
    title: "Evento", date: "30/07/2026", time: "20h"
  }, { ...CONTEXT, groupId: "other@g.us" });
  assert.equal(communityEvent.timezone, "America/Sao_Paulo");
});

test("ausência de override retorna exatamente o fallback do catálogo", () => {
  const configuration = createConfigurationService();
  const item = serviceWith(configuration);
  assert.deepEqual(
    item.service.formatDateTime("2026-07-30T23:00:00.000Z", CONTEXT),
    { date: "30/07/2026", time: "20:00" }
  );
});

test("todas as leituras configuráveis usam getResolved", async () => {
  const calls = [];
  const configuration = {
    getResolved(key, context) {
      calls.push({ key, context });
      return { key, value: "America/Fortaleza", source: "default" };
    }
  };
  const item = serviceWith(configuration);
  await item.service.createEvent({
    title: "Evento", date: "30/07/2026", time: "20h"
  }, CONTEXT);
  assert.ok(calls.length >= 3);
  assert.ok(calls.every((call) => call.key === "events.timezone"));
  assert.ok(calls.some((call) => call.context.groupId === CONTEXT.groupId));
});
