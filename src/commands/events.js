"use strict";

const eventServiceDefault = require("../services/eventService");
const menuRegistryDefault = require("../services/menuRegistry");
const { createPlatformContext } = require("../utils/platformContext");
const { logDetailedError } = require("../../utils/logger");
const eventGuidedFlowDefault = require("../services/eventGuidedFlowService");
const permissionServiceDefault = require("../services/permissionService");
const eventMessageFormatterDefault = require("../services/eventMessageFormatter");

const ALIASES = [
  "eventos", "criar evento", "evento criar", "editar evento", "evento editar", "cancelar evento", "evento cancelar",
  "publicar evento", "evento publicar", "listar eventos", "eventos ativos", "proximos eventos", "proximo evento",
  "ver evento", "evento ver", "finalizar evento", "encerrar evento", "arquivar evento", "evento arquivar",
  "historico eventos", "eventos historico", "eventos agendados", "cancelar", "voltar", "sair"
];

function createEventsCommand(options = {}) {
  const eventService = options.eventService || eventServiceDefault;
  const menuRegistry = options.menuRegistry || menuRegistryDefault;
  const guidedFlow = options.eventGuidedFlow || eventGuidedFlowDefault;
  const permissionService = options.permissionService || permissionServiceDefault;
  const messageFormatter = options.messageFormatter || eventMessageFormatterDefault;

  async function buildContext(client, msg, loaderContext) {
    const platformContext = loaderContext.platformContext || await createPlatformContext(client, msg);
    const role = loaderContext.role || await menuRegistry.resolveRole(client, msg, loaderContext);
    return { ...platformContext, role, identity: loaderContext.identity || platformContext.identity };
  }

  async function buildPrivateContext(client, msg, loaderContext) {
    const platformContext = loaderContext.platformContext || await createPlatformContext(client, msg);
    const role = loaderContext.role || await permissionService.resolveRole({ client, msg, identity: platformContext.identity });
    return { ...platformContext, conversationId: platformContext.groupId, role };
  }

  function creationResponse(event) {
    return `${messageFormatter.formatPrivateConfirmation(event, { status: event.status })}\n\nUse:\n!publicar evento ${event.id}`;
  }

  async function execute(client, msg, args, loaderContext = {}) {
    const commandName = loaderContext.commandName || "evento";
    try {
      const isPrivate = typeof msg.from === "string" && !msg.from.endsWith("@g.us");
      if (["evento", "eventos"].includes(commandName)) return menuRegistry.openMenuFromCommand(isPrivate ? "events_private" : "events", client, msg, loaderContext);
      if (isPrivate) {
        const privateContext = await buildPrivateContext(client, msg, loaderContext);
        if (["cancelar", "voltar", "sair"].includes(commandName)) return guidedFlow.handleControl(commandName, privateContext);
        if (["criar evento", "evento criar"].includes(commandName)) return guidedFlow.startCreateFlow(client, privateContext, privateContext.role);
        if (["editar evento", "evento editar"].includes(commandName) && !args.length) return guidedFlow.startActionFlow("edit_event", client, privateContext, privateContext.role);
        if (["publicar evento", "evento publicar"].includes(commandName) && !args.length) return guidedFlow.startActionFlow("publish_event", client, privateContext, privateContext.role);
        if (["cancelar evento", "evento cancelar"].includes(commandName) && !args.length) return guidedFlow.startActionFlow("cancel_event", client, privateContext, privateContext.role);
        if (["finalizar evento", "encerrar evento"].includes(commandName) && !args.length) return guidedFlow.startActionFlow("finish_event", client, privateContext, privateContext.role);
        if (["arquivar evento", "evento arquivar"].includes(commandName) && !args.length) return guidedFlow.startActionFlow("archive_event", client, privateContext, privateContext.role);
        if (commandName === "eventos agendados") {
          const manageable = await guidedFlow.manageableEvents(client, privateContext, privateContext.role, ["scheduled", "published", "running"]);
          return privateContext.replyText(eventService.formatEventList(manageable.list.filter((event) => ["upcoming", "active"].includes(eventService.resolveLifecycleStatus(event))), "📅 EVENTOS AGENDADOS"));
        }
        if (["listar eventos", "eventos ativos"].includes(commandName)) {
          const manageable = await guidedFlow.manageableEvents(client, privateContext, privateContext.role, ["draft", "scheduled", "published", "running"]);
          manageable.list = manageable.list.filter((event) => event.status === "draft" || ["upcoming", "active"].includes(eventService.resolveLifecycleStatus(event)));
          return privateContext.replyText(guidedFlow.formatGroupedEvents(manageable, "📅 *EVENTOS GERENCIÁVEIS*"));
        }
        if (["proximos eventos", "proximo evento"].includes(commandName)) {
          const manageable = await guidedFlow.manageableEvents(client, privateContext, privateContext.role, ["scheduled", "published"], { futureOnly: true });
          return privateContext.replyText(guidedFlow.formatGroupedEvents(manageable, "📅 *PRÓXIMOS EVENTOS*"));
        }
        if (["ver evento", "evento ver"].includes(commandName)) {
          if (!args[0]) return guidedFlow.startActionFlow("view_event", client, privateContext, privateContext.role);
          const event = await guidedFlow.getManageableEvent(client, privateContext, privateContext.role, args[0]);
          return privateContext.replyText(eventService.formatEvent(event));
        }
        if (["historico eventos", "eventos historico"].includes(commandName)) {
          const manageable = await guidedFlow.manageableEvents(client, privateContext, privateContext.role);
          manageable.list = manageable.list.filter((event) => ["finished", "cancelled", "archived", "past"].includes(eventService.resolveLifecycleStatus(event)));
          const canSeeHistory = privateContext.role?.isOwner || privateContext.role?.isProtectedOwner || manageable.groups.some((group) => group.isAdmin);
          if (!canSeeHistory) return privateContext.replyText("❌ Apenas administradores e owners podem consultar o histórico.");
          return privateContext.replyText(eventService.formatEventList(manageable.list, "📚 HISTÓRICO DE EVENTOS"));
        }
      }
      const context = await buildContext(client, msg, loaderContext);

      if (!["evento", "eventos"].includes(commandName) && !args.length) {
        if (["criar evento", "evento criar"].includes(commandName)) return guidedFlow.startCreateFlow(client, context, context.role);
        if (["editar evento", "evento editar"].includes(commandName)) return guidedFlow.startActionFlow("edit_event", client, context, context.role);
        if (["publicar evento", "evento publicar"].includes(commandName)) return guidedFlow.startActionFlow("publish_event", client, context, context.role);
        if (["cancelar evento", "evento cancelar"].includes(commandName)) return guidedFlow.startActionFlow("cancel_event", client, context, context.role);
        if (["finalizar evento", "encerrar evento"].includes(commandName)) return guidedFlow.startActionFlow("finish_event", client, context, context.role);
        if (["arquivar evento", "evento arquivar"].includes(commandName)) return guidedFlow.startActionFlow("archive_event", client, context, context.role);
        if (["ver evento", "evento ver"].includes(commandName)) return guidedFlow.startActionFlow("view_event", client, context, context.role);
      }

      if (["criar evento", "evento criar"].includes(commandName)) {
        const fields = args.join(" ").split("|").map((value) => value.trim());
        const event = await eventService.createEvent({ title: fields[0], description: fields[1], date: fields[2], time: fields[3] }, context);
        return context.replyText(creationResponse(event));
      }

      if (["editar evento", "evento editar"].includes(commandName)) {
        const [id, field, ...valueParts] = args;
        if (!id || !field || !valueParts.length) return context.replyText("❌ Use: !editar evento E0001 titulo Novo título");
        const event = await eventService.updateEvent(id, field, valueParts.join(" "), context);
        return context.replyText(`✅ Evento ${event.id} atualizado.\n\n${eventService.formatEvent(event)}`);
      }

      if (["cancelar evento", "evento cancelar"].includes(commandName)) {
        if (!args[0]) return context.replyText("❌ Use: !cancelar evento E0001");
        const event = await eventService.cancelEvent(args[0], context);
        return context.replyText(`✅ Evento ${event.id} cancelado.`);
      }

      if (["publicar evento", "evento publicar"].includes(commandName)) {
        if (!args[0]) return context.replyText("❌ Use: !publicar evento E0001");
        const event = await eventService.publishEvent(args[0], context, (groupId, text) => client.sendMessage(groupId, text));
        return context.replyText(`✅ Evento ${event.id} publicado.`);
      }

      if (["listar eventos", "eventos ativos"].includes(commandName)) return context.replyText(eventService.formatEventList(await eventService.listEvents(context)));
      if (["proximos eventos", "proximo evento"].includes(commandName)) return context.replyText(eventService.formatEventList(await eventService.listUpcomingEvents(context), "📅 PRÓXIMOS EVENTOS"));

      if (["ver evento", "evento ver"].includes(commandName)) {
        if (!args[0]) return context.replyText("❌ Use: !ver evento E0001");
        return context.replyText(eventService.formatEvent(await eventService.getEvent(args[0], context)));
      }

      if (["finalizar evento", "encerrar evento"].includes(commandName)) {
        if (!args[0]) return context.replyText("❌ Use: !finalizar evento E0001");
        const event = await eventService.finishEvent(args[0], context);
        return context.replyText(`✅ Evento ${event.id} finalizado.`);
      }

      if (["arquivar evento", "evento arquivar"].includes(commandName)) {
        if (!args[0]) return context.replyText("❌ Use: !arquivar evento E0001");
        const event = await eventService.archiveEvent(args[0], context);
        return context.replyText(`✅ Evento ${event.id} arquivado.`);
      }

      if (["historico eventos", "eventos historico"].includes(commandName)) return context.replyText(eventService.formatEventList(await eventService.listEventHistory(context), "📚 HISTÓRICO DE EVENTOS"));
    } catch (error) {
      if (error?.code) return msg.reply(error.message);
      logDetailedError(`Erro no comando ${commandName}:`, error);
      return msg.reply("❌ Não foi possível concluir esta ação agora.");
    }
  }

  return { name: "evento", aliases: ALIASES, execute };
}

const command = createEventsCommand();
module.exports = { ...command, createEventsCommand, ALIASES };
