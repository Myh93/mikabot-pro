"use strict";

const guidedDefault = require("../services/registrationGuidedFlowService");
const { createPlatformContext } = require("../utils/platformContext");

function createRegistrationEditCommand(options = {}) {
  const guided = options.registrationGuidedFlowService || guidedDefault;
  return {
    name: "editarcadastro",
    aliases: ["editar cadastro", "editarregistro", "editarperfilgo", "configcadastro"],
    async execute(client, msg, args, loaderContext = {}) {
      const context = loaderContext.platformContext || await createPlatformContext(client, msg);
      return guided.startEdit({ ...context, conversationId: context.conversationId || context.groupId });
    }
  };
}

module.exports = createRegistrationEditCommand();
Object.defineProperty(module.exports, "createRegistrationEditCommand", { value: createRegistrationEditCommand, enumerable: false });
