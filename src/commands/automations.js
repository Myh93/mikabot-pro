"use strict";

const service = require("../services/automationAdministrationService");
module.exports = {
  name: "status automacoes", aliases: ["status automações"], adminOnly: true,
  async execute(client, msg, args, context = {}) {
    const platformContext = context.platformContext || { platform: "whatsapp", groupId: msg.from };
    return msg.reply(await service.formatStatus(platformContext));
  }
};
