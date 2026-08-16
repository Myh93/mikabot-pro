"use strict";

const identityService = require("../services/identityService");
const { isGroupMessage } = require("./messageContext");

async function createPlatformContext(client, msg, options = {}) {
  if (!msg || typeof msg !== "object") throw new Error("Mensagem inválida para criação do contexto.");
  let chat = options.chat || null;
  if (!chat && typeof msg.getChat === "function") {
    try { chat = await msg.getChat(); } catch (_) { chat = null; }
  }
  const isGroup = await isGroupMessage(msg, chat || {});
  const identity = options.resolveContact === false
    ? {
        id: identityService.normalizeUserId(isGroup ? msg.author : msg.from),
        candidates: [identityService.normalizeUserId(isGroup ? msg.author : msg.from)].filter(Boolean),
        isLid: identityService.normalizeUserId(isGroup ? msg.author : msg.from).endsWith("@lid")
      }
    : await identityService.resolveIdentity(msg);
  const groupId = String(msg.from || "");
  const userId = identity.id || identityService.normalizeUserId(isGroup ? msg.author : msg.from);
  const messageId = msg.id?._serialized || msg.id?.id || msg.id || null;

  const context = {
    platform: "whatsapp",
    groupId,
    conversationId: groupId,
    userId,
    messageId: typeof messageId === "string" ? messageId : null,
    isGroup,
    identity,
    chat,
    message: msg,
    replyText: async (text) => msg.reply(String(text)),
    sendText: async (text) => client.sendMessage(groupId, String(text)),
    sendToGroup: async (targetGroupId, text) => client.sendMessage(targetGroupId, String(text)),
    sendPrivate: async (targetUserId, text) => client.sendMessage(targetUserId, String(text)),
    client
  };
  if (!isGroup && options.detectPrivateLinks !== false) {
    try { await require("../services/linkApprovalFlowService").handlePotentialPrivateLink(context, msg.body); } catch (_) { /* falha segura; comandos e fluxos existentes continuam */ }
  }
  return context;
}

function isCompletePlatformContext(context) {
  if (!context || typeof context !== "object") return false;
  return [context.platform, context.conversationId, context.userId]
    .every((value) => typeof value === "string" && value.trim().length > 0);
}

module.exports = { createPlatformContext, isCompletePlatformContext };
