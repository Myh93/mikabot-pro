"use strict";
const flowDefault = require("../services/linkApprovalFlowService");
const approvalDefault = require("../services/linkApprovalService");
const identitiesDefault = require("../services/identityService");
const { isGroupMessage } = require("../utils/messageContext");
const GROUP_TEXT = "🔗 Para solicitar a publicação de um link, envie o link no privado do MikaBot.";

function createLinkApprovalRequestCommands(options = {}) {
  const flow = options.flowService || flowDefault, approval = options.linkApprovalService || approvalDefault, identities = options.identityService || identitiesDefault;
  const context = (client, msg, loader = {}, isGroup = false) => ({ platform: "whatsapp", groupId: msg.from, userId: loader.identity?.id || identities.normalizeUserId(msg.from), messageId: msg.id?._serialized || msg.id?.id, isGroup, client, replyText: text => msg.reply(text) });
  async function request(client, msg, args, loader) { const inGroup = await isGroupMessage(msg, loader.chat); if (inGroup) return msg.reply(GROUP_TEXT); if (!args.length) return msg.reply("Envie uma URL HTTP ou HTTPS junto ao comando."); return flow.startRequest(context(client, msg, loader, inGroup), args.join(" "), context(client, msg, loader, inGroup).messageId); }
  async function mine(client, msg, args, loader) { const inGroup = await isGroupMessage(msg, loader.chat); if (inGroup) return msg.reply(GROUP_TEXT); const result = await approval.listRequesterLinkRequests({ requesterId: context(client, msg, loader, inGroup).userId, page: Number(args.at(-1)) || 1 }); if (!result.total) return msg.reply("Você ainda não possui solicitações de link."); const lines = result.items.map((item, index) => `${index + 1}. ${item.requestId}\n   Domínio: ${item.domain}\n   Status: ${item.status}\n   Criado: ${new Date(item.createdAt).toLocaleDateString("pt-BR")}`); return msg.reply(`🔗 MEUS LINKS\n\n${lines.join("\n\n")}\n\nPágina ${result.page} de ${result.totalPages}`); }
  async function cancel(client, msg, args, loader) { const inGroup = await isGroupMessage(msg, loader.chat); if (inGroup) return msg.reply(GROUP_TEXT); const id = String(args[0] || "").toUpperCase(); if (!/^LINK-\d{6}$/.test(id)) return msg.reply("Informe um protocolo válido, como LINK-000001."); const request = await approval.getLinkRequestForReview(id).catch(() => null); if (!request || !identities.identitiesMatch(request.requesterId, context(client, msg, loader, inGroup).userId)) return msg.reply("Solicitação não encontrada."); if (request.status !== "pending") return msg.reply("Somente solicitações pendentes podem ser canceladas."); return flow.startCancel(context(client, msg, loader, inGroup), request); }
  return [
    { name: "enviarlink", aliases: ["solicitarlink", "pedirlink", "linkaprovacao", "aprovarlink"], permissions: true, execute: request },
    { name: "meuslinks", aliases: ["links enviados", "minhassolicitacoes"], permissions: true, execute: mine },
    { name: "cancelarlink", aliases: ["cancelarpedido", "cancelarsolicitacao"], permissions: true, execute: cancel }
  ];
}
module.exports = createLinkApprovalRequestCommands(); module.exports.createLinkApprovalRequestCommands = createLinkApprovalRequestCommands;
