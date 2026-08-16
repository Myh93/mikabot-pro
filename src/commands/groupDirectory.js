"use strict";

const groupDirectoryServiceDefault = require("../services/groupDirectoryService");
const { logDetailedError } = require("../../utils/logger");

function createGroupDirectoryCommands(options = {}) {
  const directory = options.groupDirectoryService || groupDirectoryServiceDefault;
  return [
    {
      name: "grupos", aliases: [], ownerOnly: true,
      async execute(client, msg) {
        try {
          const groups = await directory.listActiveGroups("whatsapp");
          if (!groups.length) return msg.reply("📂 Ainda não há grupos cadastrados.");
          const lines = groups.map((group, index) => `${index + 1}️⃣ ${directory.formatGroupDisplayName(group)}`);
          return msg.reply(["📂 *GRUPOS CADASTRADOS*", "", ...lines].join("\n"));
        } catch (error) {
          logDetailedError("Erro ao listar diretório de grupos:", error);
          return msg.reply("❌ Não foi possível concluir esta ação agora.");
        }
      }
    },
    {
      name: "nomear grupo", aliases: [], ownerOnly: true,
      async execute(client, msg, args) {
        try {
          const [positionText, ...nameParts] = args.join(" ").split("|");
          const name = nameParts.join("|").trim();
          if (!positionText?.trim() || !name) return msg.reply("❌ Use: !nomear grupo 1 | Nome amigável");
          const group = await directory.setManualNameByPosition(positionText.trim(), name);
          if (!group) return msg.reply("❌ Opção de grupo inválida.");
          return msg.reply(`✅ Grupo atualizado.\n\n📂 Nome: ${group.name}`);
        } catch (error) {
          logDetailedError("Erro ao nomear grupo:", error);
          return msg.reply("❌ Não foi possível concluir esta ação agora.");
        }
      }
    },
    {
      name: "registrar grupo", aliases: [], ownerOnly: true,
      async execute(client, msg, args) {
        try {
          const groupId = typeof msg.from === "string" && msg.from.endsWith("@g.us") ? msg.from : null;
          const name = args.join(" ").trim();
          if (!groupId) return msg.reply("❌ Use este comando dentro do grupo que deseja registrar.");
          if (!name) return msg.reply("❌ Use: !registrar grupo Nome amigável");
          const group = await directory.setManualName(groupId, name);
          return msg.reply(`✅ Grupo registrado como:\n${group.name}`);
        } catch (error) {
          logDetailedError("Erro ao registrar grupo manualmente:", error);
          return msg.reply("❌ Não foi possível concluir esta ação agora.");
        }
      }
    }
  ];
}

const commands = createGroupDirectoryCommands();
module.exports = Object.assign(commands, { createGroupDirectoryCommands });
