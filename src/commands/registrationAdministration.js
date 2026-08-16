"use strict";

const serviceDefault = require("../services/registrationAdministrationService");
const { createPlatformContext } = require("../utils/platformContext");

const MENU = ["👥 CADASTROS", "", "1️⃣ Buscar membro", "2️⃣ Ver cadastro", "3️⃣ Editar cadastro", "4️⃣ Ver status", "5️⃣ Histórico de alterações", "0️⃣ Voltar", "", "Use: !cadastros buscar nome", "Use: !cadastros ver nome", "Use: !cadastros editar alvo | campo | valor | motivo"].join("\n");

function createRegistrationAdministrationCommand(options = {}) {
  const service = options.registrationAdministrationService || serviceDefault;
  return {
    name: "cadastros", aliases: ["cadastroadmin", "administrar cadastros"], adminOnly: true, registrationRequired: false,
    async execute(client, msg, args, loaderContext = {}) {
      const context = loaderContext.platformContext || await createPlatformContext(client, msg, { resolveContact: false });
      if (!args.length) return context.replyText(MENU);
      const action = String(args.shift()).toLocaleLowerCase("pt-BR");
      const mention = msg?.mentionedIds?.[0] || msg?._data?.mentionedJidList?.[0];
      if (action === "editar") {
        const parts = args.join(" ").split("|").map(part => part.trim());
        const [query, field, value, reason] = parts;
        if ((!mention && !query) || !field || !value || !reason) return context.replyText("❌ Informe alvo, campo, valor e motivo, separados por |.");
        const updated = await service.updateField(mention || query, field, value, { executor: context.userId, reason });
        return context.replyText(updated ? "✅ Cadastro atualizado. Os demais campos foram preservados." : "❌ Cadastro não encontrado.");
      }
      const query = mention || args.join(" ");
      const item = await service.locate(query);
      if (!item) return context.replyText("❌ Cadastro não encontrado.");
      if (item.ambiguous) return context.replyText("⚠️ Mais de um cadastro corresponde à busca. Use uma menção ou Friend Code.");
      if (action === "historico" || action === "histórico") {
        const entries = await service.history(item.primaryIdentity);
        return context.replyText(["📋 HISTÓRICO DE ALTERAÇÕES", "", ...(entries || []).slice(-10).map(entry => `${entry.action} · ${new Date(entry.timestamp).toLocaleDateString("pt-BR")}`)].join("\n"));
      }
      if (action === "status") return context.replyText(`📊 STATUS DO CADASTRO\n\nEstado: ${item.status}\nValidação: ${item.validationStatus}`);
      const view = service.view(item);
      return context.replyText(["👤 CADASTRO", "", `Nome: ${view.name}`, `Nick: ${view.nick}`, `Friend Code: ${view.friendCode.replace(/(\d{4})(?=\d)/g, "$1 ")}`, `Cidade: ${view.city || "Não informada"}`, `Time: ${view.team || "Não informado"}`, `Nível: ${view.level || "Não informado"}`].join("\n"));
    }
  };
}

module.exports = createRegistrationAdministrationCommand();
Object.defineProperty(module.exports, "createRegistrationAdministrationCommand", { value: createRegistrationAdministrationCommand, enumerable: false });
