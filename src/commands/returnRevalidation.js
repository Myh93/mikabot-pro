"use strict";

const repositoryDefault = require("../repositories/memberExperienceRepository");

function createReturnRevalidationCommands(options = {}) {
  const repository = options.repository || repositoryDefault;
  return [{
  name: "prazoretorno",
  aliases: ["diasretorno"],
  groupOnly: true,
  adminOnly: true,
  async execute(_client, msg, args) {
    const current = await repository.getGroupConfig(msg.from);
    if (!args.length) return msg.reply(`⏱️ Prazo de revalidação do retorno: ${current.returnRevalidationDays || 7} dia(s).`);
    const days = Number(args[0]);
    if (!Number.isInteger(days) || days < 1 || days > 365) return msg.reply("❌ Informe um prazo inteiro entre 1 e 365 dias.");
    await repository.updateGroupConfig(msg.from, { returnRevalidationDays: days });
    return msg.reply(`✅ Prazo de revalidação atualizado para ${days} dia(s).`);
  }
  }];
}

const commands = createReturnRevalidationCommands();
Object.defineProperty(commands, "createReturnRevalidationCommands", { value: createReturnRevalidationCommands });
module.exports = commands;
