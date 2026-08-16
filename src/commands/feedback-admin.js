"use strict";

const feedbackAdministrationService = require("../services/feedbackAdministrationService");
const { createPlatformContext } = require("../utils/platformContext");

module.exports = {
  name: "feedbacks",
  aliases: [],
  adminOnly: true,
  async execute(client, msg, args, loaderContext = {}) {
    const context = loaderContext.platformContext || await createPlatformContext(client, msg);
    try {
      const items = await feedbackAdministrationService.listFeedbacks({
        ...context,
        client,
        conversationId: context.groupId,
        role: loaderContext.role
      }, args);
      return context.replyText(feedbackAdministrationService.formatList(items));
    } catch (error) {
      if (error.code === "FEEDBACK_ADMIN_FORBIDDEN") {
        return context.replyText("❌ Apenas owners e administradores autorizados podem usar este comando.");
      }
      throw error;
    }
  }
};
