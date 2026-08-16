"use strict";

const moderationDefault = require("../services/moderationService");
const flowDefault = require("../services/moderationBanFlowService");
const identityDefault = require("../services/identityService");
const { ensureMessageIdSerialized } = require("../services/whatsappClientHealthService");
const { isGroupMessage } = require("../utils/messageContext");
const GROUP_ONLY = "⚠️ Este comando funciona somente em grupos.";

function createModerationBanCommands(options = {}) {
  const moderation = options.moderationService || moderationDefault, flow = options.flowService || flowDefault, identities = options.identityService || identityDefault;
  const permitted = role => Boolean(role?.isOwner || role?.isAdmin || role?.isModerator || Number(role?.rank) >= 1);
  const contextOf = (msg, loader) => ({ platform: "whatsapp", groupId: msg.from, userId: loader.role?.identity?.id || identities.normalizeUserId(msg.author), isGroup: true, role: loader.role, replyText: text => msg.reply(text) });
  async function namesFor(items, msg) { return Promise.all(items.map(async item => { const resolved = await identities.resolveDisplayName(item.userId, { msg }); return { banId: item.banId, name: resolved === "Treinador" ? "Membro não identificado" : resolved, reason: item.reason, createdAt: item.createdAt }; })); }
  async function banidos(client, msg, args, loader) {
    if (!await isGroupMessage(msg, loader.chat)) return msg.reply(GROUP_ONLY); if (!permitted(loader.role)) return msg.reply("❌ Você não possui permissão para consultar banimentos.");
    const page = Number(args[0]) || 1, result = await moderation.listBannedPlayers({ groupId: msg.from, page });
    if (!result.total) return msg.reply("✅ Este grupo não possui banimentos ativos.");
    const named = await namesFor(result.items, msg), lines = named.map((item, index) => `${index + 1}. ${item.name}\n   Motivo: ${item.reason}\n   Data: ${new Date(item.createdAt).toLocaleDateString("pt-BR")}`);
    const started = await flow.startList(contextOf(msg, loader), named); lines.push("", `Página ${result.page} de ${result.totalPages}`); if (started?.conflict) lines.push("Conclua ou cancele a operação guiada atual antes de selecionar um banimento."); else lines.push("Responda com o número para remover um banimento ou 9 para cancelar."); await msg.reply(`🚫 MEMBROS BANIDOS\n\n${lines.join("\n")}`); return result;
  }
  async function desbanir(client, msg, args, loader) {
    if (!await isGroupMessage(msg, loader.chat)) return msg.reply(GROUP_ONLY); if (!permitted(loader.role)) return msg.reply("❌ Você não possui permissão para remover banimentos.");
    const typed = args.join(" "); if (typed && !msg.mentionedIds?.length && !msg._data?.mentionedJidList?.length) return msg.reply("❌ Mencione o membro, responda à mensagem dele ou selecione-o em !banidos.");
    let raw = msg.mentionedIds?.[0] || msg._data?.mentionedJidList?.[0]; if (!raw && msg.hasQuotedMsg && typeof msg.getQuotedMessage === "function") { if (!ensureMessageIdSerialized(msg).ok) return msg.reply("❌ Não foi possível consultar a mensagem respondida agora."); const quoted = await msg.getQuotedMessage(); raw = quoted?.author || quoted?.from; }
    if (!raw) return msg.reply("❌ Mencione o membro, responda à mensagem dele ou selecione-o em !banidos.");
    const ban = await options.repository?.getActiveBan?.(identities.normalizeUserId(msg.from), identities.normalizeUserId(raw)) || await require("../repositories/moderationRepository").getActiveBan(identities.normalizeUserId(msg.from), identities.normalizeUserId(raw));
    if (!ban) return msg.reply("✅ Este membro não possui banimento ativo neste grupo.");
    const name = await identities.resolveDisplayName(ban.userId, { msg }); await flow.startConfirmation(contextOf(msg, loader), { banId: ban.banId, name });
  }
  return [{ name: "banidos", aliases: ["bans", "listaban"], permissions: true, execute: banidos }, { name: "desbanir grupo", aliases: ["unban", "removerban"], permissions: true, execute: desbanir }];
}
module.exports = createModerationBanCommands();
module.exports.createModerationBanCommands = createModerationBanCommands;
