"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const test = require("node:test");
const identityService = require("../src/services/identityService");
const { createMemberLifecycleRepository } = require("../src/repositories/memberLifecycleRepository");
const { createMemberLeaveService, CONTINUE_TELEGRAM_MESSAGE } = require("../src/services/memberLeaveService");

async function fixture(options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-member-leave-"));
  let now = new Date("2026-07-30T12:00:00.000Z");
  const repository = createMemberLifecycleRepository({
    filePath: path.join(root, "state.json"),
    clock: () => new Date(now)
  });
  const logs = [];
  const removed = [];
  const telegramMessages = [];
  const registration = options.registration === false ? null : {
    primaryIdentity: "requester@lid",
    contacts: { telegram: { enabled: true, username: "+5511999999999" } }
  };
  const service = createMemberLeaveService({
    identityService,
    repository,
    registrationService: { getRegistrationByIdentity: async () => registration },
    joinRequestRepository: {
      findPendingByIdentity: async () => options.pendingJoin ? [{ status: "pending_registration" }] : []
    },
    removeMemberData: async memberId => {
      removed.push(memberId);
      return options.removalSucceeds !== false;
    },
    memberDataLifecycleService: { inspectBlockers: async () => ({ blockers: options.blockers || [] }) },
    sendTelegramPrivate: async (_registration, text) => {
      telegramMessages.push(text);
      return true;
    },
    clock: () => new Date(now),
    log: value => logs.push(value)
  });
  return {
    root, repository, service, logs, removed, telegramMessages,
    advance: milliseconds => { now = new Date(now.getTime() + milliseconds); }
  };
}

const leave = (type = "leave") => ({
  type,
  chatId: "group@g.us",
  recipientIds: ["requester@lid"],
  timestamp: 1785412800
});

test("saída voluntária desativa somente o grupo WhatsApp e registra telemetria", async () => {
  const f = await fixture();
  await f.service.markPlatformActive("requester@lid", "whatsapp", "group@g.us");
  const [result] = await f.service.handleNotification(leave("leave"));
  assert.equal(result.status, "processed");
  assert.equal(result.member.platforms.whatsapp.active, false);
  assert.equal(result.action, "scheduled");
  assert.equal(result.reason, "grace_period");
  assert.ok(result.pendingRemovalAt);
  for (const expected of ["memberLeft=true", "platform=whatsapp", "policy=delayed", "action=scheduled", "reason=grace_period"]) {
    assert.ok(f.logs.includes(expected), expected);
  }
});

test("remoção por administrador usa o mesmo ciclo sem apagar cadastro", async () => {
  const f = await fixture();
  const [result] = await f.service.handleNotification(leave("remove"));
  assert.equal(result.status, "processed");
  assert.equal(result.member.lastLeaveReason, "admin_removed");
  assert.equal(f.removed.length, 0);
});

test("membro sem cadastro é registrado como inativo sem falhar", async () => {
  const f = await fixture({ registration: false });
  const [result] = await f.service.handleNotification(leave());
  assert.equal(result.status, "unregistered");
  assert.equal(result.member.platforms.whatsapp.active, false);
});

test("outro grupo WhatsApp ativo preserva o membro", async () => {
  const f = await fixture();
  await f.service.markPlatformActive("requester@lid", "whatsapp", "group@g.us");
  await f.service.markPlatformActive("requester@lid", "whatsapp", "other@g.us");
  const [result] = await f.service.handleNotification(leave());
  assert.equal(result.reason, "another_platform_active");
  assert.equal(result.member.platforms.whatsapp.active, true);
});

test("Telegram ativo recebe confirmação privada", async () => {
  const f = await fixture();
  await f.service.markPlatformActive("requester@lid", "telegram", "tropa-telegram");
  const [result] = await f.service.handleNotification(leave());
  assert.equal(result.action, "awaiting_confirmation");
  assert.deepEqual(f.telegramMessages, [CONTINUE_TELEGRAM_MESSAGE]);
});

test("pedido de entrada pendente impede qualquer remoção", async () => {
  const f = await fixture({ pendingJoin: true });
  await f.repository.setPolicy({ mode: "immediate", graceDays: 7 });
  const [result] = await f.service.handleNotification(leave());
  assert.equal(result.reason, "join_request_pending");
  assert.equal(f.removed.length, 0);
});

test("política nunca apagar mantém o cadastro", async () => {
  const f = await fixture();
  const [result] = await f.service.handleNotification(leave());
  assert.equal(result.policy, "delayed");
  assert.equal(result.action, "scheduled");
  assert.equal(f.removed.length, 0);
});

test("política imediata aciona adaptador uma única vez", async () => {
  const f = await fixture();
  await f.repository.setPolicy({ mode: "immediate", graceDays: 7 });
  const [result] = await f.service.handleNotification(leave());
  assert.equal(result.action, "scheduled");
  assert.deepEqual(f.removed, []);
});

test("política temporizada agenda sete dias e só remove após o prazo", async () => {
  const f = await fixture();
  await f.repository.setPolicy({ mode: "delayed", graceDays: 7 });
  const [result] = await f.service.handleNotification(leave());
  assert.equal(result.action, "scheduled");
  assert.equal(f.removed.length, 0);
  f.advance(7 * 86400000 - 1);
  assert.deepEqual(await f.service.evaluateDueRemovals(), []);
  f.advance(1);
  assert.equal((await f.service.evaluateDueRemovals())[0].removed, true);
});

test("loader integra eventos oficiais sem listener de mensagem adicional", async () => {
  const source = await fsp.readFile(path.join(__dirname, "..", "src", "loader.js"), "utf8");
  assert.equal((source.match(/client\.on\s*\(\s*["']message["']/g) || []).length, 1);
  assert.equal((source.match(/client\.on\s*\(\s*["']group_leave["']/g) || []).length, 1);
  assert.equal((source.match(/client\.on\s*\(\s*["']group_join["']/g) || []).length, 1);
});

test("bloqueio crítico adia remoção e execução concluída é idempotente", async () => {
  const blocked = await fixture({ blockers: ["raid_active"] });
  await blocked.repository.updateMember("requester@lid", member => { member.pendingRemovalAt = "2026-07-30T12:00:00.000Z"; });
  blocked.advance(7 * 86400000);
  const deferred = await blocked.service.evaluateDueRemovals();
  assert.equal(deferred[0].reason, "raid_active");
  assert.equal(blocked.removed.length, 0);

  const clear = await fixture();
  await clear.service.handleNotification(leave());
  clear.advance(7 * 86400000);
  assert.equal((await clear.service.evaluateDueRemovals())[0].removed, true);
  assert.deepEqual(await clear.service.evaluateDueRemovals(), []);
  assert.equal(clear.removed.length, 1);
});

test("remoção agendada é retomada por nova instância após reinício", async () => {
  const f = await fixture();
  await f.service.handleNotification(leave());
  const restartedRepository = createMemberLifecycleRepository({
    filePath: path.join(f.root, "state.json"),
    clock: () => new Date("2026-08-07T12:00:00.000Z")
  });
  const removed = [];
  const restarted = createMemberLeaveService({
    identityService,
    repository: restartedRepository,
    registrationService: { getRegistrationByIdentity: async () => null },
    joinRequestRepository: { findPendingByIdentity: async () => [] },
    memberDataLifecycleService: { inspectBlockers: async () => ({ blockers: [] }) },
    removeMemberData: async id => (removed.push(id), true),
    clock: () => new Date("2026-08-07T12:00:00.000Z"),
    log: () => undefined
  });
  assert.equal((await restarted.evaluateDueRemovals())[0].removed, true);
  assert.equal(removed.length, 1);
});
