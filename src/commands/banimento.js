"use strict";

const administration = require("../services/banExperienceAdministrationService");
const { createPlatformContext } = require("../utils/platformContext");

module.exports = [{
  name: "banimento", aliases: [], groupOnly: true, adminOnly: true,
  async execute(client, msg, _args, loaderContext = {}) {
    const context = loaderContext.platformContext || await createPlatformContext(client, msg);
    return administration.start(context);
  }
}];
