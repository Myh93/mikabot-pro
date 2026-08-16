"use strict";

const identityDefault = require("./identityService");
const groupChatResolverDefault = require("./groupChatResolverService");
const { getQuotedMessageSafe } = require("./whatsappClientHealthService");

function createGroupMemberResolverService(options = {}) {
  const identities = options.identityService || identityDefault;
  const groupChats = options.groupChatResolverService ||
    groupChatResolverDefault.createGroupChatResolverService();

  const unique = values => [...new Set(values.filter(Boolean))];
  const collect = (...values) => identities.collectCanonicalIdentityCandidates(...values);
  const participantIdentities = participant =>
    identities.collectParticipantIdentities(participant);
  const participantMatches = (participant, candidates) => {
    const targetSet = new Set(collect(...candidates));
    return participantIdentities(participant).some(value => targetSet.has(value));
  };
  const log = value => console.log(`[MEMBER] ${value}`);
  async function mentionedCandidates(message, explicitMention) {
    const direct = [
      explicitMention,
      ...(Array.isArray(message?.mentionedIds) ? message.mentionedIds : []),
      ...(Array.isArray(message?._data?.mentionedJidList) ? message._data.mentionedJidList : [])
    ];
    const contacts = [];
    if (direct.some(Boolean) && typeof message?.getMentions === "function") {
      try {
        const resolved = await message.getMentions();
        if (Array.isArray(resolved)) contacts.push(...resolved);
      } catch (_) {
        // Os IDs diretos continuam válidos quando a consulta de Contacts falha.
      }
    }
    return unique(collect(...direct, ...contacts));
  }

  async function quotedTarget(message, suppliedQuotedMessage) {
    let quoted = suppliedQuotedMessage || null;
    log(`quotedResolved=${Boolean(quoted)}`);
    if (!quoted && (message?.hasQuotedMsg || message?._data?.quotedMsg)) {
      const result = await getQuotedMessageSafe(message);
      if (!result.ok) {
        log("quotedResolved=false");
        return { ok: false, errorCode: "quoted_message_unavailable" };
      }
      quoted = result.quotedMessage;
      log("quotedResolved=true");
    }
    if (!quoted) return { ok: false, errorCode: "target_missing" };
    let contact = null;
    if (typeof quoted.getContact === "function") {
      try { contact = await quoted.getContact(); } catch (_) { contact = null; }
    }
    const candidates = identities.collectMessageAuthorIdentities(quoted, contact);
    log(`targetCandidates=${candidates.length}`);
    log(`targetHasAuthor=${Boolean(quoted?.author || quoted?._data?.author || quoted?._data?.participant || quoted?.id?.participant)}`);
    log(`targetHasContact=${Boolean(contact)}`);
    log(`targetHasLid=${candidates.some(value => String(value).endsWith("@lid"))}`);
    return candidates.length
      ? { ok: true, quoted, contact, candidates }
      : { ok: false, errorCode: "target_identity_unresolved" };
  }

  async function resolveGroupMember({
    message,
    chat,
    client,
    mentionedId,
    quotedMessage
  } = {}) {
    let candidates = await mentionedCandidates(message, mentionedId);
    let source = candidates.length ? "mention" : null;
    let contact = null;

    if (!candidates.length) {
      const quoted = await quotedTarget(message, quotedMessage);
      if (!quoted.ok) {
        return { ok: false, participant: null, canonicalUserId: null, displayName: null, isAdmin: false, isOwner: false, source: null, errorCode: quoted.errorCode };
      }
      candidates = quoted.candidates;
      contact = quoted.contact;
      source = "reply";
    }

    if (!candidates.length) {
      return { ok: false, participant: null, canonicalUserId: null, displayName: null, isAdmin: false, isOwner: false, source, errorCode: "target_identity_unresolved" };
    }

    const resolvedChat = await groupChats.resolveGroupChatWithParticipants({
      message,
      chat,
      client
    });
    const participants = Array.isArray(resolvedChat.participants) ? resolvedChat.participants : [];
    const collectedParticipantCandidates = new Set(
      participants.flatMap(participant => participantIdentities(participant))
    );
    log(`participantCount=${participants.length}`);
    log(`participantCandidates=${collectedParticipantCandidates.size}`);
    log(`source=${resolvedChat.source || "none"}`);
    if (!Array.isArray(resolvedChat.participants) || !resolvedChat.participants.length) {
      log("matched=false");
      return { ok: false, participant: null, canonicalUserId: null, displayName: null, isAdmin: false, isOwner: false, source, errorCode: "participants_unavailable" };
    }

    const participant = resolvedChat.participants.find(item => participantMatches(item, candidates));
    log(`matched=${Boolean(participant)}`);
    if (!participant) {
      return { ok: false, participant: null, canonicalUserId: null, displayName: null, isAdmin: false, isOwner: false, source, errorCode: "target_not_in_group" };
    }

    const participantCandidates = unique([
      ...participantIdentities(participant),
      ...candidates
    ]);
    const canonicalUserId =
      candidates.find(value => String(value).endsWith("@lid")) ||
      participantCandidates.find(value => String(value).endsWith("@lid")) ||
      candidates[0] ||
      participantCandidates[0] ||
      null;
    if (!canonicalUserId) {
      return { ok: false, participant: null, canonicalUserId: null, displayName: null, isAdmin: false, isOwner: false, source, errorCode: "target_identity_unresolved" };
    }
    const displayName = await identities.resolveDisplayName(canonicalUserId, {
      contact,
      displayName: participant?.name || participant?.pushname || participant?.shortName
    });
    return {
      ok: true,
      participant,
      canonicalUserId,
      displayName,
      isAdmin: Boolean(participant.isAdmin || participant.isSuperAdmin),
      isOwner: Boolean(participant.isSuperAdmin),
      source,
      errorCode: "target_resolved"
    };
  }

  return { resolveGroupMember, participantMatches };
}

const service = createGroupMemberResolverService();
module.exports = { ...service, createGroupMemberResolverService };
