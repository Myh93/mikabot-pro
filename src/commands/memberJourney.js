"use strict";

const experience = require("../services/memberExperienceService");
const journey = require("../services/memberJourneyService");
const { createPlatformContext } = require("../utils/platformContext");

module.exports = [
  {
    name: "pararlembretes", aliases: ["parar lembretes", "sem lembretes"],
    async execute(client, msg, _args, loaderContext = {}) {
      const context = loaderContext.platformContext || await createPlatformContext(client, msg);
      await experience.disableReminders(context.userId);
      return context.replyText("✅ Você não receberá novos lembretes de cadastro.");
    }
  },
  {
    name: "missoes", aliases: ["missões", "jornada"],
    async execute(client, msg, _args, loaderContext = {}) {
      const context = loaderContext.platformContext || await createPlatformContext(client, msg);
      return context.replyText(journey.formatMissions(await journey.getMissions(context.userId)));
    }
  }
];
