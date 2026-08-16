"use strict";

const eventGuidedFlowDefault = require("../services/eventGuidedFlowService");
const moderationWarningFlowDefault = require("../services/moderationWarningFlowService");
const moderationBanFlowDefault = require("../services/moderationBanFlowService");
const linkApprovalFlowDefault = require("../services/linkApprovalFlowService");
const raidGuidedFlowDefault = require("../services/raidGuidedFlowService");
const feedbackFlowDefault = require("../services/feedbackService");
const feedbackAdministrationFlowDefault = require("../services/feedbackAdministrationService");
const memberDataAdministrationFlowDefault = require("../services/memberDataAdministrationFlowService");
const memberExperienceAdministrationFlowDefault = require("../services/memberExperienceAdministrationService");
const banExperienceAdministrationFlowDefault = require("../services/banExperienceAdministrationService");
const { logDetailedError } = require("../../utils/logger");

function normalizeGuidedFlowContext(context) {
  if (!context || typeof context !== "object") return null;
  const platform = typeof context.platform === "string" ? context.platform.trim() : "";
  const conversationId = typeof context.conversationId === "string" && context.conversationId.trim()
    ? context.conversationId.trim()
    : typeof context.groupId === "string" ? context.groupId.trim() : "";
  const userId = typeof context.userId === "string" ? context.userId.trim() : "";
  if (!platform || !conversationId || !userId) return null;
  return {
    ...context,
    platform,
    conversationId,
    groupId: typeof context.groupId === "string" && context.groupId.trim()
      ? context.groupId.trim()
      : conversationId,
    userId,
    isGroup: Boolean(context.isGroup)
  };
}

function createGuidedFlowAnswer(options = {}) {
  const eventGuidedFlow = options.eventGuidedFlow || eventGuidedFlowDefault;
  const moderationWarningFlow = options.moderationWarningFlow || moderationWarningFlowDefault;
  const moderationBanFlow = options.moderationBanFlow || moderationBanFlowDefault;
  const linkApprovalFlow = options.linkApprovalFlow || linkApprovalFlowDefault;
  const raidGuidedFlow = options.raidGuidedFlow || raidGuidedFlowDefault;
  const feedbackFlow = options.feedbackFlow || feedbackFlowDefault;
  const feedbackAdministrationFlow = options.feedbackAdministrationFlow || feedbackAdministrationFlowDefault;
  const memberDataAdministrationFlow = options.memberDataAdministrationFlow || memberDataAdministrationFlowDefault;
  const memberExperienceAdministrationFlow = options.memberExperienceAdministrationFlow || memberExperienceAdministrationFlowDefault;
  const banExperienceAdministrationFlow = options.banExperienceAdministrationFlow || banExperienceAdministrationFlowDefault;

  const normalizeContext = normalizeGuidedFlowContext;

  async function hasActiveFlow(context) {
    context = normalizeContext(context);
    if (!context) return false;
    if (await memberExperienceAdministrationFlow.hasActiveFlow(context)) return true;
    if (await banExperienceAdministrationFlow.hasActiveFlow(context)) return true;
    if (await memberDataAdministrationFlow.hasActiveFlow(context)) return true;
    if (await raidGuidedFlow.hasActiveFlow(context)) return true;
    if (await feedbackAdministrationFlow.hasActiveFlow(context)) return true;
    if (await feedbackFlow.hasActiveFlow(context)) return true;
    if (await moderationWarningFlow.hasActiveFlow(context)) return true;
    if (await moderationBanFlow.hasActiveFlow(context)) return true;
    if (await linkApprovalFlow.hasActiveFlow(context)) return true;
    if (context?.isGroup) return false;
    const privateContext = { ...context, conversationId: context.groupId };
    return eventGuidedFlow.hasActiveFlow(privateContext);
  }

  async function handleGuidedFlowAnswer({ client, context, text }) {
    context = normalizeContext(context);
    if (!context) return { status: "ignored" };
    if (await memberExperienceAdministrationFlow.hasActiveFlow(context)) {
      try { return await memberExperienceAdministrationFlow.handleAnswer({ ...context, client, originalMessage: context.message }, text); }
      catch (error) { logDetailedError("Erro ao configurar experiência do membro:", error); await context.replyText("❌ Não foi possível continuar a configuração agora."); return { status: "error", error }; }
    }
    if (await banExperienceAdministrationFlow.hasActiveFlow(context)) {
      try { return await banExperienceAdministrationFlow.handleAnswer({ ...context, client, originalMessage: context.message }, text); }
      catch (error) { logDetailedError("Erro ao configurar mensagens de banimento:", error); await context.replyText("❌ Não foi possível continuar a configuração agora."); return { status: "error", error }; }
    }
    if (await memberDataAdministrationFlow.hasActiveFlow(context)) {
      try { return await memberDataAdministrationFlow.handleAnswer({ ...context, client }, text); }
      catch (error) { logDetailedError("Erro ao processar remoção administrativa de dados:", error); await context.replyText("❌ Não foi possível concluir a operação de dados agora."); return { status: "error", error }; }
    }
    if (await raidGuidedFlow.hasActiveFlow(context)) {
      try { return await raidGuidedFlow.handleAnswer({ ...context, client }, text); }
      catch (error) { logDetailedError("Erro ao processar criação guiada de Raid:", error); await context.replyText("❌ Não foi possível continuar a criação da Raid agora."); return { status: "error", error }; }
    }
    if (await feedbackAdministrationFlow.hasActiveFlow(context)) {
      try { return await feedbackAdministrationFlow.handleAnswer({ ...context, client }, text); }
      catch (error) { logDetailedError("Erro ao processar administração de Feedback:", error); await context.replyText("❌ Não foi possível continuar a administração do feedback agora."); return { status: "error", error }; }
    }
    if (await feedbackFlow.hasActiveFlow(context)) {
      try { return await feedbackFlow.handleAnswer({ ...context, client }, text); }
      catch (error) { logDetailedError("Erro ao processar Feedback:", error); await context.replyText("❌ Não foi possível continuar o feedback agora."); return { status: "error", error }; }
    }
    if (await moderationWarningFlow.hasActiveFlow(context)) {
      try { return await moderationWarningFlow.handleAnswer(context, text); }
      catch (error) { logDetailedError("Erro ao processar confirmação de advertências:", error); await context.replyText("❌ Não foi possível concluir a operação de advertências agora."); return { status: "error", error }; }
    }
    if (await moderationBanFlow.hasActiveFlow(context)) {
      try { return await moderationBanFlow.handleAnswer(context, text); }
      catch (error) { logDetailedError("Erro ao processar confirmação de banimento:", error); await context.replyText("❌ Não foi possível concluir a operação de banimento agora."); return { status: "error", error }; }
    }
    if (await linkApprovalFlow.hasActiveFlow(context)) {
      try { return await linkApprovalFlow.handleAnswer({ ...context, client }, text); }
      catch (error) { logDetailedError("Erro ao processar aprovação de links:", error); await context.replyText("❌ Não foi possível concluir a operação de links agora."); return { status: "error", error }; }
    }
    if (context?.isGroup) return { status: "ignored" };
    try {
      return await eventGuidedFlow.handleAnswer(client, { ...context, conversationId: context.groupId }, text);
    } catch (error) {
      logDetailedError("Erro ao processar fluxo guiado de Eventos:", error);
      await context.replyText("❌ Não foi possível concluir esta ação agora.");
      return { status: "error", error };
    }
  }

  return { normalizeContext, hasActiveFlow, handleGuidedFlowAnswer };
}

const handler = createGuidedFlowAnswer();
module.exports = { ...handler, createGuidedFlowAnswer, normalizeGuidedFlowContext };
