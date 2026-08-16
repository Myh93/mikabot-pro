"use strict";

const flowsDefault = require("./guidedFlowService");
const inputDefault = require("./inputResolverService");
const lifecycleDefault = require("./memberDataLifecycleService");

const FLOW_ID = "member_data_administration";

function createMemberDataAdministrationFlowService(options = {}) {
  const flows = options.guidedFlowService || flowsDefault;
  const input = options.inputResolverService || inputDefault;
  const lifecycle = options.memberDataLifecycleService || lifecycleDefault;
  const args = context => [context.platform, context.conversationId || context.groupId, context.userId];

  async function start(context, action, targetId) {
    const existing = await flows.getActiveFlow(...args(context));
    if (existing) return { status: "conflict" };
    const inspection = await lifecycle.inspectBlockers(targetId);
    if (!inspection.memberId || (!inspection.member && !inspection.registration)) return { status: "not_found" };
    const firstStep = action === "remove_member" ? "reason" : "confirm";
    await flows.startFlow({ flowId: FLOW_ID, platform: context.platform, conversationId: context.conversationId || context.groupId, userId: context.userId, step: firstStep, data: { action, targetId: inspection.memberId, executor: context.userId, blockersChecked: inspection.blockers } });
    await context.replyText(action === "remove_member" ? "📝 Informe o motivo da remoção completa." : "⚠️ ATENÇÃO\n\nEsta ação é irreversível.\n\n1️⃣ Confirmar\n2️⃣ Cancelar");
    return { status: "started" };
  }

  async function cancel(context) {
    await flows.cancelFlow(...args(context));
    await context.replyText("❌ Operação cancelada.");
    return { status: "cancelled" };
  }

  async function execute(session) {
    const metadata = { executor: session.data.executor, reason: session.data.reason };
    if (session.data.action === "remove_member") return lifecycle.removeMember(session.data.targetId, metadata);
    if (session.data.action === "remove_registration") return lifecycle.removeRegistration(session.data.targetId, metadata);
    return lifecycle.resetQuiz(session.data.targetId, metadata);
  }

  async function handleAnswer(context, text) {
    const session = await flows.getActiveFlow(...args(context));
    if (session?.flowId !== FLOW_ID) return { status: "ignored" };
    const navigation = input.resolveNavigation(text);
    const yesNo = input.resolveYesNo(text);
    if (["cancel", "back", "menu"].includes(navigation) || yesNo === false) return cancel(context);
    if (session.step === "reason") {
      const reason = String(text || "").trim();
      if (!reason) { await context.replyText("📝 Informe o motivo da remoção completa."); return { status: "validation_error" }; }
      await flows.advanceFlow(...args(context), "confirm", { reason });
      await context.replyText("⚠️ ATENÇÃO\n\nEsta ação é irreversível.\n\n1️⃣ Confirmar\n2️⃣ Cancelar");
      return { status: "confirm" };
    }
    if (yesNo !== true) return { status: "validation_error" };
    if (session.data.action === "remove_member" && session.step === "confirm") {
      await flows.advanceFlow(...args(context), "final_confirm", {});
      await context.replyText("⚠️ CONFIRMAÇÃO FINAL\n\nTodos os dados pessoais e operacionais serão removidos.\n\n1️⃣ Confirmar\n2️⃣ Cancelar");
      return { status: "final_confirm" };
    }
    const result = await execute(session);
    await flows.finishFlow(...args(context));
    await context.replyText(result.status === "removed" ? `✅ Operação concluída. Itens removidos: ${result.itemsRemoved}.` : result.status === "already_removed" ? "✅ Os dados solicitados já estavam removidos." : "❌ Usuário não encontrado.");
    return { status: "completed", result };
  }

  async function hasActiveFlow(context) {
    if (!context?.platform || !(context.conversationId || context.groupId) || !context.userId) return false;
    return (await flows.getActiveFlow(...args(context)))?.flowId === FLOW_ID;
  }

  return { start, handleAnswer, hasActiveFlow };
}

const service = createMemberDataAdministrationFlowService();
module.exports = { ...service, createMemberDataAdministrationFlowService, FLOW_ID };
