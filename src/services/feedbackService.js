"use strict";

const repositoryDefault = require("../repositories/feedbackRepository");
const flowsDefault = require("./guidedFlowService");
const inputDefault = require("./inputResolverService");
const memberJourneyDefault = require("./memberJourneyService");

const FLOW_ID = "feedback_create";
const TYPES = new Set(["ERROR", "SUGGESTION", "IMPROVEMENT", "QUESTION"]);
const STATUS_LABELS = {
  NEW: "NOVO", OPEN: "ABERTO", IN_PROGRESS: "EM ANDAMENTO",
  RESOLVED: "RESOLVIDO", REJECTED: "REJEITADO"
};

function createFeedbackService(options = {}) {
  const repository = options.repository || repositoryDefault;
  const flows = options.guidedFlowService || flowsDefault;
  const input = options.inputResolverService || inputDefault;
  const notifier = options.notifier || null;
  const memberJourney = options.memberJourneyService || (options.repository ? { grant: async () => ({ granted: false }) } : memberJourneyDefault);
  const args = context => [
    context.platform || "whatsapp",
    context.conversationId || context.groupId,
    context.userId
  ];
  const isAdmin = actor => {
    const role = actor?.role || actor || {};
    return Boolean(
      role.isOwner || role.isProtectedOwner || role.isAdmin ||
      ["owner", "protectedOwner", "admin"].includes(role.name) ||
      Number(role.rank) >= 2
    );
  };
  const requireAdmin = actor => {
    if (!isAdmin(actor)) {
      const error = new Error("Somente administradores podem alterar feedbacks.");
      error.code = "FEEDBACK_FORBIDDEN";
      throw error;
    }
  };

  async function notify(item, context = {}) {
    const send = context.sendPrivate || notifier ||
      (context.client?.sendMessage ? (id, text) => context.client.sendMessage(id, text) : null);
    if (!send || !item.autor) return false;
    const text = [
      `📬 Seu feedback ${item.id} foi atualizado.`, "",
      "Status:", STATUS_LABELS[item.status] || item.status,
      ...(item.resposta ? ["", "Resposta:", item.resposta] : [])
    ].join("\n");
    await send(item.autor, text);
    return true;
  }

  async function createFeedback(inputData) {
    const tipo = String(inputData.tipo || "").toUpperCase();
    const descricao = String(inputData.descricao || "").trim();
    if (!TYPES.has(tipo)) throw new Error("Tipo de feedback inválido.");
    if (!descricao) throw new Error("Descrição do feedback é obrigatória.");
    const created = await repository.createFeedback({ ...inputData, tipo, descricao });
    if (created?.autor) await memberJourney.grant(created.autor, "first_feedback", { platform: created.plataforma || "whatsapp", groupId: created.grupo || null });
    return created;
  }

  async function getFeedback(id, actor = {}) {
    const item = await repository.getFeedback(id);
    if (!item) return null;
    if (!isAdmin(actor) && item.autor !== actor.userId && item.autor !== actor.autor) {
      const error = new Error("Você não pode consultar este protocolo.");
      error.code = "FEEDBACK_FORBIDDEN";
      throw error;
    }
    return item;
  }

  async function listFeedbacks(filters = {}, actor = {}) {
    if (isAdmin(actor)) return repository.listFeedbacks(filters);
    const author = actor.userId || actor.autor;
    if (!author) throw Object.assign(new Error("Autor obrigatório."), { code: "FEEDBACK_FORBIDDEN" });
    return repository.listFeedbacks({ ...filters, autor: author });
  }

  async function updateFeedback(id, changes, actor = {}) {
    requireAdmin(actor);
    return repository.updateFeedback(id, changes);
  }

  async function addResponse(id, response, actor = {}, context = {}) {
    requireAdmin(actor);
    const current = await repository.getFeedback(id);
    if (!current) return null;
    const item = await repository.updateFeedback(id, {
      resposta: String(response || "").trim(),
      status: ["NEW", "OPEN"].includes(current.status) ? "IN_PROGRESS" : current.status
    });
    await notify(item, context);
    return item;
  }

  async function resolveFeedback(id, actor = {}, response = null, context = {}) {
    requireAdmin(actor);
    const item = await repository.updateFeedback(id, {
      status: "RESOLVED", resposta: response ?? (await repository.getFeedback(id))?.resposta ?? null,
      resolvedAt: new Date().toISOString(), resolvedBy: actor.userId || actor.id || "admin"
    });
    if (item) await notify(item, context);
    return item;
  }

  async function rejectFeedback(id, actor = {}, response = null, context = {}) {
    requireAdmin(actor);
    const item = await repository.updateFeedback(id, {
      status: "REJECTED", resposta: response ?? (await repository.getFeedback(id))?.resposta ?? null,
      resolvedAt: new Date().toISOString(), resolvedBy: actor.userId || actor.id || "admin"
    });
    if (item) await notify(item, context);
    return item;
  }

  function menu() {
    return ["🤝 AJUDA E FEEDBACK", "", "1️⃣ Reportar erro", "2️⃣ Fazer sugestão", "3️⃣ Tirar dúvida", "0️⃣ Cancelar"].join("\n");
  }

  async function start(context) {
    const existing = await flows.getActiveFlow(...args(context));
    if (existing?.flowId === FLOW_ID) {
      await context.replyText(existing.step === "description" ? "📝 Descreva o máximo possível." : menu());
      return { status: "resumed", session: existing };
    }
    if (existing) return { status: "conflict", session: existing };
    const result = await flows.startFlow({
      flowId: FLOW_ID, platform: context.platform || "whatsapp",
      conversationId: context.conversationId || context.groupId, userId: context.userId,
      step: "type", data: {
        author: context.userId, community: context.communityId || null,
        group: context.isGroup ? context.groupId : null
      }
    });
    await context.replyText(menu());
    return { status: "started", session: result.session };
  }

  async function cancel(context) {
    await flows.cancelFlow(...args(context));
    await context.replyText("❌ Feedback cancelado.");
    return { status: "cancelled" };
  }

  async function handleAnswer(context, text) {
    const session = await flows.getActiveFlow(...args(context));
    if (session?.flowId !== FLOW_ID) return { status: "ignored" };
    const navigation = input.resolveNavigation(text);
    if (["cancel", "menu", "back"].includes(navigation)) return cancel(context);
    if (session.step === "type") {
      const type = input.resolveMenuOption(text, [
        { value: "ERROR", number: 1, aliases: ["erro", "reportar erro"] },
        { value: "SUGGESTION", number: 2, aliases: ["sugestao", "sugestão", "melhoria"] },
        { value: "QUESTION", number: 3, aliases: ["duvida", "dúvida"] }
      ]);
      if (!type) { await context.replyText(menu()); return { status: "validation_error" }; }
      const updated = await flows.advanceFlow(...args(context), "description", { tipo: type });
      await context.replyText("📝 Descreva o máximo possível.");
      return { status: "description", session: updated };
    }
    if (session.step === "description") {
      const description = String(text || "").trim();
      if (!description) { await context.replyText("📝 Descreva o máximo possível."); return { status: "validation_error" }; }
      const updated = await flows.advanceFlow(...args(context), "confirm", { descricao: description });
      await context.replyText(["📋 Confirmar envio", "", "1️⃣ Enviar", "2️⃣ Editar", "3️⃣ Cancelar"].join("\n"));
      return { status: "confirm", session: updated };
    }
    const choice = input.resolveMenuOption(text, [
      { value: "send", number: 1, aliases: ["enviar", "confirmar"] },
      { value: "edit", number: 2, aliases: ["editar"] },
      { value: "cancel", number: 3, aliases: ["cancelar"] }
    ]);
    if (choice === "edit") {
      const updated = await flows.advanceFlow(...args(context), "description", {});
      await context.replyText("📝 Descreva o máximo possível.");
      return { status: "edit", session: updated };
    }
    if (choice === "cancel") return cancel(context);
    if (choice !== "send") return { status: "validation_error" };
    const item = await createFeedback({
      tipo: session.data.tipo, descricao: session.data.descricao,
      autor: session.data.author, plataforma: context.platform || "whatsapp",
      comunidade: session.data.community, grupo: session.data.group
    });
    await flows.finishFlow(...args(context));
    await context.replyText(["✅ Feedback enviado.", "", "Protocolo:", item.id, "", "Obrigado por ajudar a melhorar o MikaBot."].join("\n"));
    return { status: "created", feedback: item };
  }

  async function hasActiveFlow(context) {
    if (!context?.groupId || !context?.userId) return false;
    return (await flows.getActiveFlow(...args(context)))?.flowId === FLOW_ID;
  }

  return { createFeedback, getFeedback, listFeedbacks, updateFeedback, resolveFeedback, rejectFeedback, addResponse, start, handleAnswer, hasActiveFlow };
}

const service = createFeedbackService();
module.exports = { ...service, createFeedbackService, FLOW_ID, TYPES, STATUS_LABELS };
