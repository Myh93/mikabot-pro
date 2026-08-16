"use strict";

const rankingServiceDefault = require("../services/playerRankingService");
const { createPlatformContext } = require("../utils/platformContext");
const { logDetailedError } = require("../../utils/logger");

const ALIASES = ["top", "ranking grupo", "top grupo", "ranking global", "top global", "ranking semanal", "top semanal", "ranking mensal", "top mensal", "ranking quiz", "ranking quiz grupo", "ranking quiz global", "ranking quiz semanal", "ranking quiz mensal"];

function createPlayerRankingCommand(options = {}) {
  const rankingService = options.rankingService || rankingServiceDefault;
  async function execute(client, msg, args, loaderContext = {}) {
    const context = loaderContext.platformContext || await createPlatformContext(client, msg);
    const commandName = String(loaderContext.commandName || "ranking").toLowerCase();
    try {
      if (!context.isGroup && ["ranking", "top"].includes(commandName) && !args.length) return context.replyText("🏆 *RANKINGS DO QUIZ*\n\nUse:\n!ranking global\n!ranking semanal\n!ranking mensal");
      const words = commandName.split(/\s+/);
      let type = words.includes("global") ? "global" : words.includes("semanal") ? "weekly" : words.includes("mensal") ? "monthly" : "group";
      let pageArg = args[0];
      if (["grupo", "global", "semanal", "mensal"].includes(String(args[0] || "").toLowerCase())) {
        const requested = args.shift().toLowerCase(); type = { grupo: "group", global: "global", semanal: "weekly", mensal: "monthly" }[requested]; pageArg = args[0];
      }
      const page = pageArg === undefined ? 1 : Number(pageArg);
      const groupId = context.isGroup && type !== "global" ? context.groupId : null;
      const text = await rankingService.renderRanking({ type, platform: context.platform, groupId, page });
      return context.replyText(text);
    } catch (error) {
      logDetailedError("Erro ao consultar ranking do Quiz:", error);
      return context.replyText("❌ Não foi possível consultar o ranking agora.");
    }
  }
  return { name: "ranking", aliases: ALIASES, execute };
}

const command = createPlayerRankingCommand();
module.exports = { ...command, createPlayerRankingCommand, ALIASES };
