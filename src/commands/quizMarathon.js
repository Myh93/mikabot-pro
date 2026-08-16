"use strict";

const marathonDefault = require("../services/quizMarathonService");
const { createPlatformContext } = require("../utils/platformContext");
const { logDetailedError } = require("../../utils/logger");
const marathonFormatterDefault = require("../services/quizMarathonFormatter");

function createQuizMarathonCommands(options = {}) {
  const marathon = options.marathonService || marathonDefault;
  const formatter = options.formatter || marathon.formatter || marathonFormatterDefault;

  async function contextFor(client, msg, loaderContext) {
    return loaderContext.platformContext || createPlatformContext(client, msg, { resolveContact: false });
  }

  const marathonCommand = {
    name: "maratona",
    aliases: ["status maratona", "placar"],
    async execute(client, msg, args, loaderContext = {}) {
      const context = await contextFor(client, msg, loaderContext);
      try {
        if (!context.isGroup) return context.replyText("❌ A Maratona só pode ser usada em grupos.");
        const commandName = loaderContext.commandName || "maratona";
        if (commandName === "status maratona") {
          const status = await marathon.getStatus(context);
          if (!status.active) return context.replyText("⏳ Não há maratona ativa neste grupo.");
          return context.replyText(formatter.formatStatus(status.session, status.remainingMs, status.participants));
        }
        if (commandName === "placar") {
          const scoreboard = await marathon.getScoreboard(context);
          return context.replyText(scoreboard || "⏳ Não há maratona ativa neste grupo.");
        }
        let total = 10;
        if (String(args[0] || "").toLowerCase() === "personalizada") total = Number(args[1]);
        else if (args[0]) total = Number(args[0]);
        if (![5, 10, 20, 30].includes(total) && !(String(args[0] || "").toLowerCase() === "personalizada" && Number.isInteger(total) && total >= 1 && total <= 100)) return context.replyText("❌ Use: !maratona 5, 10, 20, 30 ou !maratona personalizada 15.");
        const result = await marathon.startMarathon(context, total, context.replyText);
        if (result.status === "already_active") return context.replyText("❌ Já existe uma maratona em andamento.");
        return result;
      } catch (error) {
        logDetailedError("Erro no comando de Maratona:", error);
        return context.replyText("❌ Não foi possível processar a Maratona agora.");
      }
    }
  };

  const stopCommand = {
    name: "parar maratona",
    aliases: [],
    adminOnly: true,
    async execute(client, msg, args, loaderContext = {}) {
      const context = await contextFor(client, msg, loaderContext);
      try {
        if (!context.isGroup) return context.replyText("❌ A Maratona só pode ser usada em grupos.");
        const result = await marathon.stopMarathon(context, context.replyText);
        if (result.status === "none") return context.replyText("⏳ Não há maratona ativa neste grupo.");
        return result;
      } catch (error) {
        logDetailedError("Erro ao parar Maratona:", error);
        return context.replyText("❌ Não foi possível parar a Maratona agora.");
      }
    }
  };

  return [marathonCommand, stopCommand];
}

const commands = createQuizMarathonCommands();
commands.createQuizMarathonCommands = createQuizMarathonCommands;
module.exports = commands;
