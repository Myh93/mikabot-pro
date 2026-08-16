"use strict";

const registrationGuidedFlowDefault = require("../services/registrationGuidedFlowService");
const { createPlatformContext } = require("../utils/platformContext");

function createRegistrationPrivacyCommand(options = {}) {
  const registrationGuidedFlow = options.registrationGuidedFlowService || registrationGuidedFlowDefault;
  return {
    name: "privacidade",
    aliases: ["privacy", "privado", "configprivacidade"],
    async execute(client, msg, args, loaderContext = {}) {
      const context = loaderContext.platformContext || await createPlatformContext(client, msg);
      if (context.isGroup) return registrationGuidedFlow.startPrivacy({ ...context, conversationId: context.groupId });
      if (args.length || msg?.mentionedIds?.length || msg?._data?.mentionedJidList?.length) return context.replyText("❌ Este comando configura somente a privacidade do seu próprio cadastro. Envie apenas !privacidade.");
      return registrationGuidedFlow.startPrivacy({ ...context, conversationId: context.conversationId || context.groupId });
    }
  };
}

module.exports = createRegistrationPrivacyCommand();
Object.defineProperty(module.exports, "createRegistrationPrivacyCommand", { value: createRegistrationPrivacyCommand, enumerable: false });
