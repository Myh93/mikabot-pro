"use strict";

const achievementServiceDefault = require("../services/playerAchievementService");
const identityService = require("../services/identityService");
const { createPlatformContext } = require("../utils/platformContext");
const { logDetailedError } = require("../../utils/logger");

function mentionedPlayer(msg, args) {
  const mentioned = msg?.mentionedIds?.[0] || msg?._data?.mentionedJidList?.[0];
  if (mentioned) return identityService.normalizeUserId(mentioned);
  const raw = String(args?.[0] || "").trim();
  return raw.startsWith("@") ? identityService.normalizeUserId(raw.slice(1)) : null;
}

function createPlayerAchievementsCommand(options = {}) {
  const achievementService = options.achievementService || achievementServiceDefault;
  async function execute(client, msg, args, loaderContext = {}) {
    const context = loaderContext.platformContext || await createPlatformContext(client, msg);
    try {
      const target = mentionedPlayer(msg, args) || context.userId;
      const summary = await achievementService.getPlayerAchievements({ platform: context.platform, groupId: context.groupId, playerId: target, isGroup: context.isGroup, displayContext: target === context.userId ? { msg, contact: loaderContext.contact, displayName: context.displayName } : {} });
      return context.replyText(achievementService.formatAchievements(summary));
    } catch (error) {
      logDetailedError("Erro ao consultar conquistas:", error);
      return context.replyText("❌ Não foi possível consultar as conquistas agora.");
    }
  }
  return { name: "conquistas", aliases: ["badges", "medalhas", "achievements"], execute };
}

const command = createPlayerAchievementsCommand();
module.exports = { ...command, createPlayerAchievementsCommand, mentionedPlayer };
