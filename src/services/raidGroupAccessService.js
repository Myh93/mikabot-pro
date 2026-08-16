"use strict";

const groupDirectoryDefault = require("./groupDirectoryService");
const identityDefault = require("./identityService");
const permissionDefault = require("./permissionService");
const groupChatResolverDefault = require("./groupChatResolverService");
const groupMemberResolverDefault = require("./groupMemberResolverService");
const registrationDefault = require("./registrationService");

function createRaidGroupAccessService(options = {}) {
  const directory = options.groupDirectoryService || groupDirectoryDefault;
  const identities = options.identityService || identityDefault;
  const permissions = options.permissionService || permissionDefault;
  const groupChatResolver = options.groupChatResolverService || groupChatResolverDefault;
  const groupMemberResolver = options.groupMemberResolverService || groupMemberResolverDefault;
  const registrations = options.registrationService || registrationDefault;
  const log = options.log || (value => console.log(`[RAID_GROUP] ${value}`));
  const memberLog = options.memberLog || (value => console.log(`[RAID_MEMBER] ${value}`));
  const aliasLog = options.aliasLog || (value => console.log(`[RAID_ALIAS] ${value}`));
  const maxGroups = Number.isInteger(options.maxGroups) && options.maxGroups > 0 ? options.maxGroups : 10;

  async function resolveActorIdentity(client, identity) {
    const candidates = identities.collectCanonicalIdentityCandidates(identity);
    let registration = null;
    try { registration = await registrations.getRegistrationByIdentity(identity); } catch (_) { registration = null; }
    const storedAliases = Array.isArray(registration?.identityAliases)
      ? registration.identityAliases
      : [];
    const validStoredAliases = storedAliases.filter(alias =>
      identities.collectCanonicalIdentityCandidates(alias).length > 0
    );
    aliasLog(`registrationFound=${Boolean(registration)}`);
    aliasLog(`primaryIdentityPresent=${Boolean(registration?.primaryIdentity)}`);
    aliasLog(`storedAliasCount=${storedAliases.length}`);
    aliasLog(`validAliasCount=${validStoredAliases.length}`);
    const confirmedContacts = [];
    if (typeof client?.getContactById === "function") {
      const contactIds = [...new Set([
        registration?.primaryIdentity,
        ...validStoredAliases
      ].filter(value => typeof value === "string" && value.includes("@")))];
      for (const contactId of contactIds) {
        try {
          const contact = await client.getContactById(contactId);
          if (contact) confirmedContacts.push(contact);
        } catch (_) {
          // Consulta de contato indisponível mantém a falha segura.
        }
      }
    }
    const confirmedCandidates = identities.collectCanonicalIdentityCandidates(
      identity,
      registration?.primaryIdentity,
      ...validStoredAliases,
      ...confirmedContacts
    );
    aliasLog(`finalCandidateCount=${confirmedCandidates.length}`);
    if (!candidates.length && !confirmedCandidates.length) return null;
    return {
      id: confirmedCandidates[0] || candidates[0],
      candidates: confirmedCandidates.length ? confirmedCandidates : candidates
    };
  }

  async function validateGroup(client, group, identity) {
    const actorIdentity = await resolveActorIdentity(client, identity);
    memberLog(`actorResolved=${Boolean(actorIdentity)}`);
    memberLog(`targetCandidates=${actorIdentity?.candidates?.length || 0}`);
    if (!actorIdentity) return { ok: false, code: "identity_not_resolved" };
    let resolved;
    try {
      if (typeof groupChatResolver.clearCache === "function") groupChatResolver.clearCache();
      resolved = await groupChatResolver.resolveGroupChatWithParticipants({
        client,
        message: { from: group.groupId }
      });
    } catch (_) {
      return { ok: false, code: "group_unavailable" };
    }
    const chat = resolved?.chat;
    if (!chat?.isGroup || !Array.isArray(resolved?.participants)) return { ok: false, code: resolved?.errorCode || "group_unavailable" };
    if (chat.isReadOnly === true) return { ok: false, code: "bot_not_member" };
    const participantCandidates = new Set(
      resolved.participants.flatMap(participant => identities.collectParticipantIdentities(participant))
    );
    memberLog(`participantCount=${resolved.participants.length}`);
    memberLog(`participantCandidates=${participantCandidates.size}`);
    const member = await groupMemberResolver.resolveGroupMember({
      client,
      chat,
      message: { from: group.groupId },
      mentionedId: actorIdentity
    });
    memberLog(`matched=${Boolean(member.ok && member.participant)}`);
    memberLog("resultFieldUsed=ok");
    memberLog(`source=${resolved.source || "none"}`);
    if (!member.ok) {
      return {
        ok: false,
        code: member.errorCode === "target_identity_unresolved"
          ? "identity_not_resolved"
          : "user_not_member"
      };
    }
    const participant = member.participant;
    const role = await permissions.resolveRole({ client, chat, identity, participant });
    if (!permissions.hasPermission(role, {})) return { ok: false, code: "permission_denied" };
    return { ok: true, chat, role };
  }

  function distinguishDuplicateNames(groups) {
    const counts = new Map();
    groups.forEach(group => counts.set(group.name, (counts.get(group.name) || 0) + 1));
    const positions = new Map();
    return groups.map(group => {
      if (counts.get(group.name) === 1) return group;
      const position = (positions.get(group.name) || 0) + 1;
      positions.set(group.name, position);
      return { ...group, name: `${group.name} • grupo ${position}` };
    });
  }

  async function listAuthorizedGroups(client, identity) {
    const active = await directory.listActiveGroups("whatsapp");
    log(`groupsFound=${active.length}`);
    const available = [];
    let groupsAfterMembership = 0;
    let groupsAfterPermission = 0;
    for (const group of active) {
      const access = await validateGroup(client, group, identity);
      if (!access.ok) {
        if (access.code === "permission_denied") groupsAfterMembership += 1;
        log(`discardReason=${access.code === "permission_denied" ? "permission_denforced" : access.code}`);
        continue;
      }
      groupsAfterMembership += 1;
      groupsAfterPermission += 1;
      available.push({
        id: group.groupId,
        name: directory.formatGroupDisplayName(group),
        aliases: Array.isArray(group.aliases) ? group.aliases.filter(Boolean) : []
      });
    }
    const result = distinguishDuplicateNames(available).slice(0, maxGroups);
    log(`groupsAfterMembership=${groupsAfterMembership}`);
    log(`groupsAfterPermission=${groupsAfterPermission}`);
    log(`groupsAvailable=${result.length}`);
    return result;
  }

  async function revalidate(client, groupId, identity) {
    const group = await directory.getGroupById(groupId, "whatsapp");
    if (!group?.active) return { ok: false, code: "group_inactive" };
    return validateGroup(client, group, identity);
  }

  return { listAuthorizedGroups, revalidate, maxGroups };
}

const service = createRaidGroupAccessService();
module.exports = { ...service, createRaidGroupAccessService };
