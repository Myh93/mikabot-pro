const menuRegistry = require("../services/menuRegistry");
const groupRulesCommand = require("./groupRules");

module.exports = {
  name: "util",
  aliases: ["menu", "comandos", "regras"],
  async execute(client, msg, args, context = {}) {
    const commandName = context.commandName || msg.body.split(" ")[0].substring(1).toLowerCase();
    if (commandName === "menu") return menuRegistry.openMenuFromCommand("main", client, msg, context);
    if (commandName === "comandos") return menuRegistry.openMenuFromCommand("help", client, msg, context);
    if (commandName === "regras") return groupRulesCommand.showRules(client, msg, context);

  }
};
