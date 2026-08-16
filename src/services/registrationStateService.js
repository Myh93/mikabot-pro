"use strict";

const registrationServiceDefault = require("./registrationService");
const guidedFlowServiceDefault = require("./guidedFlowService");
const joinRequestRepositoryDefault = require("../repositories/joinRequestRepository");
const memberLifecycleRepositoryDefault = require("../repositories/memberLifecycleRepository");
const disciplineServiceDefault = require("./disciplineService");
const identityServiceDefault = require("./identityService");

const STATES = Object.freeze({
  NONE: "none",
  DRAFT: "draft",
  ACTIVE: "active",
  REQUIRES_REVALIDATION: "requires_revalidation",
  BANNED: "banned",
  INACTIVE_GROUP_MEMBERSHIP: "inactive_group_membership"
});

function createRegistrationStateService(options = {}) {
  const registrations = options.registrationService || registrationServiceDefault;
  const flows = options.guidedFlowService || guidedFlowServiceDefault;
  const joinRequests = options.joinRequestRepository || joinRequestRepositoryDefault;
  const lifecycle = options.memberLifecycleRepository || memberLifecycleRepositoryDefault;
  const discipline = options.disciplineService || disciplineServiceDefault;
  const identities = options.identityService || identityServiceDefault;

  function candidates(context = {}) {
    return identities.collectCanonicalIdentityCandidates(
      context.userId,
      ...(context.identity?.candidates || []),
      ...(context.identityAliases || [])
    );
  }

  async function pendingRevalidation(identityCandidates) {
    const requests = await joinRequests.listRequests(["revalidation_required", "revalidation_editing"]);
    return requests.some(request => [request.userIdentity, ...(request.identityAliases || [])]
      .some(stored => identityCandidates.some(candidate => identities.identitiesMatch(stored, candidate))));
  }

  async function registrationDraft(context) {
    if (!context.platform || !context.conversationId || !context.userId) return null;
    const flow = await flows.getActiveFlow(context.platform, context.conversationId, context.userId);
    return flow?.flowId === "registration" ? flow : null;
  }

  async function resolveRegistrationState(context = {}, resolveOptions = {}) {
    const identityCandidates = candidates(context);
    if (!identityCandidates.length) return { state: STATES.NONE, registration: null };

    const registration = await registrations.getRegistrationByIdentity({ id: context.userId, candidates: identityCandidates });
    const blocked = await discipline.isBlocked({
      identity: { id: context.userId, candidates: identityCandidates },
      platform: context.platform || "whatsapp",
      groupId: context.groupId || null
    });
    if (blocked.blocked) return { state: STATES.BANNED, registration, reason: blocked.reason };
    if (!resolveOptions.ignoreJoinRequests && await pendingRevalidation(identityCandidates)) return { state: STATES.REQUIRES_REVALIDATION, registration };
    if (!registration) {
      const draft = await registrationDraft(context);
      return { state: draft ? STATES.DRAFT : STATES.NONE, registration: null, draft };
    }
    if ((registration.status && registration.status !== "active") || ["invalid_placeholder", "review_required"].includes(registration.validationStatus)) {
      return { state: STATES.REQUIRES_REVALIDATION, registration };
    }

    const member = resolveOptions.ignoreMembership ? null : await lifecycle.getMember(context.userId);
    if (member) {
      const active = Object.values(member.platforms || {}).some(platform => platform?.active);
      if (!active) return { state: STATES.INACTIVE_GROUP_MEMBERSHIP, registration };
    }
    return { state: STATES.ACTIVE, registration };
  }

  const hasCompletedRegistration = async context => (await resolveRegistrationState(context)).state === STATES.ACTIVE;
  return { resolveRegistrationState, hasCompletedRegistration, STATES };
}

const service = createRegistrationStateService();
module.exports = { ...service, createRegistrationStateService, STATES };
