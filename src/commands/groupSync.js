"use strict";

const groupDirectoryServiceDefault = require("../services/groupDirectoryService");
const { logDetailedError } = require("../../utils/logger");

function createGroupSyncCommand(options = {}) {
  const groupDirectoryService = options.groupDirectoryService || groupDirectoryServiceDefault;
  return {
    name: "sincronizar grupos",
    aliases: ["sync grupos", "atualizar grupos"],
    ownerOnly: true,
    async execute(client, msg) {
    try {
      return msg.reply([
        "⚠️ A sincronização automática de nomes foi desativada.", "",
        "Para definir o nome de um grupo, entre nele e use:", "",
        "!registrar grupo Nome do Grupo", "",
        "No privado, também é possível usar:", "",
        "!nomear grupo NÚMERO | Novo Nome"
      ].join("\n"));
    } catch (error) {
      logDetailedError("Erro ao sincronizar nomes de grupos:", error);
      return msg.reply("❌ Não foi possível concluir esta ação agora.");
    }
    }
  };
}

const command = createGroupSyncCommand();
module.exports = { ...command, createGroupSyncCommand };
