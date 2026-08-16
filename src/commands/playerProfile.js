"use strict";

const profileServiceDefault = require("../services/playerProfileService");
const identityService = require("../services/identityService");
const { createPlatformContext } = require("../utils/platformContext");
const { logDetailedError } = require("../../utils/logger");

function mentionedPlayer(msg, args) {
  const mentioned = msg?.mentionedIds?.[0] || msg?._data?.mentionedJidList?.[0];
  if (mentioned) return identityService.normalizeUserId(mentioned);
  const raw = String(args?.[0] || "").trim();
  if (!raw.startsWith("@")) return null;
  return identityService.normalizeUserId(raw.slice(1));
}

function createPlayerProfileCommand(options = {}) {
  const profileService = options.profileService || profileServiceDefault;
  async function execute(client, msg, args, loaderContext = {}) {
    const context = loaderContext.platformContext || await createPlatformContext(client, msg);
    try {
      const mentioned = mentionedPlayer(msg, args);
      const playerId = mentioned || context.userId;
      const profile = await profileService.getPlayerProfile({ platform: context.platform, groupId: context.groupId, playerId, isGroup: context.isGroup, displayContext: mentioned ? {} : { msg, contact: loaderContext.contact, displayName: context.displayName } });
      return context.replyText(profileService.formatProfile(profile));
    } catch (error) {
      logDetailedError("Erro ao consultar perfil do jogador:", error);
      return context.replyText("❌ Não foi possível consultar o perfil agora.");
    }
  }
  return { name: "perfil", aliases: ["me", "player", "trainer"], execute };
}

const command = createPlayerProfileCommand();
module.exports = { ...command, createPlayerProfileCommand, mentionedPlayer };
