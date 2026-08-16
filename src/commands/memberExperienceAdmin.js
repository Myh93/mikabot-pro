"use strict";

const administration = require("../services/memberExperienceAdministrationService");
const { createPlatformContext } = require("../utils/platformContext");

function command(name, kind) {
  return { name, aliases: [], groupOnly: true, adminOnly: true, async execute(client, msg, _args, loaderContext = {}) {
    const base = loaderContext.platformContext || await createPlatformContext(client, msg);
    return administration.start({ ...base, isGroup: true, conversationId: base.groupId }, kind);
  } };
}

module.exports = [command("boasvindas", "welcome"), command("despedida", "farewell")];
