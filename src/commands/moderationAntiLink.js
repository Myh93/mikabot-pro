"use strict";

const moderationDefault = require("../services/moderationService");
const { isGroupMessage } = require("../utils/messageContext");
const GROUP_ONLY = "⚠️ Este comando funciona somente em grupos.";

function createModerationAntiLinkCommands(options = {}) {
  const moderation = options.moderationService || moderationDefault;
  const canConfigure = role => Boolean(role?.isOwner || role?.isAdmin || Number(role?.rank) >= 2);
  async function guard(msg, loader) { if (!await isGroupMessage(msg, loader.chat)) { await msg.reply(GROUP_ONLY); return false; } if (!canConfigure(loader.role)) { await msg.reply("❌ Somente o dono ou administradores podem alterar esta configuração."); return false; } return true; }
  async function antiLink(client, msg, args, loader) { if (!await guard(msg, loader)) return; const value = String(args[0] || "").toLowerCase(); if (!['on','off'].includes(value)) return msg.reply("❌ Use !antilink on ou !antilink off."); const enabled = value === "on"; await moderation.updateGroupConfig(msg.from, { settings: { antiLink: { enabled } } }); return msg.reply(`✅ Antilink: ${enabled ? "ATIVADO" : "DESATIVADO"}.`); }
  async function action(client, msg, args, loader) { if (!await guard(msg, loader)) return; const map = { avisar: "notify_admins", remover: "remove_member", banir: "ban_and_remove" }, finalAction = map[String(args[0] || "").toLowerCase()]; if (!finalAction) return msg.reply("❌ Use avisar, remover ou banir."); await moderation.updateGroupConfig(msg.from, { settings: { warnings: { enabled: true, finalAction }, ban: { enabled: finalAction === "ban_and_remove" } } }); return msg.reply(`✅ Ação final: ${finalAction === "notify_admins" ? "AVISAR" : finalAction === "remove_member" ? "REMOVER" : "BANIR E REMOVER"}.`); }
  async function limit(client, msg, args, loader) { if (!await guard(msg, loader)) return; const limit = Number(args[0]); if (!Number.isInteger(limit) || limit < 1) return msg.reply("❌ Informe um limite inteiro igual ou maior que 1."); await moderation.updateGroupConfig(msg.from, { settings: { warnings: { limit } } }); return msg.reply(`✅ Limite de advertências: ${limit}.`); }
  async function reentry(client, msg, args, loader) { if (!await guard(msg, loader)) return; const value = String(args[0] || "").toLowerCase(); if (!['on','off'].includes(value)) return msg.reply("❌ Use !banreentrada on ou !banreentrada off."); const enabled = value === "on"; await moderation.updateGroupConfig(msg.from, { settings: { ban: { blockReentry: enabled } } }); return msg.reply(`✅ Bloqueio de reentrada: ${enabled ? "ATIVADO" : "DESATIVADO"}.`); }
  async function approval(client, msg, args, loader) { if (!await guard(msg, loader)) return; const value=String(args[0]||"").toLowerCase(); if(!['on','off'].includes(value)) return msg.reply("❌ Use !aprovacaolink on ou !aprovacaolink off."); const enabled=value==="on"; await moderation.updateGroupConfig(msg.from,{settings:{approval:{enabled}}}); return msg.reply(`✅ Aprovação de links: ${enabled?"ATIVADA":"DESATIVADA"}.`); }
  return [
    { name: "antilink", aliases: [], permissions: true, execute: antiLink },
    { name: "acaoavisos", aliases: [], permissions: true, execute: action },
    { name: "limiteavisos", aliases: [], permissions: true, execute: limit },
    { name: "banreentrada", aliases: [], permissions: true, execute: reentry },
    { name: "aprovacaolink", aliases: ["linksaprovacao"], permissions: true, execute: approval }
  ];
}
module.exports = createModerationAntiLinkCommands();
module.exports.createModerationAntiLinkCommands = createModerationAntiLinkCommands;
