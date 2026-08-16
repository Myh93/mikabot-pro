"use strict";

const guidedFlowDefault = require("./guidedFlowService");
const moderationDefault = require("./moderationService");
const inputResolverDefault = require("./inputResolverService");

function createModerationWarningFlowService(options = {}) {
  const flows = options.guidedFlowService || guidedFlowDefault;
  const moderation = options.moderationService || moderationDefault;
  const inputResolver = options.inputResolverService || inputResolverDefault;
  const flowArgs = context => [context.platform || "whatsapp", context.groupId, context.userId];
  const reply = (context, text) => context.replyText(String(text));

  async function startReset(context, target) {
    const existing = await flows.getActiveFlow(...flowArgs(context));
    if (existing) { await reply(context, "⚠️ Você já possui uma confirmação em andamento neste grupo."); return { status: "conflict" }; }
    const result = await flows.startFlow({ flowId: "moderation_warning_reset", platform: context.platform || "whatsapp", conversationId: context.groupId, userId: context.userId, step: "confirm_reset", data: { targetId: target.targetId, targetName: target.targetName, actorRole: context.role } });
    await reply(context, `⚠️ Confirmar limpeza das advertências de ${target.targetName}?\n\n1️⃣ Confirmar\n2️⃣ Cancelar`);
    return { status: "started", session: result.session };
  }

  async function hasActiveFlow(context) {
    if (!context?.isGroup || !context.groupId || !context.userId) return false;
    const session = await flows.getActiveFlow(...flowArgs(context)); return session?.flowId === "moderation_warning_reset";
  }

  async function handleAnswer(context, text) {
    const session = await flows.getActiveFlow(...flowArgs(context)); if (!session || session.flowId !== "moderation_warning_reset") return { status: "ignored" };
    const navigation = inputResolver.resolveNavigation(text), answer = inputResolver.resolveYesNo(text);
    if (["cancel", "back", "menu"].includes(navigation) || answer === false) { await flows.cancelFlow(...flowArgs(context)); await reply(context, "❌ Limpeza de advertências cancelada."); return { status: "cancelled" }; }
    if (answer !== true) { await reply(context, "❌ Responda 1 para Confirmar ou 2 para Cancelar."); return { status: "validation_error" }; }
    const cleared = await moderation.resetWarnings({ groupId: context.groupId, targetId: session.data.targetId, actorId: context.userId, actorRole: session.data.actorRole || context.role });
    await flows.finishFlow(...flowArgs(context));
    if (!cleared.length) { await reply(context, "✅ Este membro não possui advertências ativas."); return { status: "empty", cleared }; }
    await reply(context, `✅ ${cleared.length} advertência${cleared.length === 1 ? " foi desativada" : "s foram desativadas"} com sucesso.`);
    return { status: "reset", cleared };
  }

  return { startReset, hasActiveFlow, handleAnswer };
}

const service = createModerationWarningFlowService();
module.exports = { ...service, createModerationWarningFlowService };
