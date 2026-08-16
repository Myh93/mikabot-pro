"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createMemberDataLifecycleService } = require("../src/services/memberDataLifecycleService");
const { createMemberDataAdministrationFlowService } = require("../src/services/memberDataAdministrationFlowService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createEventSchedulerService } = require("../src/services/eventSchedulerService");
const { createMemberDataCommands } = require("../src/commands/memberData");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");

function fixture(overrides = {}) {
  const member = { memberId: "user@lid", platforms: { whatsapp: { active: false, groups: {} }, telegram: { active: false, groups: {} } }, pendingRemovalAt: null };
  const audits = [];
  let registration = { registrationId: "REG000001", primaryIdentity: "user@lid", contacts: { telegram: { enabled: false } } };
  const calls = [];
  const lifecycleRepository = {
    getMember: async () => member,
    updateMember: async (_id, operation) => (operation(member), member),
    addAudit: async entry => (audits.push(entry), entry)
  };
  const registrationRepository = {
    findByIdentity: async id => id === "user@lid" ? registration : null,
    removeRegistrationByIdentity: async () => { const found = Boolean(registration); registration = null; calls.push("registration"); return { removed: found }; }
  };
  const service = createMemberDataLifecycleService({
    lifecycleRepository, registrationRepository,
    quizRepository: { resetUserData: async () => (calls.push("quiz"), { itemsRemoved: 2 }) },
    quizMarathonService: { resetUserData: async () => (calls.push("marathon"), { itemsRemoved: 1 }) },
    playerProgressRepository: { resetPlayerData: async () => (calls.push("progress"), { itemsRemoved: 2 }) },
    raidRepository: { listActiveRaids: () => overrides.raids || [], removeParticipantFromOperationalRaids: () => (calls.push("raids"), { itemsRemoved: 1 }) },
    eventRepository: { listEvents: async () => overrides.events || [], removePendingEventsByUser: async () => (calls.push("events"), { itemsRemoved: 1 }) },
    guidedFlowService: { hasActiveFlowForUser: async () => Boolean(overrides.flow), removeUserFlows: async () => (calls.push("flows"), { itemsRemoved: 1 }) },
    joinRequestRepository: { findPendingByIdentity: async () => overrides.join ? [{ status: "pending_registration" }] : [] },
    feedbackRepository: { anonymizeAuthor: async () => (calls.push("feedback"), { itemsRemoved: 1 }) },
    identityService: { normalizeUserId: value => String(value || ""), collectCanonicalIdentityCandidates: value => [value], identitiesMatch: (a, b) => a === b },
    clock: () => new Date("2026-08-05T12:00:00.000Z")
  });
  return { service, member, audits, calls, setRegistration: value => { registration = value; } };
}

test("detecta outro grupo, Telegram, Join Request, fluxo, Raid e Evento críticos", async () => {
  const scenarios = [
    ["other_group_active", {}, f => { f.member.platforms.whatsapp.groups.other = true; }],
    ["telegram_active", {}, f => { f.member.platforms.telegram.active = true; }],
    ["join_request_pending", { join: true }],
    ["guided_flow_active", { flow: true }],
    ["raid_active", { raids: [{ status: "active", participants: ["user@lid"] }] }],
    ["event_active", { events: [{ status: "running", creatorId: "user@lid" }] }]
  ];
  for (const [expected, options, configure] of scenarios) {
    const f = fixture(options); configure?.(f);
    assert.ok((await f.service.inspectBlockers("user@lid")).blockers.includes(expected));
  }
});

test("remoção completa elimina domínios operacionais, anonimiza feedback e é idempotente", async () => {
  const f = fixture();
  const first = await f.service.removeMember("user@lid", { executor: "admin", reason: "solicitação" });
  assert.equal(first.status, "removed");
  assert.deepEqual(f.calls, ["registration", "quiz", "marathon", "progress", "flows", "raids", "events", "feedback"]);
  assert.ok(f.member.removalCompletedAt);
  assert.deepEqual(f.audits[0].itemsPreserved, ["discipline", "bans", "administrative_audit", "feedback_protocols_anonymized"]);
  assert.equal((await f.service.removeMember("user@lid")).status, "already_removed");
  assert.equal(f.calls.length, 8);
});

test("apagarcadastro preserva Quiz e resetquiz preserva cadastro", async () => {
  const registration = fixture();
  assert.equal((await registration.service.removeRegistration("user@lid", { executor: "admin" })).status, "removed");
  assert.deepEqual(registration.calls, ["registration", "flows"]);
  const quiz = fixture();
  assert.equal((await quiz.service.resetQuiz("user@lid", { executor: "admin" })).status, "removed");
  assert.deepEqual(quiz.calls, ["quiz", "marathon", "progress"]);
  assert.equal(quiz.audits[0].itemsPreserved.includes("registration"), true);
});

test("status e preservação manual cancelam pendingRemovalAt e registram auditoria", async () => {
  const f = fixture();
  f.member.pendingRemovalAt = "2026-08-10T12:00:00.000Z";
  f.member.lastLeaveAt = "2026-08-03T12:00:00.000Z";
  const status = await f.service.getStatus("user@lid");
  assert.equal(status.active, false);
  assert.equal(status.daysRemaining, 5);
  assert.equal((await f.service.preserveMember("user@lid", { executor: "admin", reason: "legal" })).status, "preserved");
  assert.equal(f.member.pendingRemovalAt, null);
  assert.equal(f.audits.at(-1).type, "preserve_member");
});

test("fluxo exige motivo e confirmação dupla para apagar membro", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "member-data-flow-"));
  const guided = createGuidedFlowService({ filePath: path.join(root, "flows.json") });
  const executions = [];
  const lifecycle = { inspectBlockers: async () => ({ memberId: "target@lid", member: {}, registration: null, blockers: [] }), removeMember: async (_id, data) => (executions.push(data), { status: "removed", itemsRemoved: 3 }) };
  const flow = createMemberDataAdministrationFlowService({ guidedFlowService: guided, memberDataLifecycleService: lifecycle });
  const replies = [], context = { platform: "whatsapp", conversationId: "group@g.us", groupId: "group@g.us", userId: "admin@lid", replyText: async text => replies.push(text) };
  try {
    await flow.start(context, "remove_member", "target@lid");
    assert.equal((await flow.handleAnswer(context, "motivo obrigatório")).status, "confirm");
    assert.equal((await flow.handleAnswer(context, "1")).status, "final_confirm");
    assert.equal(executions.length, 0);
    assert.equal((await flow.handleAnswer(context, "1")).status, "completed");
    assert.equal(executions.length, 1);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test("cancelamento não remove e comandos exigem admin pelo contrato do Loader", async () => {
  const commands = createMemberDataCommands({});
  assert.equal(commands.length, 5);
  assert.equal(commands.every(command => command.adminOnly), true);
  assert.deepEqual(commands.map(command => command.name), ["apagarmembro", "apagarcadastro", "resetquiz", "statusmembro", "preservarmembro"]);
});

test("scheduler existente avalia remoções sem criar outro timer", async () => {
  let evaluated = 0;
  const scheduler = createEventSchedulerService({
    repository: { listEvents: async () => [] }, eventService: {}, messageFormatter: {},
    memberLeaveService: { evaluateDueRemovals: async () => { evaluated += 1; return []; } },
    clock: () => new Date("2026-08-05T12:00:00.000Z")
  });
  await scheduler.checkNow();
  assert.equal(evaluated, 1);
});
