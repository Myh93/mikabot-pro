"use strict";

const crypto = require("crypto");
const moderationDefault = require("./moderationService");
const identityDefault = require("./identityService");
const groupChatResolverDefault = require("./groupChatResolverService");
const groupMemberResolverDefault = require("./groupMemberResolverService");
const { ensureMessageIdSerialized } = require("./whatsappClientHealthService");
const memberExperienceDefault = require("./memberExperienceService");

const TRAILING = /[),.;!?\]}>'"]+$/;
const LINK_CANDIDATE = /(?:https?:\/\/|www\.)[^\s<>]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|io|gg|me|ly|gl|app|dev|link|site|online|live|tv|co|br|example)(?:\/[^\s<>]*)?/gi;

function createAntiLinkService(options = {}) {
  const moderation = options.moderationService || moderationDefault;
  const identities = options.identityService || identityDefault;
  const groupChatResolver = options.groupChatResolverService || groupChatResolverDefault.createGroupChatResolverService();
  const groupMembers = options.groupMemberResolverService || groupMemberResolverDefault;
  const memberExperience = options.memberExperienceService || memberExperienceDefault;
  const clean = value => String(value || "").trim();
  const diagnostic = (runtime, message) => { if (runtime?.diagnostic) console.log(`[ANTI] ${message}`); };

  function extractLinks(text) {
    const source = clean(text).replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, " ");
    const candidates = [...source.matchAll(LINK_CANDIDATE)].map(match => match[0].replace(TRAILING, ""));
    return [...new Set(candidates)].filter(value => { try { moderation.extractEffectiveDomain(value); return true; } catch (_) { return false; } });
  }
  function messageText(msg) { return clean(msg?.body || msg?.caption || msg?._data?.caption || msg?._data?.body); }
  const participantIdentity = participant => ({
    id: participant?.id,
    candidates: identities.collectParticipantIdentities
      ? identities.collectParticipantIdentities(participant)
      : identities.collectCanonicalIdentityCandidates
        ? identities.collectCanonicalIdentityCandidates(participant)
        : [participant?.id, participant?.lid].filter(Boolean)
  });
  const findParticipant = (chat, identity) => Array.isArray(chat?.participants)
    ? chat.participants.find(item => groupMembers.participantMatches(item, identity?.candidates || [identity]))
    : null;
  const candidateCount = identity => identities.collectCanonicalIdentityCandidates
    ? identities.collectCanonicalIdentityCandidates(identity).length
    : (identity?.candidates || []).length;
  const participantCandidateCount = chat => Array.isArray(chat?.participants)
    ? new Set(chat.participants.flatMap(item => participantIdentity(item).candidates || [])).size
    : 0;
  const participantDiagnostic = (runtime, authorIdentity, chat, matched, source) => diagnostic(
    runtime,
    `participante authorCandidates=${candidateCount(authorIdentity)} participantCandidates=${participantCandidateCount(chat)} matched=${Boolean(matched)} source=${source}`
  );
  const structureType = value => value === null || value === undefined ? "null" : typeof value === "object" ? "object" : typeof value === "string" ? "string" : "object";
  const structureDiagnostic = (runtime, msg, contact, chat) => {
    const participants = chat?.participants;
    const sample = Array.isArray(participants) ? participants[0] : null;
    diagnostic(runtime, `estrutura autor authorType=${structureType(msg?.author)}`);
    diagnostic(runtime, `estrutura autor hasMessageAuthor=${Boolean(msg?.author)} hasDataAuthor=${Boolean(msg?._data?.author)} hasDataParticipant=${Boolean(msg?._data?.participant)} hasIdParticipant=${Boolean(msg?.id?.participant)}`);
    diagnostic(runtime, `estrutura contato obtained=${Boolean(contact)} hasId=${Boolean(contact?.id)} hasLid=${Boolean(contact?.lid)}`);
    diagnostic(runtime, `estrutura chat participantsArray=${Array.isArray(participants)} participantsCount=${Array.isArray(participants) ? participants.length : 0}`);
    diagnostic(runtime, `estrutura participante sampleHasId=${Boolean(sample?.id)} sampleIdType=${structureType(sample?.id)} sampleHasLid=${Boolean(sample?.lid)}`);
  };
  async function resolveAuthorIdentity(msg) {
    let contact = null;
    if (typeof msg?.getContact === "function") {
      try { contact = await msg.getContact(); } catch (_) { contact = null; }
    }
    const candidates = identities.collectMessageAuthorIdentities
      ? identities.collectMessageAuthorIdentities(msg, contact)
      : identities.collectCanonicalIdentityCandidates(msg?.author, msg?._data?.author, msg?._data?.participant, msg?.id?.participant, contact);
    const fallback = { id: candidates[0] || "", candidates, contact };
    if (!fallback.id) return fallback;
    try {
      const resolved = await identities.resolveIdentity(msg, contact);
      return {
        id: resolved?.id || fallback.id,
        candidates: [...new Set([...(resolved?.candidates || []), ...fallback.candidates].filter(Boolean))],
        contact
      };
    } catch (_) {
      return fallback;
    }
  }

  const safeDeleteError = error => String(error?.message || "unavailable")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b\d{7,}\b/g, "[number]")
    .replace(/\b\S+@(?:lid|c\.us|g\.us)\b/gi, "[id]")
    .slice(0, 180);
  const messageAgeSeconds = msg => {
    const timestamp = Number(msg?.timestamp || msg?._data?.t);
    return Number.isFinite(timestamp) && timestamp > 0
      ? Math.max(0, Math.floor(Date.now() / 1000 - timestamp))
      : 0;
  };
  async function canRevokeForEveryone(msg) {
    const page = msg?.client?.pupPage || msg?._client?.pupPage;
    const compatibility = ensureMessageIdSerialized(msg);
    const messageId = compatibility.ok ? compatibility.serialized : null;
    if (!page || typeof page.evaluate !== "function" || !messageId) return null;
    return page.evaluate(async id => {
      const collections = window.require("WAWebCollections");
      const message = collections.Msg.get(id) ||
        (await collections.Msg.getMessagesById([id]))?.messages?.[0];
      if (!message) return false;
      const capability = window.require("WAWebMsgActionCapability");
      return Boolean(
        capability.canSenderRevokeMsg(message) ||
        capability.canAdminRevokeMsg(message)
      );
    }, messageId);
  }

  async function deleteMessage(msg, botParticipant, runtime = {}) {
    const log = value => {
      if (runtime?.diagnostic) console.log(`[DELETE] ${value}`);
    };
    const methodAvailable = typeof msg?.delete === "function";
    const botAdmin = Boolean(botParticipant?.isAdmin);
    log("iniciado");
    log(`methodAvailable=${methodAvailable}`);
    log(`botAdmin=${botAdmin}`);
    log(`fromMe=${Boolean(msg?.fromMe)}`);
    log(`messageAgeSeconds=${messageAgeSeconds(msg)}`);
    log("attempt=delete_everyone");
    if (!botAdmin) {
      log("success=false"); log("errorName=none"); log("errorCode=bot_not_admin"); log("errorMessage=unavailable");
      return { deleted: false, failureCode: "bot_not_admin" };
    }
    if (!methodAvailable) {
      log("success=false"); log("errorName=none"); log("errorCode=api_unavailable"); log("errorMessage=unavailable");
      return { deleted: false, failureCode: "api_unavailable" };
    }
    try {
      const compatibility = ensureMessageIdSerialized(msg);
      if (!compatibility.ok) {
        log("success=false"); log("errorName=none"); log(`errorCode=${compatibility.errorCode}`); log("errorMessage=unavailable");
        return { deleted: false, failureCode: compatibility.errorCode };
      }
      const canRevoke = await canRevokeForEveryone(msg);
      if (canRevoke === false) {
        log("success=false"); log("errorName=none"); log("errorCode=revoke_unavailable"); log("errorMessage=unavailable");
        return { deleted: false, failureCode: "revoke_unavailable" };
      }
      await msg.delete(true);
      log("success=true"); log("errorName=none"); log("errorCode=none"); log("errorMessage=none");
      return { deleted: true, failureCode: null };
    } catch (error) {
      log("success=false");
      log(`errorName=${String(error?.name || "Error").replace(/[^a-z0-9_$-]/gi, "").slice(0, 60) || "Error"}`);
      log("errorCode=delete_failed");
      log(`errorMessage=${safeDeleteError(error)}`);
      return { deleted: false, failureCode: "delete_failed" };
    }
  }

  async function inspectMessage(msg, runtime = {}) {
    if (!msg || msg.fromMe || typeof msg.from !== "string" || !msg.from.endsWith("@g.us")) return { status: "ignored" };
    const config = moderation.normalizeGroupConfig(await moderation.getGroupConfig(msg.from) || {});
    diagnostic(runtime, `configuração enabled=${Boolean(config.settings.antiLink.enabled)} approval=${Boolean(config.settings.approval?.enabled)}`);
    const hasBody = Boolean(clean(msg?.body || msg?._data?.body));
    const hasCaption = Boolean(clean(msg?.caption || msg?._data?.caption));
    diagnostic(runtime, `texto body=${hasBody} caption=${hasCaption}`);
    if (!config.settings.antiLink.enabled) { diagnostic(runtime, "processamento concluído"); return { status: "disabled" }; }
    const links = extractLinks(messageText(msg));
    diagnostic(runtime, `detector link encontrado=${links.length > 0}`);
    if (!links.length) { diagnostic(runtime, "processamento concluído"); return { status: "no_link" }; }
    const authorIdentity = await resolveAuthorIdentity(msg);
    const rawAuthor = msg.author || msg._data?.author || msg._data?.participant || msg.id?.participant;
    const authorId = authorIdentity?.id || "";
    const groupResolution = await groupChatResolver.resolveGroupChatWithParticipants({
      message: msg,
      chat: runtime.chat,
      client: runtime.client || msg?._client,
      diagnostic: message => diagnostic(runtime, message)
    });
    const chat = groupResolution.chat;
    const participantSource = groupResolution.source || "context_chat";
    if (!Array.isArray(groupResolution.participants) || !groupResolution.participants.length) {
      structureDiagnostic(runtime, msg, authorIdentity?.contact, chat);
      diagnostic(runtime, `participantes array=${Array.isArray(chat?.participants)} count=${Array.isArray(chat?.participants) ? chat.participants.length : 0} identitiesCollected=${participantCandidateCount(chat)}`);
      participantDiagnostic(runtime, authorIdentity, chat, false, participantSource);
      diagnostic(runtime, "decisão allowed=true reason=participant_lookup_failed");
      diagnostic(runtime, "ação apagar=false");
      diagnostic(runtime, "advertência criada=false");
      diagnostic(runtime, "processamento concluído");
      return { status: "safe_failure", reason: "participant_lookup_failed", internalReason: groupResolution.errorCode || "participants_unavailable" };
    }
    const botId = identities.normalizeUserId(msg?._client?.info?.wid || runtime.client?.info?.wid || options.botId);
    const author = findParticipant(chat, authorIdentity), bot = findParticipant(chat, { id: botId, candidates: [botId] });
    structureDiagnostic(runtime, msg, authorIdentity?.contact, chat);
    diagnostic(runtime, `participantes array=${Array.isArray(chat?.participants)} count=${Array.isArray(chat?.participants) ? chat.participants.length : 0} identitiesCollected=${participantCandidateCount(chat)}`);
    if (!authorId) {
      participantDiagnostic(runtime, authorIdentity, chat, false, participantSource);
      diagnostic(runtime, "decisão allowed=true reason=identity_unresolved");
      diagnostic(runtime, "ação apagar=false");
      diagnostic(runtime, "advertência criada=false");
      diagnostic(runtime, "processamento concluído");
      return { status: "safe_failure", reason: "identity_unresolved", internalReason: "author_identity_missing" };
    }
    if (!author) {
      participantDiagnostic(runtime, authorIdentity, chat, false, participantSource);
      diagnostic(runtime, "decisão allowed=true reason=participant_lookup_failed");
      diagnostic(runtime, "ação apagar=false");
      diagnostic(runtime, "advertência criada=false");
      diagnostic(runtime, "processamento concluído");
      return { status: "safe_failure", reason: "participant_lookup_failed", internalReason: "author_not_matched" };
    }
    participantDiagnostic(runtime, authorIdentity, chat, true, participantSource);
    if (botId && identities.identitiesMatch(authorId, botId)) {
      diagnostic(runtime, "decisão allowed=true reason=bot_message");
      diagnostic(runtime, "ação apagar=false");
      diagnostic(runtime, "advertência criada=false");
      diagnostic(runtime, "processamento concluído");
      return { status: "allowed", reason: "bot", warning: null, internalReason: "participant_resolved_admin" };
    }

    for (const link of links) {
      const domain = moderation.extractEffectiveDomain(link), linkType = moderation.classifyLink(link);
      const blacklisted = await moderation.isDomainBlacklisted(domain, msg.from);
      const whitelisted = await moderation.isDomainWhitelisted(domain, msg.from);
      if (!blacklisted && whitelisted) {
        diagnostic(runtime, "decisão allowed=true reason=domain_allowed");
        continue;
      }
      if (author.isSuperAdmin) {
        diagnostic(runtime, "decisão allowed=true reason=owner_protected");
        return { status: "allowed", reason: "owner_protected", warning: null, internalReason: "participant_resolved_owner" };
      }
      if (!blacklisted && config.settings.antiLink.adminsBypass && author.isAdmin) {
        diagnostic(runtime, "decisão allowed=true reason=admin_bypass");
        return { status: "allowed", reason: "admin_bypass", warning: null, internalReason: "participant_resolved_admin" };
      }
      diagnostic(runtime, `decisão allowed=false reason=${author.isAdmin ? "admin_link_blocked" : "member_common"}`);
      await moderation.registerHistory({ groupId: msg.from, userId: authorId, actorId: botId, action: "anti_link_detected", result: "blocked", domain, metadata: { domain, linkType } });
      const deletion = config.settings.antiLink.deleteMessage ? await deleteMessage(msg, bot, runtime) : { deleted: false, failureCode: "disabled" };
      diagnostic(runtime, `ação apagar=${Boolean(deletion.deleted)}`);
      if (config.settings.antiLink.deleteMessage) await moderation.registerHistory({ groupId: msg.from, userId: authorId, actorId: botId, action: deletion.deleted ? "anti_link_deleted" : "anti_link_delete_failed", result: deletion.deleted ? "success" : "failed", domain, metadata: { domain, linkType, failureCode: deletion.failureCode } });
      const protectedUser = author.isAdmin || author.isSuperAdmin;
      let warning = null, final = null;
      if (config.settings.antiLink.warnUser && !protectedUser) {
        const receiptId = `anti-link:${msg.id?._serialized || msg.id?.id || crypto.createHash("sha256").update(`${msg.from}:${authorId}:${messageText(msg)}`).digest("hex")}`;
        warning = await moderation.warnPlayerAutomatically({ groupId: msg.from, targetId: authorId, actorId: botId, receiptId, domain, linkType });
        if (!warning.duplicate && warning.crossedLimit) final = await moderation.applyWarningFinalAction({ groupId: msg.from, targetId: authorId, rawTargetId: rawAuthor, actorId: botId, botId, targetParticipant: author, botParticipant: bot, chat, receiptId, warningId: warning.warning?.warningId, warningCount: warning.activeCount, warningLimit: warning.limit, crossedLimit: true });
        if (final?.removed && final.action === "ban_and_remove") { try { await memberExperience.announceBan(runtime.client, { groupId: msg.from, memberId: authorId, reason: "Limite de advertências atingido" }); } catch (_) { /* anúncio não bloqueia o Antilink */ } }
      }
      diagnostic(runtime, `advertência criada=${Boolean(warning && !warning.duplicate)}`);
      const removedText = deletion.deleted ? "Mensagem removida." : "⚠️ Não consegui remover a mensagem por falta de permissão ou falha temporária.";
      let response = `⛔ LINK NÃO AUTORIZADO\n\n${removedText}\n\nEste grupo exige autorização antes da publicação de links.\n\nFale com um administrador ou envie o link no privado do MikaBot antes de publicar.`;
      if (warning && !warning.duplicate) {
        response += warning.activeCount >= warning.limit
          ? `\n\nAdvertências ativas: ${warning.activeCount}\nLimite configurado: ${warning.limit}\nStatus: limite ${warning.crossedLimit ? "atingido" : "já atingido"}`
          : `\n\nAdvertências: ${warning.activeCount}/${warning.limit}`;
      }
      if (final?.action === "notify_admins") response += "\n\n⚠️ LIMITE ATINGIDO\n\nO membro atingiu o limite de advertências. A moderação foi avisada.";
      if (final?.action === "remove_member" && final.removed) response += "\n\n🚫 MEMBRO REMOVIDO\n\nO limite de advertências foi atingido.";
      if (final?.action === "ban_and_remove" && final.removed) response += "\n\n🚫 MEMBRO BANIDO E REMOVIDO\n\nO banimento ficará ativo até ser removido por um administrador.";
      if (final && ["remove_member", "ban_and_remove"].includes(final.action) && !final.removed) response += "\n\n⚠️ O limite foi atingido, mas não consegui concluir a remoção.";
      if (typeof msg.reply === "function" && !warning?.duplicate) await msg.reply(response);
      diagnostic(runtime, "processamento concluído");
      return { status: "blocked", domain, linkType, deletion, warning, final, protectedUser, internalReason: author.isAdmin ? "participant_resolved_admin" : "participant_resolved_common" };
    }
    diagnostic(runtime, "ação apagar=false");
    diagnostic(runtime, "advertência criada=false");
    diagnostic(runtime, "processamento concluído");
    return { status: "allowed", reason: "whitelist_or_bypass" };
  }

  async function handleIncomingMessage(context = {}) {
    const msg = context.message || context.msg;
    const runtime = { ...context, diagnostic: true };
    diagnostic(runtime, "serviço iniciado");
    diagnostic(runtime, `contexto grupo=${Boolean(context.isGroup)} fromMe=${Boolean(msg?.fromMe)}`);
    if (!context.isGroup) { diagnostic(runtime, "processamento concluído"); return { status: "ignored", reason: "not_group" }; }
    if (!msg || msg.fromMe) {
      diagnostic(runtime, `decisão allowed=true reason=${context.approvedPublication ? "approved_publication" : "bot_message"}`);
      diagnostic(runtime, "processamento concluído");
      return { status: "ignored", reason: "from_bot" };
    }
    if (!messageText(msg)) {
      diagnostic(runtime, `texto body=${Boolean(clean(msg?.body || msg?._data?.body))} caption=${Boolean(clean(msg?.caption || msg?._data?.caption))}`);
      diagnostic(runtime, "processamento concluído");
      return { status: "ignored", reason: "no_text" };
    }
    return inspectMessage(msg, runtime);
  }

  return { extractLinks, messageText, inspectMessage, handleIncomingMessage, deleteMessage };
}

const service = createAntiLinkService();
module.exports = { ...service, createAntiLinkService };
