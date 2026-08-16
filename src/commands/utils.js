const menuRegistry = require("../services/menuRegistry");

module.exports = {
  name: "util",
  aliases: ["menu", "comandos", "regras"],
  async execute(client, msg, args, context = {}) {
    const commandName = context.commandName || msg.body.split(" ")[0].substring(1).toLowerCase();
    if (commandName === "menu") return menuRegistry.openMenuFromCommand("main", client, msg, context);
    if (commandName === "comandos") return menuRegistry.openMenuFromCommand("help", client, msg, context);
    if (commandName === "regras") return msg.reply("Em desenvolvimento.");

  }
};
