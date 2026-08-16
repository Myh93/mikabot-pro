"use strict";

const lifecycleDefault = require("../services/memberDataLifecycleService");
const flowDefault = require("../services/memberDataAdministrationFlowService");
const { createPlatformContext } = require("../utils/platformContext");

function createMemberDataCommands(options = {}) {
  const lifecycle = options.memberDataLifecycleService || lifecycleDefault;
  const flow = options.memberDataAdministrationFlowService || flowDefault;

  function target(msg, args) {
    return msg.mentionedIds?.[0] || msg._data?.mentionedJidList?.[0] || (/@(?:lid|c\.us)$/i.test(String(args[0] || "")) ? args[0] : null);
  }

  async function context(client, msg, loaderContext) {
    const platform = loaderContext.platformContext || await createPlatformContext(client, msg);
    return { ...platform, conversationId: platform.conversationId || platform.groupId, role: loaderContext.role };
  }

  const removal = action => async (client, msg, args, loaderContext = {}) => {
    const targetId = target(msg, args);
    if (!targetId) return msg.reply("❌ Mencione o usuário que será removido.");
    const result = await flow.start(await context(client, msg, loaderContext), action, targetId);
    if (result.status === "not_found") return msg.reply("❌ Usuário não encontrado.");
    if (result.status === "conflict") return msg.reply("⚠️ Conclua ou cancele o fluxo guiado atual.");
    return result;
  };

  async function status(client, msg, args) {
    const targetId = target(msg, args);
    if (!targetId) return msg.reply("❌ Mencione o usuário consultado.");
    const value = await lifecycle.getStatus(targetId);
    if (value.status === "not_found") return msg.reply("❌ Usuário não encontrado.");
    return msg.reply(["📋 STATUS DO MEMBRO", "", `Estado: ${value.active ? "Ativo" : "Inativo"}`, `Grupos ativos: ${value.activeGroups}`, `Telegram ativo: ${value.telegramActive ? "Sim" : "Não"}`, `Saída registrada: ${value.lastLeaveAt || "Não"}`, `Remoção agendada: ${value.pendingRemovalAt || "Não"}`, `Dias restantes: ${value.daysRemaining ?? "Não aplicável"}`, `Motivo de preservação: ${value.preservationReason || "Nenhum"}`].join("\n"));
  }

  async function preserve(client, msg, args, loaderContext = {}) {
    const targetId = target(msg, args);
    if (!targetId) return msg.reply("❌ Mencione o usuário preservado.");
    const actor = loaderContext.role?.identity?.id || msg.author || msg.from;
    const result = await lifecycle.preserveMember(targetId, { executor: actor, reason: args.slice(1).join(" ") || "manual" });
    return msg.reply(result.status === "preserved" ? "✅ Exclusão agendada cancelada." : "❌ Usuário não encontrado.");
  }

  return [
    { name: "apagarmembro", aliases: [], adminOnly: true, execute: removal("remove_member") },
    { name: "apagarcadastro", aliases: [], adminOnly: true, execute: removal("remove_registration") },
    { name: "resetquiz", aliases: [], adminOnly: true, execute: removal("reset_quiz") },
    { name: "statusmembro", aliases: [], adminOnly: true, execute: status },
    { name: "preservarmembro", aliases: [], adminOnly: true, execute: preserve }
  ];
}

module.exports = createMemberDataCommands();
module.exports.createMemberDataCommands = createMemberDataCommands;
