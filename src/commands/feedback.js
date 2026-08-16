"use strict";

const feedbackService = require("../services/feedbackService");
const feedbackAdministrationService = require("../services/feedbackAdministrationService");
const permissionService = require("../services/permissionService");
const { createPlatformContext } = require("../utils/platformContext");

module.exports = {
  name: "feedback",
  aliases: ["ajuda", "reportar erro", "sugestao", "sugestão"],
  async execute(client, msg, args, loaderContext = {}) {
    const context = loaderContext.platformContext || await createPlatformContext(client, msg);
    const operation = String(args[0] || "").toLocaleLowerCase("pt-BR");
    const isAdministrativeOperation = ["stats", "ver", "responder", "resolver", "rejeitar"].includes(operation);
    let role = loaderContext.role;
    if (isAdministrativeOperation && !role) {
      try {
        const contact = loaderContext.contact || await msg.getContact();
        const chat = loaderContext.chat || await msg.getChat();
        role = await permissionService.resolveRole({ msg, client, chat, contact });
      } catch (_) {
        return context.replyText("❌ Não foi possível validar sua permissão administrativa agora.");
      }
    }
    const administrationContext = {
      ...context,
      client,
      conversationId: context.groupId,
      role
    };
    if (operation === "stats") {
      try {
        const value = await feedbackAdministrationService.stats(administrationContext);
        return context.replyText(feedbackAdministrationService.formatStats(value));
      } catch (error) {
        if (error.code === "FEEDBACK_ADMIN_FORBIDDEN") return context.replyText("❌ Apenas owners e administradores autorizados podem usar este comando.");
        throw error;
      }
    }
    if (["ver", "responder", "resolver", "rejeitar"].includes(operation)) {
      const id = String(args[1] || "").toUpperCase();
      if (!/^FB\d{6}$/.test(id)) return context.replyText("❌ Informe um protocolo válido, como FB000123.");
      try {
        if (operation === "ver") {
          const item = await feedbackAdministrationService.viewFeedback(administrationContext, id);
          return context.replyText(feedbackAdministrationService.formatFeedback(item));
        }
        const actions = { responder: "respond", resolver: "resolve", rejeitar: "reject" };
        const result = await feedbackAdministrationService.startAction(administrationContext, actions[operation], id);
        if (result.status === "not_found") return context.replyText("❌ Protocolo não encontrado.");
        if (result.status === "conflict") return context.replyText("⚠️ Conclua ou cancele o fluxo guiado atual antes de continuar.");
        return result;
      } catch (error) {
        if (error.code === "FEEDBACK_ADMIN_FORBIDDEN") return context.replyText("❌ Apenas owners e administradores autorizados podem usar este comando.");
        throw error;
      }
    }
    const protocol = String(args[0] || "").toUpperCase();
    if (/^FB\d{6}$/.test(protocol)) {
      try {
        const item = await feedbackService.getFeedback(protocol, {
          userId: context.userId,
          role: loaderContext.role
        });
        if (!item) return context.replyText("❌ Protocolo não encontrado.");
        return context.replyText([
          `📋 ${item.id}`, `Tipo: ${item.tipo}`, `Status: ${item.status}`,
          "", item.descricao,
          ...(item.resposta ? ["", "Resposta:", item.resposta] : [])
        ].join("\n"));
      } catch (error) {
        if (error.code === "FEEDBACK_FORBIDDEN") return context.replyText("❌ Você não pode consultar este protocolo.");
        throw error;
      }
    }
    return feedbackService.start({ ...context, conversationId: context.groupId });
  }
};
