"use strict";

const identityServiceDefault = require("./identityService");
const registrationServiceDefault = require("./registrationService");
const lifecycleRepositoryDefault = require("../repositories/memberLifecycleRepository");
const joinRequestRepositoryDefault = require("../repositories/joinRequestRepository");
const memberDataLifecycleDefault = require("./memberDataLifecycleService");

const CONTINUE_TELEGRAM_MESSAGE = [
  "👋 Você saiu do grupo Pokémon GO no WhatsApp.",
  "",
  "Deseja continuar participando da comunidade pelo Telegram?",
  "",
  "1️⃣ Sim",
  "2️⃣ Não"
].join("\n");

function createMemberLeaveService(options = {}) {
  const identityService = options.identityService || identityServiceDefault;
  const registrations = options.registrationService || registrationServiceDefault;
  const repository = options.repository || lifecycleRepositoryDefault;
  const joinRequests = options.joinRequestRepository || joinRequestRepositoryDefault;
  const memberDataLifecycle = options.memberDataLifecycleService || (options.removeMemberData ? { inspectBlockers: async () => ({ blockers: [] }) } : memberDataLifecycleDefault);
  const removeMemberData = options.removeMemberData || (async memberId => (await memberDataLifecycle.removeMember(memberId, { executor: "system", type: "automatic_removal", reason: "seven_days_outside_community" })).status === "removed");
  const sendTelegramPrivate = options.sendTelegramPrivate || null;
  const clock = options.clock || (() => new Date());
  const log = options.log || (value => console.log(`[MEMBER_LEAVE] ${value}`));

  const serialize = value => {
    if (typeof value === "string") return value;
    return value?._serialized || value?.id?._serialized || "";
  };

  async function hasPendingJoin(memberId) {
    const candidates = identityService.collectCanonicalIdentityCandidates(memberId);
    const pending = await joinRequests.findPendingByIdentity(candidates, identityService.identitiesMatch);
    return pending.some(item => [
      "pending_registration",
      "registration_completed",
      "approval_failed"
    ].includes(item.status));
  }

  async function markPlatformActive(memberId, platform, groupId) {
    const normalized = identityService.normalizeUserId(memberId);
    if (!normalized || !groupId) return null;
    return repository.updateMember(normalized, member => {
      member.platforms[platform] ||= { active: false, groups: {} };
      member.platforms[platform].groups[groupId] = true;
      member.pendingRemovalAt = null;
    });
  }

  async function evaluateRemoval(memberId, member = null) {
    const current = member || await repository.getMember(memberId);
    const policy = { mode: "delayed", graceDays: 7 };
    const anotherPlatform = Boolean(current?.platforms?.whatsapp?.active || current?.platforms?.telegram?.active);
    if (anotherPlatform) return { action: "kept", reason: "another_platform_active", policy: policy.mode };
    if (await hasPendingJoin(memberId)) return { action: "kept", reason: "join_request_pending", policy: policy.mode };
    const blockers = memberDataLifecycle.inspectBlockers ? (await memberDataLifecycle.inspectBlockers(memberId)).blockers : [];
    if (blockers.length) return { action: "kept", reason: blockers[0], policy: policy.mode };
    const pendingRemovalAt = new Date(clock().getTime() + policy.graceDays * 86400000).toISOString();
    await repository.updateMember(memberId, item => { item.pendingRemovalAt = pendingRemovalAt; item.preservationReason = null; });
    return { action: "scheduled", reason: "grace_period", policy: policy.mode, pendingRemovalAt };
  }

  async function handleMemberLeave(input) {
    const memberId = identityService.normalizeUserId(input.memberId);
    const groupId = String(input.groupId || "");
    const platform = input.platform || "whatsapp";
    if (!memberId || !groupId) return { status: "ignored", reason: "invalid_notification" };
    const registration = await registrations.getRegistrationByIdentity({
      id: memberId,
      candidates: identityService.collectCanonicalIdentityCandidates(input.memberId)
    });
    const member = await repository.updateMember(memberId, item => {
      item.platforms[platform] ||= { active: false, groups: {} };
      item.platforms[platform].groups[groupId] = false;
      item.lastLeaveAt = input.timestamp || clock().toISOString();
      item.lastLeaveReason = input.reason;
    });
    let decision;
    if (member.platforms.telegram.active) {
      let notified = false;
      if (sendTelegramPrivate && registration?.contacts?.telegram?.enabled) {
        notified = Boolean(await sendTelegramPrivate(registration, CONTINUE_TELEGRAM_MESSAGE).catch(() => false));
      }
      decision = { action: "awaiting_confirmation", reason: notified ? "telegram_active" : "telegram_notification_unavailable", policy: (await repository.getPolicy()).mode };
    } else {
      decision = await evaluateRemoval(memberId, member);
    }
    log("memberLeft=true");
    log(`platform=${platform}`);
    log(`timestamp=${input.timestamp || clock().toISOString()}`);
    log(`policy=${decision.policy}`);
    log(`action=${decision.action}`);
    log(`reason=${decision.reason}`);
    return { status: registration ? "processed" : "unregistered", member, ...decision };
  }

  async function handleNotification(notification) {
    const reason = notification?.type === "remove" ? "admin_removed" : "voluntary_leave";
    const results = [];
    for (const recipient of notification?.recipientIds || []) {
      results.push(await handleMemberLeave({
        platform: "whatsapp",
        groupId: notification.chatId,
        memberId: serialize(recipient),
        timestamp: notification.timestamp ? new Date(notification.timestamp * 1000).toISOString() : clock().toISOString(),
        reason
      }));
    }
    return results;
  }

  async function handleJoinNotification(notification) {
    return Promise.all((notification?.recipientIds || []).map(recipient =>
      markPlatformActive(serialize(recipient), "whatsapp", notification.chatId)
    ));
  }

  async function handleContinuationResponse({ memberId, keepCommunity }) {
    if (keepCommunity) return { status: "kept" };
    const member = await repository.updateMember(identityService.normalizeUserId(memberId), item => {
      item.platforms.telegram.groups = {};
    });
    return evaluateRemoval(identityService.normalizeUserId(memberId), member);
  }

  async function evaluateDueRemovals() {
    const now = clock().getTime();
    const results = [];
    for (const member of await repository.listMembers()) {
      if (!member.pendingRemovalAt || Date.parse(member.pendingRemovalAt) > now) continue;
      const blockers = memberDataLifecycle.inspectBlockers ? (await memberDataLifecycle.inspectBlockers(member.memberId)).blockers : [];
      if (blockers.length) {
        await repository.updateMember(member.memberId, item => { item.pendingRemovalAt = new Date(now + 7 * 86400000).toISOString(); item.preservationReason = blockers[0]; });
        results.push({ removed: false, reason: blockers[0] });
        continue;
      }
      const removed = await removeMemberData(member.memberId);
      if (removed) await repository.updateMember(member.memberId, item => { item.pendingRemovalAt = null; item.removalCompletedAt ||= clock().toISOString(); });
      results.push({ removed: Boolean(removed) });
    }
    return results;
  }

  return { handleNotification, handleJoinNotification, handleMemberLeave, handleContinuationResponse, markPlatformActive, evaluateRemoval, evaluateDueRemovals, CONTINUE_TELEGRAM_MESSAGE };
}

const service = createMemberLeaveService();
module.exports = { ...service, createMemberLeaveService, CONTINUE_TELEGRAM_MESSAGE };
