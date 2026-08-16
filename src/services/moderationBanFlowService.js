"use strict";

const guidedDefault = require("./guidedFlowService");
const moderationDefault = require("./moderationService");
const resolverDefault = require("./inputResolverService");

function createModerationBanFlowService(options = {}) {
  const flows = options.guidedFlowService || guidedDefault, moderation = options.moderationService || moderationDefault, resolver = options.inputResolverService || resolverDefault;
  const args = context => [context.platform || "whatsapp", context.groupId, context.userId];
  async function replaceOwnFlow(context, input) { const existing = await flows.getActiveFlow(...args(context)); if (existing && existing.flowId !== "moderation_ban_manage") return { started: false, conflict: true, session: existing }; if (existing) await flows.cancelFlow(...args(context)); return flows.startFlow(input); }
  async function startList(context, bans) { return replaceOwnFlow(context, { flowId: "moderation_ban_manage", platform: context.platform || "whatsapp", conversationId: context.groupId, userId: context.userId, step: "select_ban", data: { bans } }); }
  async function startConfirmation(context, ban) { const result = await replaceOwnFlow(context, { flowId: "moderation_ban_manage", platform: context.platform || "whatsapp", conversationId: context.groupId, userId: context.userId, step: "confirm_unban", data: { selected: ban } }); if (result.conflict) { await context.replyText("⚠️ Você já possui outra confirmação em andamento neste grupo."); return result; } await context.replyText(`⚠️ Remover o banimento de ${ban.name}?\n\n1️⃣ Confirmar\n2️⃣ Cancelar`); return result; }
  async function hasActiveFlow(context) { const session = context?.isGroup && await flows.getActiveFlow(...args(context)); return session?.flowId === "moderation_ban_manage"; }
  async function handleAnswer(context, text) {
    const session = await flows.getActiveFlow(...args(context)); if (!session || session.flowId !== "moderation_ban_manage") return { status: "ignored" };
    const navigation = resolver.resolveNavigation(text), yesNo = resolver.resolveYesNo(text);
    if (["cancel", "back", "menu"].includes(navigation) || (session.step === "confirm_unban" && yesNo === false)) { await flows.cancelFlow(...args(context)); await context.replyText("❌ Operação de banimento cancelada."); return { status: "cancelled" }; }
    if (session.step === "select_ban") { const position = Number(String(text).trim()), selected = session.data.bans?.[position - 1]; if (!selected) { await context.replyText("❌ Selecione um número válido da lista ou digite 9 para cancelar."); return { status: "validation_error" }; } await flows.updateFlow(...args(context), { step: "confirm_unban", data: { selected } }); await context.replyText(`⚠️ Remover o banimento de ${selected.name}?\n\n1️⃣ Confirmar\n2️⃣ Cancelar`); return { status: "confirmation" }; }
    if (yesNo !== true) { await context.replyText("❌ Responda 1 para Confirmar ou 2 para Cancelar."); return { status: "validation_error" }; }
    const revoked = await moderation.unbanPlayer({ banId: session.data.selected.banId, actorId: context.userId }); await flows.finishFlow(...args(context)); await context.replyText(revoked ? "✅ Banimento removido com sucesso. O membro não foi adicionado novamente ao grupo." : "✅ Este banimento já não estava ativo."); return { status: "revoked", revoked };
  }
  return { startList, startConfirmation, hasActiveFlow, handleAnswer };
}
const service = createModerationBanFlowService();
module.exports = { ...service, createModerationBanFlowService };
