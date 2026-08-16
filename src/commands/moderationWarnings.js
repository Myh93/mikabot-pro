"use strict";

const moderationDefault = require("../services/moderationService");
const warningFlowDefault = require("../services/moderationWarningFlowService");
const identityDefault = require("../services/identityService");
const messageStyleDefault = require("../services/messageStyleService");
const groupMemberResolverDefault = require("../services/groupMemberResolverService");
const { isGroupMessage } = require("../utils/messageContext");
const memberExperienceDefault = require("../services/memberExperienceService");

const GROUP_ONLY = "⚠️ Este comando funciona somente em grupos.";

function createModerationWarningCommands(options = {}) {
  const moderation = options.moderationService || moderationDefault;
  const warningFlow = options.moderationWarningFlowService || warningFlowDefault;
  const identities = options.identityService || identityDefault;
  const messageStyle = options.messageStyleService || messageStyleDefault;
  const groupMembers = options.groupMemberResolverService || groupMemberResolverDefault;
  const memberExperience = options.memberExperienceService || memberExperienceDefault;

  async function contextFor(client, msg, loaderContext) {
    const groupId = String(msg?.from || ""), isGroup = await isGroupMessage(msg, loaderContext.chat);
    const identity = loaderContext.role?.identity?.id || loaderContext.role?.identity || loaderContext.identity?.id || loaderContext.identity || msg?.author;
    return { platform: "whatsapp", groupId, conversationId: groupId, userId: identities.normalizeUserId(identity), isGroup, role: loaderContext.role || { name: "member", rank: 0 }, chat: loaderContext.chat, client, msg, messageId: msg?.id?._serialized || msg?.id?.id || (typeof msg?.id === "string" ? msg.id : null), replyText: text => msg.reply(String(text)) };
  }
  async function displayName(id, context, participant = null) { return identities.resolveDisplayName(id, { msg: null, displayName: participant?.name || participant?.pushname || participant?.shortName || null }); }
  function removeMentionToken(args, source) { const tokens = [...args]; if (source === "mention" && tokens[0]?.startsWith("@")) tokens.shift(); return tokens; }
  function targetError(code) {
    const messages = {
      target_missing: "Mencione um membro ou responda à mensagem dele.",
      quoted_message_unavailable: "Não foi possível consultar a mensagem respondida agora.",
      target_identity_unresolved: "Não foi possível confirmar a identidade do membro agora.",
      participants_unavailable: "Não foi possível consultar os participantes do grupo agora.",
      target_not_in_group: "O membro informado não pertence a este grupo."
    };
    const error = new Error(messages[code] || "Não foi possível confirmar o membro agora.");
    error.code = String(code || "target_identity_unresolved").toUpperCase();
    return error;
  }
  async function resolveTarget(context, allowSelf) {
    const hasExplicitTarget = Boolean(
      context.msg?.mentionedIds?.length ||
      context.msg?._data?.mentionedJidList?.length ||
      context.msg?.hasQuotedMsg ||
      context.msg?._data?.quotedMsg
    );
    if (allowSelf && !hasExplicitTarget) {
      const participant = Array.isArray(context.chat?.participants)
        ? context.chat.participants.find(item => identities.identitiesMatch(item, context.userId))
        : null;
      return { targetId: context.userId, participant, source: "self", displayName: await displayName(context.userId, context, participant) };
    }
    const result = await groupMembers.resolveGroupMember({
      message: context.msg,
      chat: context.chat,
      client: context.client
    });
    if (!result.ok) throw targetError(result.errorCode);
    return { targetId: result.canonicalUserId, participant: result.participant, source: result.source, displayName: result.displayName };
  }
  async function safeExecute(context, operation) {
    if (!context.isGroup) return context.replyText(GROUP_ONLY);
    try { return await operation(); }
    catch (error) {
      const known = new Set(["TARGET_REQUIRED", "TARGET_MISSING", "TARGET_INVALID", "TARGET_NOT_IN_GROUP", "TARGET_IDENTITY_UNRESOLVED", "QUOTED_MESSAGE_UNAVAILABLE", "IDENTITY_UNAVAILABLE", "PARTICIPANTS_UNAVAILABLE", "REASON_REQUIRED", "REASON_TOO_LONG", "PERMISSION_DENIED", "BOT_PROTECTED", "SELF_PROTECTED", "OWNER_PROTECTED", "ADMIN_PROTECTED", "VIEW_FORBIDDEN", "RESET_FORBIDDEN", "INVALID_PAGE"]);
      return context.replyText(known.has(error.code) ? `❌ ${error.message}` : "❌ Não foi possível concluir a operação de advertências agora.");
    }
  }

  async function warn(client, msg, args, loaderContext) {
    const context = await contextFor(client, msg, loaderContext); return safeExecute(context, async () => {
      const target = await resolveTarget(context, false), reason = removeMentionToken(args, target.source).join(" ") || "Advertência manual";
      const botId = client?.info?.wid || client?.info?.me || client?.info?.id;
      const result = await moderation.warnPlayer({ groupId: context.groupId, targetId: target.targetId, targetParticipant: target.participant, actorId: context.userId, actorRole: context.role, botId, reason, receiptId: context.messageId });
      const botParticipant = Array.isArray(context.chat?.participants)
        ? context.chat.participants.find(item => groupMembers.participantMatches(item, identities.collectCanonicalIdentityCandidates(botId)))
        : null;
      const finalResult = !result.duplicate && (result.crossedLimit || result.activeCount > result.limit)
        ? await moderation.applyWarningFinalAction({
          groupId: context.groupId,
          targetId: target.targetId,
          rawTargetId: typeof target.participant?.id === "string"
            ? target.participant.id
            : target.participant?.id?._serialized || target.targetId,
          actorId: context.userId,
          botId,
          targetParticipant: target.participant,
          botParticipant,
          chat: context.chat,
          receiptId: context.messageId,
          warningId: result.warning?.warningId,
          warningCount: result.activeCount,
          warningLimit: result.limit,
          crossedLimit: result.crossedLimit
        })
        : null;
      if (finalResult?.removed && result.finalAction === "ban_and_remove") {
        try { await memberExperience.announceBan(client, { groupId: context.groupId, memberId: target.targetId, reason }); } catch (_) { /* anúncio não bloqueia a moderação */ }
      }
      const name = await displayName(target.targetId, context, target.participant);
      return context.replyText(moderation.createWarningSummary({ memberName: name, activeCount: result.activeCount ?? await moderation.getWarningCount(context.groupId, target.targetId), limit: result.limit, reason: result.warning.reason, reachedLimit: result.reachedLimit, crossedLimit: result.crossedLimit, finalAction: result.finalAction, finalResult }));
    });
  }

  function pageFrom(args, source) { const tokens = removeMentionToken(args, source), last = tokens.at(-1); if (!tokens.length) return 1; if (tokens.length === 1 && /^\d+$/.test(String(last)) && Number(last) >= 1) return Number(last); const error = new Error("Use somente uma menção, uma resposta ou o número da página."); error.code = "TARGET_INVALID"; throw error; }
  async function warnings(client, msg, args, loaderContext) {
    const context = await contextFor(client, msg, loaderContext); return safeExecute(context, async () => {
      const target = await resolveTarget(context, true), page = pageFrom(args, target.source), listed = await moderation.listWarnings({ groupId: context.groupId, targetId: target.targetId, actorId: context.userId, actorRole: context.role, page });
      const name = await displayName(target.targetId, context, target.participant);
      if (!listed.activeCount) return context.replyText("✅ Este membro não possui advertências ativas.");
      const actorNames = new Map(); for (const item of listed.items) if (!actorNames.has(item.actorId)) actorNames.set(item.actorId, await displayName(item.actorId, context));
      const lines = [`👤 Membro: ${name}`, `📊 Ativas: ${listed.activeCount}`, `🎯 Limite: ${listed.limit}`, "", "HISTÓRICO ATIVO", ""];
      listed.items.forEach((item, index) => lines.push(`${(listed.page - 1) * listed.pageSize + index + 1}. ${item.reason}`, `   ${new Date(item.createdAt).toLocaleString("pt-BR", { timeZone: "America/Fortaleza" })}`, `   Aplicada por: ${actorNames.get(item.actorId)}`, ""));
      if (listed.totalPages > 1) lines.push(`📄 Página ${listed.page} de ${listed.totalPages}`);
      return context.replyText(messageStyle.section("⚠️ ADVERTÊNCIAS", lines));
    });
  }

  async function reset(client, msg, args, loaderContext) {
    const context = await contextFor(client, msg, loaderContext); return safeExecute(context, async () => {
      if (!moderation.canResetWarnings(context.role)) { const error = new Error("Você não possui permissão para limpar advertências."); error.code = "RESET_FORBIDDEN"; throw error; }
      const target = await resolveTarget(context, false); if (removeMentionToken(args, target.source).length) { const error = new Error("Mencione um membro ou responda à mensagem dele."); error.code = "TARGET_INVALID"; throw error; }
      const listed = await moderation.listWarnings({ groupId: context.groupId, targetId: target.targetId, actorId: context.userId, actorRole: context.role, page: 1 });
      if (!listed.activeCount) return context.replyText("✅ Este membro não possui advertências ativas.");
      const targetName = await displayName(target.targetId, context, target.participant);
      return warningFlow.startReset(context, { targetId: target.targetId, targetName });
    });
  }

  return [
    { name: "warn", aliases: ["avisar", "advertir", "advertencia"], permissions: true, execute: warn },
    { name: "warnings", aliases: ["advertências", "avisos"], permissions: true, execute: warnings },
    { name: "resetwarn", aliases: ["limparavisos", "zeraravisos"], permissions: true, execute: reset },
    { name: "clearwarns", aliases: [], permissions: true, execute: reset }
  ];
}

const commands = createModerationWarningCommands();
module.exports = Object.assign(commands, { createModerationWarningCommands, GROUP_ONLY });
