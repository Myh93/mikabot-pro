"use strict";

const feedbackDefault = require("./feedbackService");
const flowsDefault = require("./guidedFlowService");
const inputDefault = require("./inputResolverService");

const FLOW_ID = "feedback_administration";
const ADMIN_ACTIONS = new Set(["respond", "resolve", "reject"]);

function createFeedbackAdministrationService(options = {}) {
  const feedback = options.feedbackService || feedbackDefault;
  const flows = options.guidedFlowService || flowsDefault;
  const input = options.inputResolverService || inputDefault;
  const args = context => [context.platform || "whatsapp", context.conversationId || context.groupId, context.userId];

  function isAdministrator(context = {}) {
    const role = context.role || context;
    return Boolean(role.isOwner || role.isProtectedOwner || role.isAdmin ||
      ["owner", "protectedOwner", "admin"].includes(role.name) || Number(role.rank) >= 2);
  }

  function requireAdministrator(context) {
    if (!isAdministrator(context)) {
      const error = new Error("Somente owners e administradores podem gerenciar feedbacks.");
      error.code = "FEEDBACK_ADMIN_FORBIDDEN";
      throw error;
    }
  }

  function actor(context) {
    return { userId: context.userId, id: context.userId, role: context.role || context };
  }

  function mapFilters(words = []) {
    const normalized = words.map(input.normalizeInput);
    const filters = {};
    if (normalized.some(value => ["aberta", "abertas", "aberto", "abertos"].includes(value))) filters.statuses = ["NEW", "OPEN", "IN_PROGRESS"];
    if (normalized.some(value => ["resolvida", "resolvidas", "resolvido", "resolvidos"].includes(value))) filters.status = "RESOLVED";
    if (normalized.some(value => ["rejeitada", "rejeitadas", "rejeitado", "rejeitados"].includes(value))) filters.status = "REJECTED";
    if (normalized.includes("erro")) filters.tipo = "ERROR";
    if (normalized.some(value => ["sugestao", "sugestoes"].includes(value))) filters.tipo = "SUGGESTION";
    if (normalized.some(value => ["melhoria", "melhorias"].includes(value))) filters.tipo = "IMPROVEMENT";
    if (normalized.some(value => ["duvida", "duvidas"].includes(value))) filters.tipo = "QUESTION";
    return filters;
  }

  async function listFeedbacks(context, words = []) {
    requireAdministrator(context);
    const filters = mapFilters(words);
    if (!words.length) filters.statuses = ["NEW", "OPEN", "IN_PROGRESS"];
    let items = await feedback.listFeedbacks(
      Object.fromEntries(Object.entries(filters).filter(([key]) => key !== "statuses")),
      actor(context)
    );
    if (filters.statuses) items = items.filter(item => filters.statuses.includes(item.status));
    return items;
  }

  function formatList(items) {
    if (!items.length) return "📭 Nenhum feedback encontrado.";
    return ["📋 FEEDBACKS", "", ...items.map(item =>
      `${item.id} — ${item.status} — ${item.tipo}\n${item.data}`
    )].join("\n\n");
  }

  async function viewFeedback(context, id) {
    requireAdministrator(context);
    return feedback.getFeedback(id, actor(context));
  }

  function formatFeedback(item) {
    if (!item) return "❌ Protocolo não encontrado.";
    return [
      `📋 ${item.id}`, `Status: ${item.status}`, `Tipo: ${item.tipo}`,
      `Data: ${item.data}`, `Grupo: ${item.grupo || "Não informado"}`,
      `Plataforma: ${item.plataforma}`, `Autor: ${item.autor}`,
      "", "Descrição:", item.descricao,
      ...(item.resposta ? ["", "Resposta:", item.resposta] : [])
    ].join("\n");
  }

  async function stats(context) {
    requireAdministrator(context);
    const items = await feedback.listFeedbacks({}, actor(context));
    const count = value => items.filter(item => item.status === value).length;
    const type = value => items.filter(item => item.tipo === value).length;
    const durations = items
      .filter(item => item.resolvedAt && Number.isFinite(Date.parse(item.data)))
      .map(item => Date.parse(item.resolvedAt) - Date.parse(item.data))
      .filter(value => value >= 0);
    const average = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null;
    return {
      total: items.length,
      open: items.filter(item => ["NEW", "OPEN"].includes(item.status)).length,
      inProgress: count("IN_PROGRESS"), resolved: count("RESOLVED"), rejected: count("REJECTED"),
      errors: type("ERROR"), suggestions: type("SUGGESTION"), improvements: type("IMPROVEMENT"), questions: type("QUESTION"),
      averageResolutionMs: average
    };
  }

  function formatStats(value) {
    const average = value.averageResolutionMs === null
      ? "Não disponível"
      : `${(value.averageResolutionMs / 3_600_000).toFixed(1)} hora(s)`;
    return [
      "📊 FEEDBACKS", "", `Total: ${value.total}`, `Abertos: ${value.open}`,
      `Em andamento: ${value.inProgress}`, `Resolvidos: ${value.resolved}`,
      `Rejeitados: ${value.rejected}`, "", `Erros: ${value.errors}`,
      `Sugestões: ${value.suggestions}`, `Melhorias: ${value.improvements}`,
      `Dúvidas: ${value.questions}`, "", `Tempo médio de resolução: ${average}`
    ].join("\n");
  }

  async function startAction(context, action, id) {
    requireAdministrator(context);
    if (!ADMIN_ACTIONS.has(action)) throw new Error("Ação administrativa inválida.");
    const item = await feedback.getFeedback(id, actor(context));
    if (!item) return { status: "not_found" };
    const existing = await flows.getActiveFlow(...args(context));
    if (existing) return { status: "conflict", session: existing };
    const result = await flows.startFlow({
      flowId: FLOW_ID, platform: context.platform || "whatsapp",
      conversationId: context.conversationId || context.groupId, userId: context.userId,
      step: "text", data: { action, feedbackId: item.id, actorRole: context.role || context }
    });
    await context.replyText(action === "respond" ? "📝 Digite a resposta." :
      action === "resolve" ? "📝 Informe uma observação (opcional).\n\nResponda pular para continuar sem observação." :
        "📝 Informe o motivo da rejeição.");
    return { status: "started", session: result.session };
  }

  async function cancel(context) {
    await flows.cancelFlow(...args(context));
    await context.replyText("❌ Operação de feedback cancelada.");
    return { status: "cancelled" };
  }

  async function handleAnswer(context, text) {
    const session = await flows.getActiveFlow(...args(context));
    if (session?.flowId !== FLOW_ID) return { status: "ignored" };
    requireAdministrator({ ...context, role: session.data.actorRole || context.role });
    const navigation = input.resolveNavigation(text);
    if (["cancel", "menu", "back"].includes(navigation)) return cancel(context);
    if (session.step === "text") {
      const value = String(text || "").trim();
      const normalized = input.normalizeInput(value);
      const optional = session.data.action === "resolve" && normalized === "pular";
      if (!value || (session.data.action === "reject" && normalized === "pular")) {
        await context.replyText(session.data.action === "reject" ? "📝 Informe o motivo da rejeição." : "📝 Informe o texto solicitado.");
        return { status: "validation_error" };
      }
      const updated = await flows.advanceFlow(...args(context), "confirm", { value: optional ? null : value });
      await context.replyText(["📋 Confirmar envio", "", "1️⃣ Enviar", "2️⃣ Editar", "3️⃣ Cancelar"].join("\n"));
      return { status: "confirm", session: updated };
    }
    const choice = input.resolveMenuOption(text, [
      { value: "send", number: 1, aliases: ["enviar", "confirmar"] },
      { value: "edit", number: 2, aliases: ["editar"] },
      { value: "cancel", number: 3, aliases: ["cancelar"] }
    ]);
    if (choice === "edit") {
      const updated = await flows.advanceFlow(...args(context), "text", {});
      await context.replyText(session.data.action === "respond" ? "📝 Digite a resposta." : "📝 Informe a observação ou motivo.");
      return { status: "edit", session: updated };
    }
    if (choice === "cancel") return cancel(context);
    if (choice !== "send") return { status: "validation_error" };
    const admin = actor({ ...context, role: session.data.actorRole || context.role });
    const notifyContext = { client: context.client, sendPrivate: context.sendPrivate };
    let item;
    if (session.data.action === "respond") item = await feedback.addResponse(session.data.feedbackId, session.data.value, admin, notifyContext);
    else if (session.data.action === "resolve") item = await feedback.resolveFeedback(session.data.feedbackId, admin, session.data.value, notifyContext);
    else item = await feedback.rejectFeedback(session.data.feedbackId, admin, session.data.value, notifyContext);
    await flows.finishFlow(...args(context));
    await context.replyText(`✅ Feedback ${item.id} atualizado para ${item.status}.`);
    return { status: "updated", feedback: item };
  }

  async function hasActiveFlow(context) {
    if (!context?.groupId || !context?.userId) return false;
    return (await flows.getActiveFlow(...args(context)))?.flowId === FLOW_ID;
  }

  return { isAdministrator, mapFilters, listFeedbacks, formatList, viewFeedback, formatFeedback, stats, formatStats, startAction, handleAnswer, hasActiveFlow };
}

const service = createFeedbackAdministrationService();
module.exports = { ...service, createFeedbackAdministrationService, FLOW_ID };
