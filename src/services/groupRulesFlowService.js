"use strict";

const flowsDefault = require("./guidedFlowService");
const rulesDefault = require("./groupRulesService");
const resolverDefault = require("./inputResolverService");

const FLOW_ID = "group_rules_administration";
const args = context => [context.platform, context.conversationId || context.groupId, context.userId];

function createGroupRulesFlowService(options = {}) {
  const flows = options.guidedFlowService || flowsDefault;
  const rules = options.groupRulesService || rulesDefault;
  const resolver = options.inputResolverService || resolverDefault;
  const reply = (context, text) => context.replyText(String(text));

  async function start(context) {
    await flows.startFlow({ flowId: FLOW_ID, platform: context.platform, conversationId: context.conversationId || context.groupId, userId: context.userId, step: "menu", data: {} });
    await reply(context, "📜 REGRAS DO GRUPO\n\n1️⃣ Ver regras\n2️⃣ Editar regras\n3️⃣ Revisar alterações\n4️⃣ Publicar regras\n5️⃣ Ver histórico\n6️⃣ Restaurar versão anterior\n7️⃣ Voltar");
    return { status: "started" };
  }

  async function hasActiveFlow(context) {
    if (!context?.platform || !(context.conversationId || context.groupId) || !context.userId) return false;
    return (await flows.getActiveFlow(...args(context)))?.flowId === FLOW_ID;
  }

  async function menu(context) { await flows.updateFlow(...args(context), { step: "menu" }); return start(context); }

  async function handleAnswer(context, text) {
    const session = await flows.getActiveFlow(...args(context));
    if (!session || session.flowId !== FLOW_ID) return { status: "ignored" };
    const navigation = resolver.resolveNavigation(text);
    if (["cancel", "back"].includes(navigation) || String(text).trim() === "7") { await flows.cancelFlow(...args(context)); await reply(context, "✅ Administração de regras encerrada."); return { status: "cancelled" }; }
    if (session.step === "menu") {
      const option = String(text).trim();
      if (option === "1") { const current = await rules.getRules(context); await reply(context, `📜 REGRAS OFICIAIS\n\n${current.value}`); return { status: "viewed" }; }
      if (option === "2") { await flows.updateFlow(...args(context), { step: "edit" }); await reply(context, "✏️ Envie o texto completo das novas regras.\n\nA versão atual será preservada no histórico."); return { status: "editing" }; }
      if (option === "3") { await reply(context, session.data.draft ? `🔎 REVISÃO\n\n${session.data.draft}\n\n4️⃣ Publicar\n2️⃣ Editar\n7️⃣ Voltar` : "ℹ️ Nenhuma alteração em revisão."); return { status: "review" }; }
      if (option === "4") { if (!session.data.draft) { await reply(context, "ℹ️ Nenhuma alteração em revisão."); return { status: "no_draft" }; } await flows.updateFlow(...args(context), { step: "confirm_publish" }); await reply(context, `⚠️ Publicar estas regras?\n\n${session.data.draft}\n\n1️⃣ Confirmar\n2️⃣ Cancelar`); return { status: "confirmation" }; }
      if (option === "5") { const versions = await rules.listVersions(context); await reply(context, versions.length ? `📚 HISTÓRICO DE REGRAS\n\n${versions.map(v => `${v.version}. ${new Date(v.recordedAt).toLocaleString("pt-BR")}`).join("\n")}` : "ℹ️ Nenhuma versão publicada ainda."); return { status: "history" }; }
      if (option === "6") { const versions = await rules.listVersions(context); await flows.updateFlow(...args(context), { step: "restore", data: { ...session.data, versions: versions.map(v => v.version) } }); await reply(context, versions.length ? `♻️ Informe a versão que deseja restaurar:\n\n${versions.map(v => `${v.version}. ${new Date(v.recordedAt).toLocaleString("pt-BR")}`).join("\n")}` : "ℹ️ Nenhuma versão disponível para restauração."); return { status: versions.length ? "restore_select" : "history_empty" }; }
      await reply(context, "❌ Escolha uma opção válida."); return { status: "invalid" };
    }
    if (session.step === "edit") { const draft = String(text || "").trim(); if (!draft || draft.length > 2048) { await reply(context, "❌ Informe um texto entre 1 e 2048 caracteres."); return { status: "invalid" }; } await flows.updateFlow(...args(context), { step: "menu", data: { ...session.data, draft } }); await reply(context, `🔎 REVISÃO\n\n${draft}\n\n4️⃣ Publicar\n2️⃣ Editar\n7️⃣ Voltar`); return { status: "review" }; }
    if (session.step === "confirm_publish") { if (resolver.resolveYesNo(text) !== true) { await flows.updateFlow(...args(context), { step: "menu" }); await reply(context, "❌ Publicação cancelada. O rascunho foi preservado nesta sessão."); return { status: "cancelled_publish" }; } const saved = await rules.publishRules(context, session.data.draft); const sync = await rules.synchronizeGroupDescription(context.chat, saved.value); await flows.finishFlow(...args(context)); await reply(context, `✅ Regras publicadas e versionadas.${sync.synchronized ? "\n✅ Descrição do grupo sincronizada." : "\n⚠️ A descrição externa não pôde ser sincronizada; a fonte oficial interna foi preservada."}`); return { status: "published", synchronized: sync.synchronized }; }
    if (session.step === "restore") { const version = Number(String(text).trim()); if (!session.data.versions?.includes(version)) { await reply(context, "❌ Versão inválida."); return { status: "invalid" }; } const restored = await rules.restoreVersion(context, version); await flows.finishFlow(...args(context)); await reply(context, `✅ Versão restaurada como uma nova publicação.\n\n${restored.value}`); return { status: "restored" }; }
    return menu(context);
  }

  return { FLOW_ID, start, hasActiveFlow, handleAnswer };
}

const service = createGroupRulesFlowService();
module.exports = { ...service, createGroupRulesFlowService, FLOW_ID };
