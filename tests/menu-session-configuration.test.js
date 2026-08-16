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
  createMenuSessionService
} = require("../src/services/menuSessionService");

async function fixture(configurationService, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-menu-config-"));
  let now = new Date("2026-07-30T12:00:00.000Z");
  const service = createMenuSessionService({
    filePath: path.join(root, "sessions.json"),
    configurationService,
    clock: () => new Date(now),
    ...options
  });
  return {
    root,
    service,
    setNow(value) { now = new Date(value); }
  };
}

async function cleanup(item) {
  await fsp.rm(item.root, { recursive: true, force: true });
}

const CONTEXT = {
  platform: "whatsapp",
  groupId: "group@g.us",
  conversationId: "group@g.us",
  userId: "user"
};

const MENU = {
  menuId: "main",
  origin: "group",
  options: { 1: { command: "quiz" } }
};

test("preserva duração padrão e comportamento anterior", async () => {
  const item = await fixture(createConfigurationService());
  try {
    const session = await item.service.openMenu(CONTEXT, MENU);
    assert.equal(
      Date.parse(session.expiresAt) - Date.parse(session.openedAt),
      120_000
    );
  } finally {
    await cleanup(item);
  }
});

test("override runtime altera somente a duração configurável", async () => {
  const configuration = createConfigurationService();
  configuration.set("menus.sessionDurationMilliseconds", 60_000, {
    platform: "whatsapp",
    groupId: "group@g.us"
  });
  const item = await fixture(configuration);
  try {
    const session = await item.service.openMenu(CONTEXT, MENU);
    assert.equal(Date.parse(session.expiresAt) - Date.parse(session.openedAt), 60_000);
    assert.deepEqual(session.options, MENU.options);
  } finally {
    await cleanup(item);
  }
});

test("override persistente global é resolvido com contexto da sessão", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-menu-persistent-"));
  const repository = createConfigurationRepository({
    databaseDir: path.join(root, "configuration"),
    backupRoot: path.join(root, "backups")
  });
  const configuration = createConfigurationService();
  configuration.attachRepository(repository);
  await configuration.initialize();
  await configuration.setPersistent("menus.sessionDurationMilliseconds", 90_000);
  const item = await fixture(configuration);
  try {
    const session = await item.service.openMenu(CONTEXT, MENU);
    assert.equal(Date.parse(session.expiresAt) - Date.parse(session.openedAt), 90_000);
  } finally {
    await cleanup(item);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runtime contextual tem prioridade sobre persistência e fallback", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-menu-priority-"));
  const repository = createConfigurationRepository({
    databaseDir: path.join(root, "configuration"),
    backupRoot: path.join(root, "backups")
  });
  const configuration = createConfigurationService();
  configuration.attachRepository(repository);
  await configuration.initialize();
  await configuration.setPersistent("menus.sessionDurationMilliseconds", 90_000);
  configuration.set("menus.sessionDurationMilliseconds", 45_000, {
    platform: "whatsapp",
    groupId: "group@g.us"
  });
  const item = await fixture(configuration);
  try {
    const session = await item.service.openMenu(CONTEXT, MENU);
    assert.equal(Date.parse(session.expiresAt) - Date.parse(session.openedAt), 45_000);
    const other = await item.service.openMenu({
      ...CONTEXT, groupId: "other@g.us", conversationId: "other@g.us", userId: "other"
    }, MENU);
    assert.equal(Date.parse(other.expiresAt) - Date.parse(other.openedAt), 90_000);
  } finally {
    await cleanup(item);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("override explícito da fábrica e da chamada preserva prioridade legada", async () => {
  const configuration = createConfigurationService();
  configuration.set("menus.sessionDurationMilliseconds", 10_000);
  const item = await fixture(configuration, { durationMs: 30_000 });
  try {
    const factory = await item.service.openMenu(CONTEXT, MENU);
    assert.equal(Date.parse(factory.expiresAt) - Date.parse(factory.openedAt), 30_000);
    const call = await item.service.openMenu(
      { ...CONTEXT, userId: "other" },
      { ...MENU, duration: 5_000 }
    );
    assert.equal(Date.parse(call.expiresAt) - Date.parse(call.openedAt), 5_000);
  } finally {
    await cleanup(item);
  }
});

test("expiração, toque e limpeza usam a duração resolvida sem alterar estados", async () => {
  const configuration = createConfigurationService();
  configuration.set("menus.sessionDurationMilliseconds", 10_000);
  const item = await fixture(configuration);
  try {
    await item.service.openMenu(CONTEXT, MENU);
    item.setNow("2026-07-30T12:00:05.000Z");
    const touched = await item.service.touchMenu(CONTEXT);
    assert.equal(touched.expiresAt, "2026-07-30T12:00:15.000Z");
    item.setNow("2026-07-30T12:00:16.000Z");
    assert.equal((await item.service.getMenuState(CONTEXT)).status, "expired");
    assert.equal(await item.service.clearExpiredMenus(), 1);
    assert.equal((await item.service.getMenuState(CONTEXT)).status, "inactive");
  } finally {
    await cleanup(item);
  }
});

test("múltiplas sessões permanecem isoladas", async () => {
  const item = await fixture(createConfigurationService());
  try {
    await item.service.openMenu(CONTEXT, MENU);
    await item.service.openMenu({ ...CONTEXT, userId: "other" }, MENU);
    await item.service.closeMenu(CONTEXT);
    assert.equal(await item.service.getActiveMenu(CONTEXT), null);
    assert.ok(await item.service.getActiveMenu({ ...CONTEXT, userId: "other" }));
  } finally {
    await cleanup(item);
  }
});

test("ausência de configuração usa fallback e todas as leituras usam getResolved", async () => {
  const calls = [];
  const configuration = {
    getResolved(key, context) {
      calls.push({ key, context });
      return { key, value: 120_000, source: "default" };
    }
  };
  const item = await fixture(configuration);
  try {
    await item.service.openMenu(CONTEXT, MENU);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, "menus.sessionDurationMilliseconds");
    assert.equal(calls[0].context.groupId, "group@g.us");
  } finally {
    await cleanup(item);
  }
});
