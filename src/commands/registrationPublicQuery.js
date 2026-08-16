"use strict";

const serviceDefault = require("../services/registrationPublicQueryService");
const { createPlatformContext } = require("../utils/platformContext");
const { logDetailedError } = require("../../utils/logger");

function createRegistrationPublicQueryCommands(options = {}) {
  const service = options.registrationPublicQueryService || serviceDefault;
  function command(name, aliases, compact) {
    return { name, aliases, async execute(client, msg, args, loaderContext = {}) {
      const context = loaderContext.platformContext || await createPlatformContext(client, msg, { resolveContact: false });
      try {
        const target = service.resolveQueryTarget({ msg, args, context });
        const result = compact ? await service.getPublicFriendCodes(target) : await service.getPublicAccounts(target);
        return context.replyText(result.text);
      } catch (error) {
        logDetailedError(`Erro na consulta pública ${name}:`, error);
        return context.replyText("❌ Não foi possível consultar o treinador agora.");
      }
    } };
  }
  return [
    command("treinador", ["contas"], false),
    command("fc", ["friendcode", "code", "codes", "codigo", "códigos", "friend"], true),
    { name: "treinadores", aliases: ["buscar treinador"], registrationRequired: true, async execute(client, msg, args, loaderContext = {}) {
      const context = loaderContext.platformContext || await createPlatformContext(client, msg, { resolveContact: false });
      if (!args.length) return context.replyText(["👥 TREINADORES", "", "1️⃣ Buscar treinador", "2️⃣ Meu perfil público", "3️⃣ Ver Friend Code", "4️⃣ Ver membros cadastrados", "0️⃣ Voltar", "", "Para buscar, envie: !treinador nome, Nick, Friend Code ou menção."].join("\n"));
      const target = service.resolveQueryTarget({ msg, args, context });
      const result = await service.getPublicAccounts(target);
      return context.replyText(result.text);
    } }
  ];
}

module.exports = createRegistrationPublicQueryCommands();
Object.defineProperty(module.exports, "createRegistrationPublicQueryCommands", { value: createRegistrationPublicQueryCommands, enumerable: false });
