"use strict";

const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const identityService = require("../src/services/identityService");
const { createJoinRequestRepository } = require("../src/repositories/joinRequestRepository");
const {
  createJoinRequestService,
  UNREGISTERED_MESSAGE,
  REGISTERED_MESSAGE,
  APPROVED_MESSAGE,
  APPROVAL_FAILED_MESSAGE
} = require("../src/services/joinRequestService");

// A revalidação usa apenas histórico explícito do grupo; estes cenários ficam
// junto da integração real do Join Request para garantir que a aprovação não antecipe o PV.

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-join-"));
  let now = new Date("2026-07-28T12:00:00.000Z");
  let pending = options.pending || [{
    id: { _serialized: "requester@lid" },
    requestMethod: "InviteLink",
    t: 1
  }];
  const repository = createJoinRequestRepository({
    directory: path.join(root, "queue"),
    clock: () => new Date(now)
  });
  const sent = [];
  const approvals = [];
  const logs = [];
  const debug = [];
  const pollLogs = [];
  const processLogs = [];
  const approvalLogs = [];
  const summaryLogs = [];
  const lifecycleLogs = [];
  const flows = [];
  const registrations = options.registrations || [];
  const groupId = "group@g.us";
  const bot = { id: { _serialized: "bot@lid" }, isAdmin: options.botAdmin !== false };
  const client = {
    info: { wid: "bot@lid" },
    sendMessage: async (target, text) => {
      if (options.privateFails) throw new Error("private unavailable");
      sent.push({ target, text });
      return { id: "sent" };
    },
    getChatById: async () => ({
      isGroup: true,
      participants: [
        bot,
        ...(options.participantJoined ? [{ id: "requester@lid" }] : [])
      ]
    }),
    getGroupMembershipRequests: async targetGroup => {
      assert.equal(targetGroup, groupId);
      return pending;
    },
    approveGroupMembershipRequests: async (targetGroup, approvalOptions) => {
      approvals.push({ targetGroup, approvalOptions });
      if (options.ambiguousApproval) {
        const requesterId = approvalOptions.requesterIds[0];
        pending = pending.filter(item =>
          !identityService.identitiesMatch(item.id, requesterId)
        );
        throw new Error("ambiguous approval response");
      }
      if (options.approvalFails) throw new Error("approval unavailable");
      const requesterId = approvalOptions.requesterIds[0];
      pending = pending.filter(item =>
        !identityService.identitiesMatch(item.id, requesterId)
      );
      return [{ requesterId, message: "approved" }];
    }
  };
  const registrationService = options.registrationService || {
    getRegistrationByIdentity: async identity => registrations.find(item =>
      [item.primaryIdentity, ...(item.identityAliases || [])].some(stored =>
        identity.candidates.some(candidate =>
          identityService.identitiesMatch(stored, candidate)
        )
      )
    ) || null
  };
  const guidedFlow = {
    start: async context => {
      flows.push(context);
      await context.replyText("INÍCIO DO CADASTRO");
      return {
        status: "started",
        session: { expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString() }
      };
    },
    startReturnRevalidation: async (context, data) => { flows.push({ ...context, revalidation: data }); await context.replyText(`REVALIDAÇÃO ${data.days}`); return { status: "started" }; }
  };
  const groupDirectory = {
    listActiveGroups: async () => [{ groupId, active: true }]
  };
  const service = createJoinRequestService({
    identityService,
    registrationService,
    registrationGuidedFlowService: guidedFlow,
    memberExperienceRepository: options.memberExperienceRepository || { getMember: async () => null, getGroupConfig: async () => ({ returnRevalidationDays: 7 }) },
    disciplineService: options.disciplineService || {
      isBlocked: async () => ({ blocked: false }),
      notifyBlockedJoin: async () => false
    },
    repository,
    groupDirectoryService: groupDirectory,
    clock: () => new Date(now),
    intervalMs: 60 * 60 * 1000,
    log: value => logs.push(value),
    debugLog: value => debug.push(value),
    pollLog: value => pollLogs.push(value),
    processLog: value => processLogs.push(value),
    approvalLog: value => approvalLogs.push(value),
    summaryLog: value => summaryLogs.push(value),
    lifecycleLog: value => lifecycleLogs.push(value)
  });
  return {
    root,
    repository,
    service,
    client,
    sent,
    approvals,
    logs,
    debug,
    pollLogs,
    processLogs,
    approvalLogs,
    summaryLogs,
    lifecycleLogs,
    flows,
    groupId,
    notification: (overrides = {}) => ({
      chatId: groupId,
      author: "requester@lid",
      id: { _serialized: "notification" },
      ...overrides
    }),
    setPending: value => { pending = value; },
    advance: milliseconds => { now = new Date(now.getTime() + milliseconds); }
  };
}

test("pedido de membro banido exige análise e nunca chama aprovação", async () => {
  const notices = [];
  const f = fixture({
    registrations: [{ primaryIdentity: "requester@lid", identityAliases: ["requester@lid"] }],
    disciplineService: {
      isBlocked: async () => ({ blocked: true, reason: "community_ban" }),
      notifyBlockedJoin: async value => { notices.push(value); return true; }
    }
  });
  const result = await f.service.handleEvent(f.client, f.notification());
  assert.equal(result.status, "approval_failed");
  assert.equal(result.reason, "disciplinary_review_required");
  assert.equal(f.approvals.length, 0);
  assert.equal(notices.length, 1);
  assert.equal(f.sent.some(item => /necessita análise administrativa/.test(item.text)), true);
  assert.equal(f.sent.some(item => item.text === APPROVED_MESSAGE), false);
});

test("evento oficial detecta pessoa não cadastrada, envia PV e inicia fluxo", async () => {
  const f = fixture();
  f.setPending([]);
  const runtime = f.service.start(f.client);
  await runtime.initialPoll;
  const result = await f.service.handleEvent(f.client, f.notification());
  assert.equal(result.status, "pending_registration");
  assert.equal(f.sent[0].text, UNREGISTERED_MESSAGE);
  assert.equal(f.sent[1].text, "INÍCIO DO CADASTRO");
  assert.equal(f.flows.length, 1);
  assert.equal(f.approvals.length, 0);
  assert.ok(f.debug.includes("eventReceived=true"));
  assert.ok(f.debug.includes("clientReady=true"));
  for (const expected of [
    "requestReceived=true",
    "dedupPassed=true",
    "identityResolved=true",
    "registrationLookupStarted=true",
    "registrationLookupFinished=true",
    "lookupMethod=repository",
    "lookupReturned=false",
    "privateChatResolutionStarted=true",
    "privateChatResolutionFinished=true",
    "privateChatAvailable=true",
    "clientAvailable=true",
    "privateMessageAttempted=true",
    "privateMessageSucceeded=true",
    "flowStoppedAt=completed",
    "discardReason=none"
  ]) assert.ok(f.processLogs.includes(expected), expected);
  f.service.stop(f.client);
});

test("falha na consulta de cadastro identifica etapa e preserva erro sanitizado", async () => {
  const failure = new TypeError("t");
  failure.code = "t";
  const f = fixture({
    registrations: [],
    registrationService: {
      getRegistrationByIdentity: async () => { throw failure; }
    }
  });
  const result = await f.service.processRequest(f.client, {
    source: "poll",
    groupId: f.groupId,
    requester: "requester@lid"
  });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "registration_lookup_t");
  for (const expected of [
    "registrationLookupStarted=true",
    "registrationLookupFinished=false",
    "privateMessageAttempted=false",
    "privateMessageSucceeded=false",
    "flowStoppedAt=registrationLookup",
    "errorStage=registrationLookup",
    "errorCode=registration_lookup_t"
  ]) assert.ok(f.processLogs.includes(expected), expected);
  assert.equal(f.sent.length, 0);
});

test("polling oficial detecta pedido quando evento não chega", async () => {
  const f = fixture();
  const runtime = f.service.start(f.client);
  await runtime.initialPoll;
  const requests = await f.repository.listRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].source, "poll");
  f.service.stop(f.client);
});

test("evento e polling convergem sem duplicar fila, mensagem ou Cadastro", async () => {
  const f = fixture();
  const runtime = f.service.start(f.client);
  try {
    await Promise.all([
      runtime.initialPoll,
      f.service.handleEvent(f.client, f.notification())
    ]);
    await f.service.poll(f.client);
    assert.equal((await f.repository.listRequests()).length, 1);
    assert.equal(f.flows.length, 1);
    assert.equal(f.sent.filter(item => item.text === UNREGISTERED_MESSAGE).length, 1);
  } finally {
    f.service.stop(f.client);
  }
});

test("usuário já cadastrado é aprovado individualmente", async () => {
  const f = fixture({
    registrations: [{
      primaryIdentity: "requester@lid",
      identityAliases: ["requester@lid"]
    }]
  });
  const result = await f.service.processRequest(f.client, {
    source: "event",
    groupId: f.groupId,
    requester: "requester@lid"
  });
  assert.equal(result.status, "approved");
  assert.equal(f.sent[0].text, REGISTERED_MESSAGE);
  assert.equal(f.sent[1].text, APPROVED_MESSAGE);
  assert.deepEqual(f.approvals[0], {
    targetGroup: f.groupId,
    approvalOptions: { requesterIds: ["requester@lid"] }
  });
  assert.equal((await f.repository.listRequests())[0].status, "approved");
});

test("conclusão do Cadastro localiza por identidade e aprova", async () => {
  const f = fixture();
  await f.service.processRequest(f.client, {
    source: "event",
    groupId: f.groupId,
    requester: "requester@lid"
  });
  const results = await f.service.handleRegistrationCompleted({
    userId: "requester@lid",
    identity: { candidates: ["requester@lid"] },
    client: f.client
  });
  assert.equal(results[0].status, "approved");
  assert.equal(f.approvals.length, 1);
  assert.equal((await f.repository.listRequests())[0].status, "approved");
});

test("cadastro incompleto, cancelado ou salvo como rascunho não aprova", async () => {
  const incomplete = fixture();
  await incomplete.service.processRequest(incomplete.client, {
    source: "event", groupId: incomplete.groupId, requester: "requester@lid"
  });
  assert.equal(incomplete.approvals.length, 0);
  assert.equal((await incomplete.repository.listRequests())[0].status, "pending_registration");

  const draft = fixture();
  await draft.service.processRequest(draft.client, {
    source: "event", groupId: draft.groupId, requester: "requester@lid"
  });
  assert.equal(draft.approvals.length, 0);
  assert.equal((await draft.repository.listRequests())[0].status, "pending_registration");

  const cancelled = fixture();
  await cancelled.service.processRequest(cancelled.client, {
    source: "event", groupId: cancelled.groupId, requester: "requester@lid"
  });
  await cancelled.service.handleRegistrationCancelled({
    userId: "requester@lid",
    identity: { candidates: ["requester@lid"] }
  });
  assert.equal(cancelled.approvals.length, 0);
  assert.equal((await cancelled.repository.listRequests())[0].status, "registration_cancelled");
});

test("Cadastro cancelado e expirado permanecem sem aprovação", async () => {
  const cancelled = fixture();
  await cancelled.service.processRequest(cancelled.client, {
    source: "event", groupId: cancelled.groupId, requester: "requester@lid"
  });
  await cancelled.service.handleRegistrationCancelled({
    userId: "requester@lid",
    identity: { candidates: ["requester@lid"] }
  });
  assert.equal((await cancelled.repository.listRequests())[0].status, "registration_cancelled");
  assert.equal(cancelled.approvals.length, 0);

  const expired = fixture();
  await expired.service.processRequest(expired.client, {
    source: "event", groupId: expired.groupId, requester: "requester@lid"
  });
  expired.advance(31 * 60 * 1000);
  await expired.service.markExpiredRequests();
  assert.equal((await expired.repository.listRequests())[0].status, "registration_expired");
  assert.equal(expired.approvals.length, 0);
});

test("pedido cancelado permite novo ciclo sem apagar o histórico", async () => {
  const f = fixture();
  await f.service.processRequest(f.client, {
    source: "poll", groupId: f.groupId, requester: "requester@lid",
    requestTimestamp: 1
  });
  await f.service.handleRegistrationCancelled({
    userId: "requester@lid",
    identity: { candidates: ["requester@lid"] }
  });
  const sameCycle = await f.service.processRequest(f.client, {
    source: "poll", groupId: f.groupId, requester: "requester@lid",
    requestTimestamp: 1
  });
  assert.equal(sameCycle.status, "duplicate");
  assert.equal(sameCycle.discardReason, "alreadyCancelled");
  const newCycle = await f.service.processRequest(f.client, {
    source: "poll", groupId: f.groupId, requester: "requester@lid",
    requestTimestamp: 2
  });
  assert.equal(newCycle.status, "pending_registration");
  assert.equal((await f.repository.listRequests()).length, 2);
  assert.equal(f.flows.length, 2);
});

test("pedido expirado permite novo ciclo", async () => {
  const f = fixture();
  await f.service.processRequest(f.client, {
    source: "poll", groupId: f.groupId, requester: "requester@lid",
    requestTimestamp: 1
  });
  f.advance(31 * 60 * 1000);
  await f.service.markExpiredRequests();
  const sameCycle = await f.service.processRequest(f.client, {
    source: "poll", groupId: f.groupId, requester: "requester@lid",
    requestTimestamp: 1
  });
  assert.equal(sameCycle.status, "duplicate");
  const next = await f.service.processRequest(f.client, {
    source: "poll", groupId: f.groupId, requester: "requester@lid",
    requestTimestamp: 2
  });
  assert.equal(next.status, "pending_registration");
  assert.equal((await f.repository.listRequests()).length, 2);
});

test("pedido aprovado permite novo ciclo sem duplicar a mesma solicitação", async () => {
  const f = fixture({
    registrations: [{
      primaryIdentity: "requester@lid",
      identityAliases: ["requester@lid"]
    }]
  });
  const first = await f.service.processRequest(f.client, {
    source: "poll", groupId: f.groupId, requester: "requester@lid",
    requestTimestamp: 1
  });
  assert.equal(first.status, "approved");
  const duplicate = await f.service.processRequest(f.client, {
    source: "poll", groupId: f.groupId, requester: "requester@lid",
    requestTimestamp: 1
  });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.discardReason, "alreadyApproved");
  f.setPending([{ id: { _serialized: "requester@lid" }, t: 2 }]);
  const next = await f.service.processRequest(f.client, {
    source: "poll", groupId: f.groupId, requester: "requester@lid",
    requestTimestamp: 2
  });
  assert.equal(next.status, "approved");
  assert.equal(f.approvals.length, 2);
  assert.equal((await f.repository.listRequests()).length, 2);
});

test("mesmo pedido pendente não duplica mensagem nem Cadastro", async () => {
  const f = fixture();
  const input = {
    source: "poll", groupId: f.groupId, requester: "requester@lid",
    requestTimestamp: 1
  };
  assert.equal((await f.service.processRequest(f.client, input)).status, "pending_registration");
  const duplicate = await f.service.processRequest(f.client, input);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.discardReason, "samePendingRequest");
  assert.equal(f.flows.length, 1);
  assert.equal(f.sent.filter(item => item.text === UNREGISTERED_MESSAGE).length, 1);
  assert.ok(f.lifecycleLogs.includes("requestSeen=true"));
  assert.ok(f.lifecycleLogs.includes("requestKnown=true"));
  assert.ok(f.lifecycleLogs.includes("newCycle=false"));
  assert.ok(f.lifecycleLogs.includes("discardReason=samePendingRequest"));
});

test("falha no privado mantém pedido pendente e não aprova", async () => {
  const f = fixture({ privateFails: true });
  const result = await f.service.processRequest(f.client, {
    source: "event", groupId: f.groupId, requester: "requester@lid"
  });
  assert.equal(result.reason, "private_message_failed");
  assert.equal(f.approvals.length, 0);
  const request = (await f.repository.listRequests())[0];
  assert.equal(request.status, "pending_registration");
  assert.equal(request.errorCode, "private_message_failed");
});

test("falha de aprovação preserva cadastro e orienta administração manual", async () => {
  const f = fixture({
    approvalFails: true,
    registrations: [{ primaryIdentity: "requester@lid", identityAliases: [] }]
  });
  const result = await f.service.processRequest(f.client, {
    source: "event", groupId: f.groupId, requester: "requester@lid"
  });
  assert.equal(result.status, "approval_failed");
  assert.equal(f.sent.at(-1).text, APPROVAL_FAILED_MESSAGE);
  assert.equal((await f.repository.listRequests())[0].status, "approval_failed");
  assert.ok(f.approvalLogs.includes("requestWasPending=true"));
  assert.ok(f.approvalLogs.includes("approvalAttempted=true"));
  assert.ok(f.approvalLogs.includes("approvalSucceeded=false"));
  assert.ok(f.approvalLogs.includes("requestStillPending=true"));
});

test("resposta ambígua da API com participante no grupo é sucesso", async () => {
  const f = fixture({
    ambiguousApproval: true,
    participantJoined: true,
    registrations: [{ primaryIdentity: "requester@lid", identityAliases: [] }]
  });
  const result = await f.service.processRequest(f.client, {
    source: "event", groupId: f.groupId, requester: "requester@lid"
  });
  assert.equal(result.status, "approved");
  assert.equal((await f.repository.listRequests())[0].status, "approved");
  assert.equal(f.sent.filter(item => item.text === APPROVED_MESSAGE).length, 1);
  assert.equal(f.sent.filter(item => item.text === APPROVAL_FAILED_MESSAGE).length, 0);
});

test("falha real mantém pedido pendente e envia somente orientação manual", async () => {
  const f = fixture({
    approvalFails: true,
    registrations: [{ primaryIdentity: "requester@lid", identityAliases: [] }]
  });
  const result = await f.service.processRequest(f.client, {
    source: "event", groupId: f.groupId, requester: "requester@lid"
  });
  assert.equal(result.status, "approval_failed");
  assert.equal((await f.client.getGroupMembershipRequests(f.groupId)).length, 1);
  assert.equal(f.sent.filter(item => item.text === APPROVED_MESSAGE).length, 0);
  assert.equal(f.sent.filter(item => item.text === APPROVAL_FAILED_MESSAGE).length, 1);
  const duplicate = await f.service.processRequest(f.client, {
    source: "poll", groupId: f.groupId, requester: "requester@lid"
  });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(f.approvals.length, 1);
});

test("bot sem permissão não aprova", async () => {
  const f = fixture({
    botAdmin: false,
    registrations: [{ primaryIdentity: "requester@lid", identityAliases: [] }]
  });
  const result = await f.service.processRequest(f.client, {
    source: "event", groupId: f.groupId, requester: "requester@lid"
  });
  assert.equal(result.reason, "bot_not_group_admin");
  assert.equal(f.approvals.length, 0);
});

test("pedido removido é marcado indisponível e nunca aprovado", async () => {
  const f = fixture();
  await f.service.processRequest(f.client, {
    source: "event", groupId: f.groupId, requester: "requester@lid"
  });
  f.setPending([]);
  const runtime = f.service.start(f.client);
  await runtime.initialPoll;
  assert.equal((await f.repository.listRequests())[0].status, "unavailable");
  assert.equal(f.approvals.length, 0);
  f.service.stop(f.client);
});

test("fila persistente sobrevive a nova instância", async () => {
  const f = fixture();
  await f.service.processRequest(f.client, {
    source: "event", groupId: f.groupId, requester: "requester@lid"
  });
  const reopened = createJoinRequestRepository({
    directory: path.join(f.root, "queue")
  });
  const restored = await reopened.listRequests();
  assert.equal(restored.length, 1);
  assert.equal(restored[0].userIdentity, "requester@lid");
});

for (const requester of ["opaque@lid", "5511999999999@c.us"]) {
  test(`preserva identidade oficial ${requester.split("@")[1]} e aliases`, async () => {
    const f = fixture();
    await f.service.processRequest(f.client, {
      source: "event", groupId: f.groupId, requester
    });
    const request = (await f.repository.listRequests())[0];
    assert.equal(request.requesterId, requester);
    assert.ok(request.identityAliases.length >= 1);
    assert.equal(f.sent[0].target, requester);
  });
}

test("logs são sanitizados e nenhum outro pedido é aprovado", async () => {
  const f = fixture({
    registrations: [{ primaryIdentity: "requester@lid", identityAliases: [] }],
    pending: [
      { id: { _serialized: "requester@lid" } },
      { id: { _serialized: "other@lid" } }
    ]
  });
  await f.service.processRequest(f.client, {
    source: "event", groupId: f.groupId, requester: "requester@lid"
  });
  assert.deepEqual(f.approvals[0].approvalOptions.requesterIds, ["requester@lid"]);
  assert.doesNotMatch(f.logs.join("\n"), /requester|other|@lid|@c\.us|@g\.us/);
});

test("start é único, polling não sobrepõe e stop limpa o interval", async () => {
  const f = fixture();
  const first = f.service.start(f.client);
  const second = f.service.start(f.client);
  assert.equal(first.interval, second.interval);
  assert.equal(f.service.stop(f.client), true);
  assert.equal(first.interval, null);
});

test("loader mantém um listener de mensagem e um de pedido", () => {
  const loader = require("../src/loader");
  class Client extends EventEmitter {
    async sendMessage() {}
    async getGroupMembershipRequests() { return []; }
  }
  const client = new Client();
  loader.attach(client);
  loader.attach(client);
  assert.equal(client.listenerCount("message"), 1);
  assert.equal(client.listenerCount("group_membership_request"), 1);
  loader.detach(client);
});

test("boot registra attach, ready, listener, polling e intervalo sem aguardar pedido", () => {
  const loader = require("../src/loader");
  const output = [];
  const originalLog = console.log;
  class Client extends EventEmitter {
    async sendMessage() {}
    async getGroupMembershipRequests() { return []; }
  }
  const client = new Client();
  try {
    console.log = value => output.push(String(value));
    loader.attach(client);
  } finally {
    console.log = originalLog;
    loader.detach(client);
  }
  assert.ok(output.includes("[JOIN_REQUEST_BOOT] attachCalled=true"));
  assert.ok(output.includes("[JOIN_REQUEST_BOOT] listenerRegistered=true"));
  assert.ok(output.includes("[JOIN_REQUEST_BOOT] pollingStarted=true"));
  assert.ok(output.includes("[JOIN_REQUEST_BOOT] pollInterval=30000"));
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(indexSource, /\[JOIN_REQUEST_BOOT\] readyReached=true/);
});

test("telemetria audita polling, processamento e aprovação sem identidades", async () => {
  const f = fixture({
    registrations: [{
      primaryIdentity: "requester@lid",
      identityAliases: ["requester@lid"]
    }]
  });
  const runtime = f.service.start(f.client);
  await runtime.initialPoll;
  f.service.stop(f.client);

  assert.ok(f.pollLogs.includes("started=true"));
  assert.ok(f.pollLogs.includes("groupsChecked=1"));
  assert.ok(f.pollLogs.includes("requestsFound=1"));
  assert.ok(f.pollLogs.includes("requestProcessed=true"));
  assert.ok(f.pollLogs.includes("beforeDedup=1"));
  assert.ok(f.pollLogs.includes("afterDedup=1"));
  assert.ok(f.processLogs.includes("queued=true"));
  assert.ok(f.processLogs.includes("registrationFound=true"));
  assert.ok(f.processLogs.includes("privateMessageAttempted=true"));
  assert.ok(f.processLogs.includes("privateMessageSucceeded=true"));
  assert.ok(f.approvalLogs.includes("approvalAttempted=true"));
  assert.ok(f.approvalLogs.includes("approvalSucceeded=true"));
  assert.ok(f.approvalLogs.includes("approvalMethodAvailable=true"));
  assert.ok(f.approvalLogs.includes("requestWasPending=true"));
  assert.ok(f.approvalLogs.includes("requestStillPending=false"));
  assert.deepEqual(f.summaryLogs, [
    "groups=1 requests=1 processed=1 errors=0"
  ]);
  assert.doesNotMatch(
    [...f.pollLogs, ...f.processLogs, ...f.approvalLogs, ...f.summaryLogs].join("\n"),
    /requester|@lid|@c\.us|@g\.us|551199/
  );
});

test("polling vazio e erro da API produzem diagnóstico e um resumo por ciclo", async () => {
  const empty = fixture({ pending: [] });
  const emptyRuntime = empty.service.start(empty.client);
  await emptyRuntime.initialPoll;
  empty.service.stop(empty.client);
  assert.ok(empty.pollLogs.includes("requestsFound=0"));
  assert.ok(empty.pollLogs.includes("requestProcessed=false"));
  assert.deepEqual(empty.summaryLogs, [
    "groups=1 requests=0 processed=0 errors=0"
  ]);

  const failed = fixture();
  failed.client.getGroupMembershipRequests = async () => {
    const error = new Error("sensitive details");
    error.code = "API_UNAVAILABLE";
    throw error;
  };
  const failedRuntime = failed.service.start(failed.client);
  await failedRuntime.initialPoll;
  failed.service.stop(failed.client);
  assert.ok(failed.pollLogs.includes("pollError=true"));
  assert.ok(failed.pollLogs.includes("errorCode=api_unavailable"));
  assert.doesNotMatch(failed.pollLogs.join("\n"), /errorName=|errorMessage=/);
  assert.deepEqual(failed.summaryLogs, [
    "groups=1 requests=0 processed=0 errors=1"
  ]);
  assert.doesNotMatch(failed.pollLogs.join("\n"), /@lid|@c\.us|@g\.us|\d{4,}/);
});

test("listener registra evento imediatamente com metadados booleanos", async () => {
  const loader = require("../src/loader");
  const joinRequests = require("../src/services/joinRequestService");
  const output = [];
  const originalLog = console.log;
  const originalHandleEvent = joinRequests.handleEvent;
  class Client extends EventEmitter {
    async sendMessage() {}
    async getGroupMembershipRequests() { return []; }
  }
  const client = new Client();
  try {
    console.log = value => output.push(String(value));
    joinRequests.handleEvent = async () => ({ status: "observed" });
    loader.attach(client);
    client.emit("group_membership_request", {
      author: "private@lid",
      chatId: "private-group@g.us"
    });
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    joinRequests.handleEvent = originalHandleEvent;
    console.log = originalLog;
    loader.detach(client);
  }
  assert.ok(output.includes("[JOIN_REQUEST_EVENT] received=true"));
  assert.ok(output.includes("[JOIN_REQUEST_EVENT] authorPresent=true"));
  assert.ok(output.includes("[JOIN_REQUEST_EVENT] chatIdPresent=true"));
  assert.ok(output.includes("[JOIN_REQUEST_EVENT] notificationValid=true"));
  assert.doesNotMatch(output.join("\n"), /private@lid|private-group/);
});

test("retorno voluntário em até sete dias aprova sem revalidação", async () => {
  const f = fixture({ registrations: [{ primaryIdentity: "requester@lid", identityAliases: ["requester@lid"] }], memberExperienceRepository: { getMember: async () => ({ groups: { "group@g.us": { lastExitReason: "voluntary_leave", lastLeaveAt: "2026-07-22T12:00:00.000Z" } } }), getGroupConfig: async () => ({ returnRevalidationDays: 7 }) } });
  const result = await f.service.handleEvent(f.client, f.notification());
  assert.equal(result.status, "approved"); assert.equal(f.approvals.length, 1); assert.equal(f.flows.length, 0);
});

test("retorno voluntário após prazo exige revalidação privada antes de aprovar", async () => {
  const f = fixture({ registrations: [{ primaryIdentity: "requester@lid", identityAliases: ["requester@lid"] }], memberExperienceRepository: { getMember: async () => ({ groups: { "group@g.us": { lastExitReason: "voluntary_leave", lastLeaveAt: "2026-07-20T11:59:59.000Z" } } }), getGroupConfig: async () => ({ returnRevalidationDays: 7 }) } });
  const result = await f.service.handleEvent(f.client, f.notification());
  assert.equal(result.status, "revalidation_required"); assert.equal(f.approvals.length, 0); assert.equal(f.flows.length, 1);
  assert.equal((await f.repository.listRequests())[0].status, "revalidation_required"); assert.match(f.sent.at(-1).text, /REVALIDAÇÃO 7/);
});

test("prazo configurado é respeitado e histórico ausente não é inferido", async () => {
  const configured = fixture({ memberExperienceRepository: { getMember: async () => ({ groups: { "group@g.us": { lastExitReason: "voluntary_leave", lastLeaveAt: "2026-07-25T12:00:00.000Z" } } }), getGroupConfig: async () => ({ returnRevalidationDays: 2 }) } });
  const stored = await configured.repository.upsertPending({ groupIdentity: "group@g.us", userIdentity: "requester@lid", requesterId: "requester@lid", identityAliases: ["requester@lid"] });
  assert.equal((await configured.service.requiredRevalidation(stored.request)).required, true);
  const unknown = fixture(); const pending = await unknown.repository.upsertPending({ groupIdentity: "group@g.us", userIdentity: "requester@lid", requesterId: "requester@lid", identityAliases: ["requester@lid"] });
  assert.equal((await unknown.service.requiredRevalidation(pending.request)).required, false);
});

test("confirmação privada atualiza data de validação e somente então aprova", async () => {
  let validated = null;
  const registration = { registrationId: "REG000001", primaryIdentity: "requester@lid", identityAliases: ["requester@lid"] };
  const f = fixture({ registrationService: { getRegistrationByIdentity: async () => registration, updateRegistration: async (_id, changes) => { validated = changes.lastValidatedAt; return { ...registration, ...changes }; } } });
  const stored = await f.repository.upsertPending({ groupIdentity: "group@g.us", userIdentity: "requester@lid", requesterId: "requester@lid", identityAliases: ["requester@lid"] });
  await f.repository.updateRequest(stored.request.id, { status: "revalidation_required" });
  const result = await f.service.completeReturnRevalidation({ userId: "requester@lid", identity: { candidates: ["requester@lid"] }, client: f.client });
  assert.equal(result[0].status, "approved"); assert.equal(f.approvals.length, 1); assert.match(validated, /^2026-07-28T12:00:00/);
  assert.equal((await f.repository.listRequests())[0].status, "approved");
});
