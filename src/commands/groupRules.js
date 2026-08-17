"use strict";

const rulesDefault = require("../services/groupRulesService");
const flowDefault = require("../services/groupRulesFlowService");
const { createPlatformContext, isCompletePlatformContext } = require("../utils/platformContext");

async function contextFor(client, msg, loader = {}) {
  const context = isCompletePlatformContext(loader.platformContext) ? loader.platformContext : await createPlatformContext(client, msg);
  return { ...context, chat: loader.chat || context.chat || null };
}

module.exports = {
  name: "administrar regras",
  aliases: ["gerenciar regras", "editar regras"],
  adminOnly: true,
  async execute(client, msg, args, loader = {}) {
    const context = await contextFor(client, msg, loader);
    if (!context.isGroup) return msg.reply("⚠️ A administração das regras deve ser aberta no grupo correspondente.");
    return flowDefault.start(context);
  }
};

module.exports.showRules = async function showRules(client, msg, loader = {}, service = rulesDefault) {
  const context = await contextFor(client, msg, loader);
  if (!context.isGroup) return msg.reply("⚠️ Consulte as regras no grupo correspondente.");
  const result = await service.getRules(context);
  return msg.reply(`📜 REGRAS OFICIAIS\n\n${result.value}`);
};
