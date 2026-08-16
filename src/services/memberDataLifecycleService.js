"use strict";

const lifecycleDefault = require("../repositories/memberLifecycleRepository");
const registrationsDefault = require("../repositories/registrationRepository");
const quizDefault = require("../repositories/quizRepository");
const marathonDefault = require("./quizMarathonService");
const raidsDefault = require("../repositories/raidRepository");
const eventsDefault = require("../repositories/eventRepository");
const flowsDefault = require("./guidedFlowService");
const joinsDefault = require("../repositories/joinRequestRepository");
const feedbackDefault = require("../repositories/feedbackRepository");
const progressDefault = require("../repositories/playerProgressRepository");
const identityDefault = require("./identityService");
const memberExperienceDefault = require("../repositories/memberExperienceRepository");

function createMemberDataLifecycleService(options = {}) {
  const lifecycle = options.lifecycleRepository || lifecycleDefault;
  const registrations = options.registrationRepository || registrationsDefault;
  const quiz = options.quizRepository || quizDefault;
  const marathon = options.quizMarathonService || marathonDefault;
  const raids = options.raidRepository || raidsDefault;
  const events = options.eventRepository || eventsDefault;
  const flows = options.guidedFlowService || flowsDefault;
  const joins = options.joinRequestRepository || joinsDefault;
  const feedback = options.feedbackRepository || feedbackDefault;
  const progress = options.playerProgressRepository || progressDefault;
  const identity = options.identityService || identityDefault;
  const memberExperience = options.memberExperienceRepository || memberExperienceDefault;
  const clock = options.clock || (() => new Date());

  const normalize = value => identity.normalizeUserId(value);
  const activeGroups = member => Object.entries(member?.platforms?.whatsapp?.groups || {}).filter(([, active]) => active).map(([id]) => id);

  async function registrationFor(memberId) {
    const candidates = identity.collectCanonicalIdentityCandidates(memberId);
    for (const candidate of candidates) {
      const found = await registrations.findByIdentity(candidate);
      if (found) return found;
    }
    return null;
  }

  async function pendingJoin(memberId) {
    const candidates = identity.collectCanonicalIdentityCandidates(memberId);
    const values = await joins.findPendingByIdentity(candidates, identity.identitiesMatch);
    return values.some(item => ["pending_registration", "registration_completed", "approval_failed"].includes(item.status));
  }

  async function criticalRaid(memberId) {
    const values = typeof raids.listActiveRaids === "function" ? raids.listActiveRaids() : [];
    return values.some(item => item.creatorId === memberId || item.participants?.includes(memberId));
  }

  async function criticalEvent(memberId) {
    const values = await events.listEvents({ includeArchived: true });
    return values.some(item => item.creatorId === memberId && ["scheduled", "published", "running"].includes(item.status));
  }

  async function inspectBlockers(rawMemberId) {
    const memberId = normalize(rawMemberId);
    const member = memberId ? await lifecycle.getMember(memberId) : null;
    const registration = memberId ? await registrationFor(memberId) : null;
    const groups = activeGroups(member);
    const telegramActive = Boolean(member?.platforms?.telegram?.active || registration?.contacts?.telegram?.enabled);
    const blockers = [];
    if (groups.length) blockers.push("other_group_active");
    if (telegramActive) blockers.push("telegram_active");
    if (memberId && await pendingJoin(memberId)) blockers.push("join_request_pending");
    if (memberId && await flows.hasActiveFlowForUser(memberId)) blockers.push("guided_flow_active");
    if (memberId && await criticalRaid(memberId)) blockers.push("raid_active");
    if (memberId && await criticalEvent(memberId)) blockers.push("event_active");
    return { memberId, member, registration, groups, telegramActive, blockers };
  }

  async function resetQuiz(rawMemberId, metadata = {}) {
    const memberId = normalize(rawMemberId);
    if (!memberId) return { status: "not_found", itemsRemoved: 0 };
    const results = await Promise.all([quiz.resetUserData("whatsapp", memberId), marathon.resetUserData(memberId), progress.resetPlayerData("whatsapp", memberId)]);
    const itemsRemoved = results.reduce((sum, item) => sum + Number(item?.itemsRemoved || 0), 0);
    await lifecycle.addAudit({ executor: metadata.executor || "system", target: memberId, type: "reset_quiz", reason: metadata.reason || null, result: "completed", itemsRemoved, itemsPreserved: ["registration", "discipline", "bans", "administrative_audit"] });
    return { status: itemsRemoved ? "removed" : "already_removed", itemsRemoved };
  }

  async function removeRegistration(rawMemberId, metadata = {}) {
    const memberId = normalize(rawMemberId);
    const registration = memberId ? await registrationFor(memberId) : null;
    if (!registration) return { status: "not_found", itemsRemoved: 0 };
    const removed = await registrations.removeRegistrationByIdentity(registration.primaryIdentity);
    const sessions = await flows.removeUserFlows(memberId);
    const experience = await memberExperience.clearRegistrationState(memberId);
    const itemsRemoved = Number(removed.removed) + Number(sessions.itemsRemoved || 0) + Number(experience.itemsRemoved || 0);
    await lifecycle.addAudit({ executor: metadata.executor || "system", target: memberId, type: "remove_registration", reason: metadata.reason || null, result: "completed", itemsRemoved, itemsPreserved: ["quiz", "discipline", "bans", "administrative_audit"] });
    return { status: "removed", itemsRemoved };
  }

  async function removeMember(rawMemberId, metadata = {}) {
    const memberId = normalize(rawMemberId);
    if (!memberId) return { status: "not_found", itemsRemoved: 0 };
    const lifecycleMember = await lifecycle.getMember(memberId);
    if (lifecycleMember?.removalCompletedAt) return { status: "already_removed", itemsRemoved: 0 };
    const registration = await registrationFor(memberId);
    const results = [];
    if (registration) results.push(await registrations.removeRegistrationByIdentity(registration.primaryIdentity));
    results.push(await quiz.resetUserData("whatsapp", memberId));
    results.push(await marathon.resetUserData(memberId));
    results.push(await progress.resetPlayerData("whatsapp", memberId));
    results.push(await flows.removeUserFlows(memberId));
    results.push(await Promise.resolve(raids.removeParticipantFromOperationalRaids(memberId)));
    results.push(await events.removePendingEventsByUser(memberId, { authorId: metadata.executor || "system" }));
    results.push(await feedback.anonymizeAuthor(memberId));
    results.push(await memberExperience.removeMemberData(memberId));
    const itemsRemoved = results.reduce((sum, item) => sum + Number(item?.itemsRemoved ?? item?.removed ?? 0), 0);
    await lifecycle.updateMember(memberId, member => {
      member.pendingRemovalAt = null;
      member.removalCompletedAt = clock().toISOString();
      member.preservedUntil = null;
      member.lastRemovalType = metadata.type || "full";
    });
    await lifecycle.addAudit({ executor: metadata.executor || "system", target: memberId, type: metadata.type || "remove_member", reason: metadata.reason || null, result: "completed", itemsRemoved, itemsPreserved: ["discipline", "bans", "administrative_audit", "feedback_protocols_anonymized"] });
    return { status: "removed", itemsRemoved };
  }

  async function preserveMember(rawMemberId, metadata = {}) {
    const memberId = normalize(rawMemberId);
    if (!memberId || !await lifecycle.getMember(memberId)) return { status: "not_found" };
    await lifecycle.updateMember(memberId, member => { member.pendingRemovalAt = null; member.preservedAt = clock().toISOString(); member.preservationReason = metadata.reason || "manual"; });
    await lifecycle.addAudit({ executor: metadata.executor || "system", target: memberId, type: "preserve_member", reason: metadata.reason || "manual", result: "completed", itemsRemoved: 0, itemsPreserved: ["all"] });
    return { status: "preserved" };
  }

  async function getStatus(rawMemberId) {
    const inspected = await inspectBlockers(rawMemberId);
    if (!inspected.memberId || (!inspected.member && !inspected.registration)) return { status: "not_found" };
    const pending = inspected.member?.pendingRemovalAt;
    const remainingMs = pending ? Math.max(0, Date.parse(pending) - clock().getTime()) : null;
    return { status: "found", active: inspected.groups.length > 0 || inspected.telegramActive, activeGroups: inspected.groups.length, telegramActive: inspected.telegramActive, lastLeaveAt: inspected.member?.lastLeaveAt || null, pendingRemovalAt: pending || null, daysRemaining: remainingMs === null ? null : Math.ceil(remainingMs / 86400000), preservationReason: inspected.blockers[0] || inspected.member?.preservationReason || null, blockers: inspected.blockers };
  }

  return { inspectBlockers, removeMember, removeRegistration, resetQuiz, preserveMember, getStatus };
}

const service = createMemberDataLifecycleService();
module.exports = { ...service, createMemberDataLifecycleService };
