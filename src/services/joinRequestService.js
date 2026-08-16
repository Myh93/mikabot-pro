"use strict";

const crypto = require("crypto");
const identityServiceDefault = require("./identityService");
const registrationServiceDefault = require("./registrationService");
const repositoryDefault = require("../repositories/joinRequestRepository");
const groupDirectoryDefault = require("./groupDirectoryService");
const disciplineServiceDefault = require("./disciplineService");
const configurationServiceDefault = require("./configurationService");
const memberExperienceRepositoryDefault = require("../repositories/memberExperienceRepository");
const { createRegistrationStateService, STATES: REGISTRATION_STATES } = require("./registrationStateService");
const { FALLBACK: REGISTRATION_PRIVATE_FALLBACK } = require("./registrationPrivateShortcutService");

const POLL_INTERVAL_MS = 30 * 1000;
const UNREGISTERED_MESSAGE = [
  "👋 Olá! Seu pedido para entrar no grupo foi recebido.",
  "",
  "Antes da entrada, você precisa concluir seu cadastro no MikaBot.",
  "",
  "Vamos começar agora.",
  "",
  "Se precisar retomar depois:",
  "",
  REGISTRATION_PRIVATE_FALLBACK
].join("\n");
const REGISTERED_MESSAGE = [
  "✅ Seu cadastro já foi localizado.",
  "",
  "Seu pedido será processado automaticamente."
].join("\n");
const APPROVED_MESSAGE = [
  "✅ Cadastro concluído e entrada aprovada!",
  "",
  "Você já pode acessar o grupo."
].join("\n");
const APPROVAL_FAILED_MESSAGE = [
  "⚠️ Seu cadastro foi concluído, mas não foi possível aprovar sua entrada automaticamente.",
  "",
  "A administração poderá analisar o pedido."
].join("\n");
const DISCIPLINE_REVIEW_MESSAGE = "⚠️ Seu pedido necessita análise administrativa.";
const REVALIDATION_MESSAGE = days => ["👋 Faz mais de " + days + " dias desde sua saída.", "", "Precisamos confirmar se seus dados continuam atualizados.", "", "1️⃣ Confirmar dados atuais", "2️⃣ Atualizar cadastro", "3️⃣ Cancelar retorno"].join("\n");

function serializeOfficialId(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value._serialized === "string") return value._serialized;
  if (value.user && value.server) return `${value.user}@${value.server}`;
  return "";
}

function serializeNotificationId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return typeof value._serialized === "string" ? value._serialized :
    typeof value.id === "string" ? value.id : null;
}

function createJoinRequestService(options = {}) {
  const identityService = options.identityService || identityServiceDefault;
  const registrationService = options.registrationService || registrationServiceDefault;
  const repository = options.repository || repositoryDefault;
  const groupDirectory = options.groupDirectoryService || groupDirectoryDefault;
  const disciplineService = options.disciplineService || disciplineServiceDefault;
  const configurationService = options.configurationService || configurationServiceDefault;
  const memberExperienceRepository = options.memberExperienceRepository || memberExperienceRepositoryDefault;
  const registrationStateService = options.registrationStateService || createRegistrationStateService({
    registrationService, joinRequestRepository: repository, disciplineService,
    identityService, memberLifecycleRepository: options.memberLifecycleRepository
  });
  const registrationGuidedFlow = options.registrationGuidedFlowService ||
    require("./registrationGuidedFlowService");
  const clock = options.clock || (() => new Date());
  const log = options.log || (value => console.log(`[JOIN_REQUEST] ${value}`));
  const debugLog = options.debugLog ||
    (value => console.log(`[JOIN_REQUEST_DEBUG] ${value}`));
  const pollLog = options.pollLog ||
    (value => console.log(`[JOIN_REQUEST_POLL] ${value}`));
  const processLog = options.processLog ||
    (value => console.log(`[JOIN_REQUEST_PROCESS] ${value}`));
  const approvalLog = options.approvalLog ||
    (value => console.log(`[JOIN_REQUEST_APPROVAL] ${value}`));
  const summaryLog = options.summaryLog ||
    (value => console.log(`[JOIN_REQUEST_SUMMARY] ${value}`));
  const lifecycleLog = options.lifecycleLog ||
    (value => console.log(`[JOIN_REQUEST_LIFECYCLE] ${value}`));
  const runtimes = new WeakMap();
  const processing = new Map();
  const temporaryIncompatibilities = new Map();

  function resolvePollIntervalMilliseconds() {
    if (
      typeof options.intervalMs === "number" &&
      Number.isFinite(options.intervalMs) &&
      Number.isInteger(options.intervalMs) &&
      options.intervalMs > 0
    ) {
      return options.intervalMs;
    }

    try {
      const configured = configurationService?.getResolved?.(
        "joinRequest.pollIntervalMilliseconds"
      );
      if (
        typeof configured === "number" &&
        Number.isFinite(configured) &&
        Number.isInteger(configured) &&
        configured > 0
      ) {
        return configured;
      }
    } catch (_) {
      // A infraestrutura de configuração é opcional neste serviço.
    }

    return POLL_INTERVAL_MS;
  }

  function sanitizedErrorCode(error, fallback = "poll_failed") {
    return String(error?.code || error?.name || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");
  }

  function sanitizedErrorMessage(error) {
    const message = String(error?.message || "unknown_error")
      .replace(/[a-z0-9._:+-]+@(c\.us|s\.whatsapp\.net|lid|g\.us)/gi, "[redacted]")
      .replace(/\d{4,}/g, "[redacted]")
      .replace(/\s+/g, " ")
      .trim();
    return (message || "unknown_error").slice(0, 120);
  }

  function isTemporaryIncompatibilityError(error) {
    if (error?.code) return false;
    return ["t", "error", "poll_failed"].includes(sanitizedErrorCode(error));
  }

  function recordTemporaryIncompatibility(groupId) {
    const now = clock().getTime();
    const previous = temporaryIncompatibilities.get(groupId);
    const consecutiveFailures = Number(previous?.consecutiveFailures || 0) + 1;
    const delay = consecutiveFailures === 1
      ? 0
      : consecutiveFailures === 2 ? 5 * 60 * 1000 : 15 * 60 * 1000;
    temporaryIncompatibilities.set(groupId, {
      consecutiveFailures,
      lastFailureAt: now,
      nextRetryAt: now + delay
    });
  }

  function diagnosticErrorCode(error, stage, fallback = "processing_failed") {
    const normalizedStage = String(stage || "unknown")
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_");
    return `${normalizedStage}_${sanitizedErrorCode(error, fallback)}`;
  }

  function logResult(audit) {
    log(`source=${audit.source}`);
    log(`requestDetected=${audit.requestDetected}`);
    log(`registrationFound=${audit.registrationFound}`);
    log(`privateMessageSucceeded=${audit.privateMessageSucceeded}`);
    log(`registrationFlowStarted=${audit.registrationFlowStarted}`);
    log(`registrationCompleted=${audit.registrationCompleted}`);
    log(`approvalAttempted=${audit.approvalAttempted}`);
    log(`approvalSucceeded=${audit.approvalSucceeded}`);
    log(`errorCode=${audit.errorCode || "none"}`);
  }

  function requestData(source, groupId, requester, notificationId = null, requestTimestamp = null) {
    const officialUserId = serializeOfficialId(requester);
    const userIdentity = identityService.normalizeUserId(officialUserId);
    const identityAliases = identityService.collectCanonicalIdentityCandidates(officialUserId);
    const groupIdentity = typeof groupId === "string" && groupId.endsWith("@g.us")
      ? groupId
      : "";
    const cycleSource = requestTimestamp ?? serializeNotificationId(notificationId);
    const cycleKey = groupIdentity && userIdentity && cycleSource
      ? crypto.createHash("sha256")
        .update(`${groupIdentity}|${userIdentity}|${String(cycleSource)}`)
        .digest("hex")
      : null;
    return {
      source,
      groupIdentity,
      userIdentity,
      identityAliases,
      requesterId: officialUserId,
      notificationId: serializeNotificationId(notificationId),
      cycleKey
    };
  }

  async function botAdminState(client, groupId) {
    if (!client?.info?.wid || typeof client.getChatById !== "function") return "unknown";
    try {
      const chat = await client.getChatById(groupId);
      const participant = (chat?.participants || []).find(item =>
        identityService.identitiesMatch(item.id, client.info.wid)
      );
      if (!participant) return false;
      return Boolean(participant.isAdmin || participant.isSuperAdmin);
    } catch (_) {
      return "unknown";
    }
  }

  async function pendingStillExists(client, request) {
    if (typeof client?.getGroupMembershipRequests !== "function") return null;
    try {
      const pending = await client.getGroupMembershipRequests(request.groupIdentity);
      return (pending || []).some(item =>
        identityService.identitiesMatch(serializeOfficialId(item.id), request.requesterId)
      );
    } catch (_) {
      return null;
    }
  }

  async function participantAlreadyInGroup(client, request) {
    if (typeof client?.getChatById !== "function") return null;
    try {
      const chat = await client.getChatById(request.groupIdentity);
      return (chat?.participants || []).some(item =>
        identityService.identitiesMatch(item.id, request.requesterId)
      );
    } catch (_) {
      return null;
    }
  }

  async function requiredRevalidation(request) {
    const member = await memberExperienceRepository.getMember(request.userIdentity);
    const history = member?.groups?.[request.groupIdentity];
    if (!history?.lastLeaveAt || history.lastExitReason !== "voluntary_leave") return { required: false };
    const config = await memberExperienceRepository.getGroupConfig(request.groupIdentity);
    const days = Number.isInteger(Number(config.returnRevalidationDays)) && Number(config.returnRevalidationDays) >= 1 ? Number(config.returnRevalidationDays) : 7;
    const elapsed = clock().getTime() - Date.parse(history.lastLeaveAt);
    if (!Number.isFinite(elapsed) || elapsed <= days * 86400000) return { required: false, days };
    return { required: true, days, lastLeaveAt: history.lastLeaveAt };
  }

  async function beginRevalidation(client, request, gate) {
    await repository.updateRequest(request.id, { status: "revalidation_required", revalidationRequiredAt: clock().toISOString(), errorCode: null });
    const context = { platform: "whatsapp", groupId: request.userIdentity, conversationId: request.userIdentity, userId: request.userIdentity, isGroup: false, client, replyText: text => client.sendMessage(request.requesterId, String(text)) };
    await registrationGuidedFlow.startReturnRevalidation(context, { requestId: request.id, days: gate.days });
    return { status: "revalidation_required", request: await repository.updateRequest(request.id, {}) };
  }

  async function completeReturnRevalidation(context) {
    const candidates = identityService.collectCanonicalIdentityCandidates(context?.userId, ...(context?.identity?.candidates || []));
    const requests = await repository.findPendingByIdentity(candidates, identityService.identitiesMatch);
    const results = [];
    for (const request of requests.filter(item => ["revalidation_required", "revalidation_editing"].includes(item.status))) {
      const registration = await registrationService.getRegistrationByIdentity({ id: request.userIdentity, candidates: request.identityAliases });
      if (!registration) { results.push({ status: "registration_missing" }); continue; }
      await registrationService.updateRegistration(registration.registrationId, { lastValidatedAt: clock().toISOString() });
      await repository.updateRequest(request.id, { status: "registration_completed", revalidatedAt: clock().toISOString(), errorCode: null });
      const audit = { approvalAttempted: false, approvalSucceeded: false, approvalMethodAvailable: false, requestWasPending: false, requestStillPending: false };
      try { const approved = await approve(context.client, request, audit); await context.client.sendMessage(request.requesterId, APPROVED_MESSAGE).catch(() => undefined); results.push({ status: "approved", request: approved }); }
      catch (error) { await repository.updateRequest(request.id, { status: "approval_failed", errorCode: error.code || "approval_failed" }); results.push({ status: "approval_failed", reason: error.code || "approval_failed" }); }
    }
    return results;
  }

  async function markRevalidationEditing(userId) {
    const candidates = identityService.collectCanonicalIdentityCandidates(userId);
    const requests = await repository.findPendingByIdentity(candidates, identityService.identitiesMatch);
    return Promise.all(requests.filter(item => item.status === "revalidation_required").map(item => repository.updateRequest(item.id, { status: "revalidation_editing" })));
  }

  async function approve(client, request, audit) {
    const discipline = await disciplineService.isBlocked({
      identity: { id: request.userIdentity, candidates: request.identityAliases },
      platform: "whatsapp",
      groupId: request.groupIdentity
    });
    if (discipline.blocked) {
      await disciplineService.notifyBlockedJoin({
        identity: request.userIdentity,
        groupId: request.groupIdentity,
        reason: discipline.reason
      });
      throw Object.assign(new Error("disciplinary_review_required"), {
        code: "disciplinary_review_required"
      });
    }
    audit.approvalAttempted = true;
    audit.approvalMethodAvailable =
      typeof client?.approveGroupMembershipRequests === "function";
    const admin = await botAdminState(client, request.groupIdentity);
    if (admin === false) throw Object.assign(new Error("bot_not_group_admin"), {
      code: "bot_not_group_admin"
    });
    const stillPending = await pendingStillExists(client, request);
    audit.requestWasPending = stillPending === true;
    if (stillPending === false) {
      const alreadyJoined = await participantAlreadyInGroup(client, request);
      audit.requestStillPending = false;
      if (alreadyJoined === true) {
        audit.approvalSucceeded = true;
        return repository.updateRequest(request.id, {
          status: "approved",
          approvedAt: clock().toISOString(),
          errorCode: null
        });
      }
      await repository.updateRequest(request.id, {
        status: "unavailable",
        errorCode: "request_not_pending"
      });
      throw Object.assign(new Error("request_not_pending"), {
        code: "request_not_pending"
      });
    }
    if (!audit.approvalMethodAvailable) {
      throw Object.assign(new Error("approval_method_unavailable"), {
        code: "approval_method_unavailable"
      });
    }
    let result;
    let approvalError;
    try {
      result = await client.approveGroupMembershipRequests(
        request.groupIdentity,
        { requesterIds: [request.requesterId] }
      );
    } catch (error) {
      approvalError = error;
    }
    const successful = Array.isArray(result) && result.some(item =>
      !item?.error &&
      (Array.isArray(item.requesterId) ? item.requesterId : [item.requesterId])
        .some(id => identityService.identitiesMatch(id, request.requesterId))
    );
    const pendingAfterApproval = await pendingStillExists(client, request);
    audit.requestStillPending = pendingAfterApproval === true;
    const participantJoined = pendingAfterApproval === false
      ? await participantAlreadyInGroup(client, request)
      : false;
    if (!successful && !(pendingAfterApproval === false && participantJoined === true)) {
      if (approvalError) throw approvalError;
      throw Object.assign(new Error("approval_not_confirmed"), {
        code: "approval_not_confirmed"
      });
    }
    audit.approvalSucceeded = true;
    audit.requestStillPending = false;
    return repository.updateRequest(request.id, {
      status: "approved",
      approvedAt: clock().toISOString(),
      errorCode: null
    });
  }

  async function updatePendingStateAfterFailure(client, request, audit) {
    if (audit.approvalSucceeded) {
      audit.requestStillPending = false;
      return;
    }
    const finalState = await pendingStillExists(client, request);
    audit.requestStillPending = finalState === null
      ? Boolean(audit.requestWasPending)
      : finalState;
  }

  async function processRequestUnlocked(client, input) {
    const audit = {
      source: input.source,
      requestDetected: false,
      registrationFound: false,
      privateMessageSucceeded: false,
      privateMessageAttempted: false,
      queued: false,
      registrationFlowStarted: false,
      registrationCompleted: false,
      approvalAttempted: false,
      approvalSucceeded: false,
      approvalMethodAvailable: false,
      requestWasPending: false,
      requestStillPending: false,
      errorCode: "none",
      errorName: "none",
      errorMessage: "none",
      errorStage: "none",
      flowStoppedAt: "requestReceived",
      requestReceived: true,
      dedupPassed: false,
      discardReason: "none",
      identityResolved: false,
      registrationLookupStarted: false,
      registrationLookupFinished: false,
      lookupMethod: "repository",
      lookupReturned: false,
      privateChatResolutionStarted: false,
      privateChatResolutionFinished: false,
      privateChatAvailable: false,
      clientAvailable: Boolean(client)
    };
    try {
      processLog("requestReceived=true");
      audit.errorStage = "identityResolution";
      const data = requestData(
        input.source,
        input.groupId,
        input.requester,
        input.notificationId,
        input.requestTimestamp
      );
      audit.identityResolved = Boolean(
        data.groupIdentity && data.userIdentity && data.requesterId
      );
      audit.flowStoppedAt = "identityResolution";
      if (!data.groupIdentity || !data.userIdentity || !data.requesterId) {
        audit.errorCode = "invalid_notification";
        return { status: "ignored", reason: audit.errorCode };
      }
      audit.requestDetected = true;
      const stored = await repository.upsertPending(data);
      audit.queued = true;
      const request = stored.request;
      lifecycleLog("requestSeen=true");
      lifecycleLog(`requestKnown=${!stored.created}`);
      lifecycleLog(`newCycle=${Boolean(stored.newCycle)}`);
      if (!stored.created && request.status === "approved") {
        audit.discardReason = "alreadyApproved";
        lifecycleLog(`discardReason=${audit.discardReason}`);
        return { status: "duplicate", request, discardReason: audit.discardReason };
      }
      if (!stored.created && request.status === "registration_cancelled") {
        audit.discardReason = "alreadyCancelled";
        lifecycleLog(`discardReason=${audit.discardReason}`);
        return { status: "duplicate", request, discardReason: audit.discardReason };
      }
      if (!stored.created && request.status === "registration_expired") {
        audit.discardReason = "duplicateRequest";
        lifecycleLog(`discardReason=${audit.discardReason}`);
        return { status: "duplicate", request, discardReason: audit.discardReason };
      }
      if (!stored.created && request.status === "approval_failed") {
        audit.discardReason = "duplicateRequest";
        lifecycleLog(`discardReason=${audit.discardReason}`);
        return { status: "duplicate", request, discardReason: audit.discardReason };
      }
      if (!stored.created && request.status === "unavailable") {
        audit.discardReason = "unknown";
        lifecycleLog(`discardReason=${audit.discardReason}`);
        return { status: "duplicate", request };
      }
      if (!stored.created && request.lastContactAt &&
          ![
            "approval_failed",
            "registration_completed",
            "registration_cancelled",
            "registration_expired"
          ].includes(request.status)) {
        audit.discardReason = "samePendingRequest";
        lifecycleLog(`discardReason=${audit.discardReason}`);
        return { status: "duplicate", request, discardReason: audit.discardReason };
      }

      audit.dedupPassed = true;
      lifecycleLog("discardReason=none");
      audit.flowStoppedAt = "registrationLookup";
      audit.errorStage = "registrationLookup";
      audit.registrationLookupStarted = true;
      const registrationState = await registrationStateService.resolveRegistrationState({
        platform: "whatsapp", conversationId: data.requesterId,
        groupId: data.groupIdentity, userId: data.userIdentity,
        identity: { id: data.userIdentity, candidates: data.identityAliases }
      }, { ignoreJoinRequests: true, ignoreMembership: true });
      const registration = [REGISTRATION_STATES.ACTIVE, REGISTRATION_STATES.BANNED].includes(registrationState.state)
        ? registrationState.registration
        : null;
      audit.registrationLookupFinished = true;
      audit.lookupReturned = Boolean(registration);
      audit.registrationFound = Boolean(registration);
      if (registration) {
        const discipline = await disciplineService.isBlocked({ identity: { id: request.userIdentity, candidates: request.identityAliases }, platform: "whatsapp", groupId: request.groupIdentity });
        if (!discipline.blocked) {
          const gate = await requiredRevalidation(request);
          if (gate.required) return beginRevalidation(client, request, gate);
        }
      }
      audit.flowStoppedAt = "privateChatResolution";
      audit.errorStage = "privateChatResolution";
      audit.privateChatResolutionStarted = true;
      audit.clientAvailable = Boolean(client);
      audit.privateChatAvailable = typeof client?.sendMessage === "function";
      audit.privateChatResolutionFinished = true;
      try {
        audit.flowStoppedAt = "privateMessage";
        audit.errorStage = "privateMessage";
        audit.privateMessageAttempted = true;
        await client.sendMessage(
          data.requesterId,
          registration ? REGISTERED_MESSAGE : UNREGISTERED_MESSAGE
        );
        audit.privateMessageSucceeded = true;
      } catch (error) {
        audit.errorCode = "private_message_failed";
        audit.errorName = String(error?.name || "Error");
        audit.errorMessage = sanitizedErrorMessage(error);
        await repository.updateRequest(request.id, { errorCode: audit.errorCode });
        return { status: "error", reason: audit.errorCode, request };
      }

      await repository.updateRequest(request.id, {
        lastContactAt: clock().toISOString(),
        status: registration ? "registration_completed" : "pending_registration",
        registrationCompletedAt: registration ? clock().toISOString() : null,
        errorCode: null
      });

      if (registration) {
        audit.registrationCompleted = true;
        audit.flowStoppedAt = "approval";
        audit.errorStage = "approval";
        try {
          const approved = await approve(client, request, audit);
          await client.sendMessage(data.requesterId, APPROVED_MESSAGE).catch(() => undefined);
          return { status: "approved", request: approved };
        } catch (error) {
          await updatePendingStateAfterFailure(client, request, audit);
          audit.errorCode = error.code || "approval_failed";
          if (audit.errorCode !== "request_not_pending") {
            await repository.updateRequest(request.id, {
              status: "approval_failed",
              errorCode: audit.errorCode
            });
            await client.sendMessage(data.requesterId,
              audit.errorCode === "disciplinary_review_required"
                ? DISCIPLINE_REVIEW_MESSAGE : APPROVAL_FAILED_MESSAGE
            ).catch(() => undefined);
          }
          return { status: "approval_failed", reason: audit.errorCode };
        }
      }

      const flow = await registrationGuidedFlow.start({
        platform: "whatsapp",
        groupId: data.userIdentity,
        conversationId: data.userIdentity,
        userId: data.userIdentity,
        isGroup: false,
        identity: { id: data.userIdentity, candidates: data.identityAliases },
        replyText: text => client.sendMessage(data.requesterId, String(text)),
        sendText: text => client.sendMessage(data.requesterId, String(text)),
        client
      });
      audit.registrationFlowStarted = ["started", "draft_found"].includes(flow?.status);
      await repository.updateRequest(request.id, {
        flowExpiresAt: flow?.session?.expiresAt || null
      });
      audit.flowStoppedAt = "completed";
      audit.errorStage = "none";
      return { status: "pending_registration", request };
    } catch (error) {
      audit.errorName = String(error?.name || "Error");
      audit.errorMessage = sanitizedErrorMessage(error);
      audit.errorCode = diagnosticErrorCode(
        error,
        audit.errorStage,
        "join_request_processing_failed"
      );
      return { status: "error", reason: audit.errorCode };
    } finally {
      logResult(audit);
      processLog(`dedupPassed=${audit.dedupPassed}`);
      processLog(`discardReason=${audit.discardReason}`);
      processLog(`identityResolved=${audit.identityResolved}`);
      processLog(`registrationLookupStarted=${audit.registrationLookupStarted}`);
      processLog(`registrationLookupFinished=${audit.registrationLookupFinished}`);
      processLog(`lookupMethod=${audit.lookupMethod}`);
      processLog(`lookupReturned=${audit.lookupReturned}`);
      processLog(`privateChatResolutionStarted=${audit.privateChatResolutionStarted}`);
      processLog(`privateChatResolutionFinished=${audit.privateChatResolutionFinished}`);
      processLog(`privateChatAvailable=${audit.privateChatAvailable}`);
      processLog(`clientAvailable=${audit.clientAvailable}`);
      processLog(`privateMessageAttempted=${audit.privateMessageAttempted}`);
      processLog(`privateMessageSucceeded=${audit.privateMessageSucceeded}`);
      processLog(`flowStoppedAt=${audit.flowStoppedAt}`);
      processLog(`errorName=${audit.errorName}`);
      processLog(`errorMessage=${audit.errorMessage}`);
      processLog(`errorStage=${audit.errorStage}`);
      processLog(`errorCode=${audit.errorCode}`);
      if (audit.queued) {
        processLog("queued=true");
        processLog(`registrationFound=${audit.registrationFound}`);
      }
      if (audit.approvalAttempted) {
        approvalLog(`requestWasPending=${audit.requestWasPending}`);
        approvalLog("approvalAttempted=true");
        approvalLog(`approvalSucceeded=${audit.approvalSucceeded}`);
        approvalLog(`approvalMethodAvailable=${audit.approvalMethodAvailable}`);
        approvalLog(`requestStillPending=${audit.requestStillPending}`);
      }
    }
  }

  async function processRequest(client, input) {
    const data = requestData(input.source, input.groupId, input.requester, input.notificationId, input.requestTimestamp);
    const key = `${data.groupIdentity}:${data.userIdentity}`;
    if (!data.groupIdentity || !data.userIdentity) {
      return processRequestUnlocked(client, input);
    }
    if (processing.has(key)) {
      processLog("discardReason=alreadyProcessing");
      lifecycleLog("requestSeen=true");
      lifecycleLog("requestKnown=true");
      lifecycleLog("newCycle=false");
      lifecycleLog("discardReason=alreadyProcessing");
    }
    const previous = processing.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined)
      .then(() => processRequestUnlocked(client, input));
    processing.set(key, current);
    return current.finally(() => {
      if (processing.get(key) === current) processing.delete(key);
    });
  }

  async function handleEvent(client, notification) {
    const clientReady = Boolean(runtimes.get(client)?.ready);
    const valid = Boolean(notification && typeof notification === "object");
    debugLog("eventReceived=true");
    debugLog(`clientReady=${clientReady}`);
    debugLog(`notificationValid=${valid}`);
    debugLog(`authorPresent=${Boolean(notification?.author)}`);
    debugLog(`chatIdPresent=${Boolean(notification?.chatId)}`);
    const admin = notification?.chatId
      ? await botAdminState(client, notification.chatId)
      : "unknown";
    debugLog(`botIsGroupAdmin=${admin}`);
    return processRequest(client, {
      source: "event",
      groupId: notification?.chatId,
      requester: notification?.author,
      notificationId: notification?.id,
      requestTimestamp: notification?.timestamp ?? notification?.t
    });
  }

  async function poll(client) {
    pollLog("started=true");
    let groupsChecked = 0;
    let requestsFound = 0;
    let processed = 0;
    let errors = 0;
    const runtime = runtimes.get(client);
    if (!runtime?.ready || runtime.polling) {
      pollLog("groupsChecked=0");
      summaryLog("groups=0 requests=0 processed=0 errors=0");
      return { status: "skipped" };
    }
    runtime.polling = true;
    try {
      await markExpiredRequests();
      const groups = await groupDirectory.listActiveGroups("whatsapp");
      groupsChecked = groups.length;
      pollLog(`groupsChecked=${groupsChecked}`);
      const detected = [];
      for (const group of groups) {
        const incompatibility = temporaryIncompatibilities.get(group?.groupId);
        if (incompatibility && incompatibility.nextRetryAt > clock().getTime()) {
          pollLog("groupSkipped=true");
          pollLog("skipReason=temporary_incompatibility");
          continue;
        }
        const methodAvailable =
          typeof client?.getGroupMembershipRequests === "function";
        try {
          if (!methodAvailable) {
            const error = new Error("membership_request_method_unavailable");
            error.code = "membership_request_method_unavailable";
            throw error;
          }
          const requests = await client.getGroupMembershipRequests(group.groupId);
          temporaryIncompatibilities.delete(group.groupId);
          const count = Array.isArray(requests) ? requests.length : 0;
          requestsFound += count;
          pollLog(`requestsFound=${count}`);
          pollLog(`requestProcessed=${count > 0}`);
          if (count > 0) pollLog(`beforeDedup=${count}`);
          const officialIds = (requests || []).map(item => serializeOfficialId(item.id));
          let processedForGroup = 0;
          for (const request of requests || []) {
            const result = await processRequest(client, {
              source: "poll",
              groupId: group.groupId,
              requester: request.id,
              notificationId: request.id,
              requestTimestamp: request.t ?? request.timestamp
            });
            detected.push(result);
            if (result?.status !== "duplicate") {
              processedForGroup += 1;
              pollLog("discardReason=none");
            } else {
              pollLog(`discardReason=${result?.discardReason || "duplicateRequest"}`);
            }
          }
          processed += processedForGroup;
          if (count > 0) pollLog(`afterDedup=${processedForGroup}`);
          const stored = await repository.listRequests([
            "pending_registration",
            "registration_completed",
            "registration_cancelled",
            "registration_expired",
            "approval_failed"
          ]);
          for (const request of stored.filter(item => item.groupIdentity === group.groupId)) {
            if (!officialIds.some(id =>
              identityService.identitiesMatch(id, request.requesterId)
            )) {
              await repository.updateRequest(request.id, {
                status: "unavailable",
                errorCode: "request_not_pending"
              });
            }
          }
        } catch (error) {
          errors += 1;
          if (isTemporaryIncompatibilityError(error)) {
            recordTemporaryIncompatibility(group?.groupId);
          }
          pollLog("pollError=true");
          pollLog(`errorCode=${sanitizedErrorCode(error)}`);
          // Um grupo sem suporte ou permissão não interrompe os demais.
        }
      }
      return { status: "completed", detected };
    } catch (error) {
      errors += 1;
      pollLog("pollError=true");
      pollLog(`errorCode=${sanitizedErrorCode(error)}`);
      return { status: "error", errorCode: sanitizedErrorCode(error) };
    } finally {
      runtime.polling = false;
      summaryLog(
        `groups=${groupsChecked} requests=${requestsFound} ` +
        `processed=${processed} errors=${errors}`
      );
    }
  }

  function start(client) {
    let runtime = runtimes.get(client);
    if (!runtime) {
      runtime = {
        ready: true,
        polling: false,
        interval: null,
        pollIntervalMilliseconds: null
      };
      runtimes.set(client, runtime);
    }
    runtime.ready = true;
    if (!runtime.interval) {
      runtime.pollIntervalMilliseconds = resolvePollIntervalMilliseconds();
      runtime.interval = setInterval(() => {
        poll(client).catch(() => undefined);
      }, runtime.pollIntervalMilliseconds);
      runtime.interval.unref?.();
    }
    console.log("[JOIN_REQUEST_BOOT] pollingStarted=true");
    console.log(
      `[JOIN_REQUEST_BOOT] pollInterval=${runtime.pollIntervalMilliseconds}`
    );
    debugLog("listenerAttached=true");
    runtime.initialPoll = poll(client).catch(() => undefined);
    return runtime;
  }

  function stop(client) {
    const runtime = runtimes.get(client);
    if (!runtime) return false;
    runtime.ready = false;
    if (runtime.interval) clearInterval(runtime.interval);
    runtime.interval = null;
    return true;
  }

  async function handleRegistrationCompleted(context) {
    const candidates = identityService.collectCanonicalIdentityCandidates(
      context?.userId,
      ...(context?.identity?.candidates || [])
    );
    const requests = await repository.findPendingByIdentity(
      candidates,
      identityService.identitiesMatch
    );
    const results = [];
    for (const request of requests.filter(item =>
      ["pending_registration", "registration_expired", "registration_cancelled"].includes(item.status)
    )) {
      const audit = {
        source: "registration",
        requestDetected: true,
        registrationFound: true,
        privateMessageSucceeded: false,
        registrationFlowStarted: false,
        registrationCompleted: true,
        approvalAttempted: false,
        approvalSucceeded: false,
        approvalMethodAvailable: false,
        requestWasPending: false,
        requestStillPending: false,
        errorCode: "none"
      };
      await repository.updateRequest(request.id, {
        status: "registration_completed",
        registrationCompletedAt: clock().toISOString(),
        errorCode: null
      });
      try {
        const approved = await approve(context.client, request, audit);
        await context.client.sendMessage(request.requesterId, APPROVED_MESSAGE).catch(() => undefined);
        audit.privateMessageSucceeded = true;
        results.push({ status: "approved", request: approved });
      } catch (error) {
        await updatePendingStateAfterFailure(context.client, request, audit);
        audit.errorCode = error.code || "approval_failed";
        if (audit.errorCode !== "request_not_pending") {
          await repository.updateRequest(request.id, {
            status: "approval_failed",
            errorCode: audit.errorCode
          });
          await context.client.sendMessage(request.requesterId,
            audit.errorCode === "disciplinary_review_required"
              ? DISCIPLINE_REVIEW_MESSAGE : APPROVAL_FAILED_MESSAGE
          ).catch(() => undefined);
        }
        results.push({ status: "approval_failed", reason: audit.errorCode });
      } finally {
        logResult(audit);
        if (audit.approvalAttempted) {
          approvalLog(`requestWasPending=${audit.requestWasPending}`);
          approvalLog("approvalAttempted=true");
          approvalLog(`approvalSucceeded=${audit.approvalSucceeded}`);
          approvalLog(`approvalMethodAvailable=${audit.approvalMethodAvailable}`);
          approvalLog(`requestStillPending=${audit.requestStillPending}`);
        }
      }
    }
    return results;
  }

  async function handleRegistrationCancelled(context) {
    const candidates = identityService.collectCanonicalIdentityCandidates(
      context?.userId,
      ...(context?.identity?.candidates || [])
    );
    const requests = await repository.findPendingByIdentity(
      candidates,
      identityService.identitiesMatch
    );
    return Promise.all(requests
      .filter(item => ["pending_registration", "revalidation_required", "revalidation_editing"].includes(item.status))
      .map(item => repository.updateRequest(item.id, {
        status: "registration_cancelled",
        errorCode: "registration_cancelled"
      })));
  }

  async function markExpiredRequests() {
    const now = clock().getTime();
    const requests = await repository.listRequests(["pending_registration"]);
    return Promise.all(requests
      .filter(item => item.flowExpiresAt && Date.parse(item.flowExpiresAt) <= now)
      .map(item => repository.updateRequest(item.id, {
        status: "registration_expired",
        errorCode: "registration_expired"
      })));
  }

  return {
    start,
    stop,
    poll,
    processRequest,
    handleEvent,
    handleRegistrationCompleted,
    handleRegistrationCancelled,
    markExpiredRequests,
    botAdminState,
    pendingStillExists
    , requiredRevalidation, completeReturnRevalidation, markRevalidationEditing
  };
}

const service = createJoinRequestService();
module.exports = {
  ...service,
  createJoinRequestService,
  POLL_INTERVAL_MS,
  UNREGISTERED_MESSAGE,
  REGISTERED_MESSAGE,
  APPROVED_MESSAGE,
  APPROVAL_FAILED_MESSAGE,
  DISCIPLINE_REVIEW_MESSAGE
  , REVALIDATION_MESSAGE
};
