"use strict";

const repositoryDefault = require("../repositories/memberExperienceRepository");
const flowsDefault = require("./guidedFlowService");
const inputDefault = require("./inputResolverService");
const libraryDefault = require("./memberMediaLibraryService");
const experienceDefault = require("./memberExperienceService");

const FLOW_ID = "ban_experience_admin";
const flowArgs = context => [context.platform, context.conversationId, context.userId];
const uploadErrors = { no_media: "nenhuma mídia foi encontrada", download_unavailable: "download indisponível", download_failed: "falha ao baixar a mídia", download_returned_empty: "o download retornou vazio", invalid_base64: "arquivo recebido inválido", unsupported_mime: "formato não suportado", invalid_file_signature: "assinatura do arquivo inválida", file_too_large: "arquivo acima do limite", corrupted_media: "arquivo corrompido", save_failed: "falha ao salvar" };

function createBanExperienceAdministrationService(options = {}) {
  const repository = options.repository || repositoryDefault;
  const flows = options.guidedFlowService || flowsDefault;
  const input = options.inputResolverService || inputDefault;
  const library = options.memberMediaLibraryService || libraryDefault;
  const experience = options.memberExperienceService || experienceDefault;
  const reply = (context, text) => context.replyText(text);
  const libraryMenu = () => ["🚫 MÍDIAS DE BANIMENTO", "", "1️⃣ Adicionar mídia", "2️⃣ Listar mídias", "3️⃣ Ativar/desativar mídia", "4️⃣ Remover mídia", "5️⃣ Testar no grupo", "6️⃣ Pré-visualizar no privado", "0️⃣ Voltar"].join("\n");

  const mainMenu = config => ["🚫 BANIMENTO", "", `Estado: ${config.enabled ? "✅ Ativo" : "❌ Inativo"}`, "", "1️⃣ Biblioteca de mídias", "2️⃣ Ativar/desativar", "3️⃣ Editar mensagem", "4️⃣ Mencionar membro", "5️⃣ Mostrar motivo", "6️⃣ Mostrar duração", "7️⃣ Exclusão automática", "8️⃣ Testar envio", "0️⃣ Fechar"].join("\n");
  const list = items => items.length ? ["🚫 MÍDIAS DE BANIMENTO", "", ...items.flatMap(item => [`${item.mediaId} · ${item.mediaType} · ${item.enabled ? "ativo" : "inativo"}`, `${Math.ceil(item.size / 1024)} KB · ${String(item.addedAt || "").slice(0, 10)}`, ""])].join("\n").trim() : "📂 Nenhuma mídia de banimento cadastrada.";
  const update = (context, session, step, data = {}) => flows.updateFlow(...flowArgs(context), { step, data: { ...session.data, ...data } });

  async function start(context) {
    if (!context?.isGroup) return reply(context, "❌ Este comando só pode ser usado em grupos.");
    const config = (await repository.getGroupConfig(context.groupId)).ban;
    const result = await flows.startFlow({ flowId: FLOW_ID, platform: context.platform, conversationId: context.conversationId, userId: context.userId, step: "main", data: { groupId: context.groupId } });
    if (!result.started) return reply(context, "⚠️ Conclua ou cancele o fluxo guiado atual antes de continuar.");
    await reply(context, mainMenu(config)); return { status: "started" };
  }
  async function hasActiveFlow(context) { const session = context && await flows.getActiveFlow(...flowArgs(context)); return session?.flowId === FLOW_ID; }
  async function showMain(context, session) { await update(context, session, "main"); const config = (await repository.getGroupConfig(session.data.groupId)).ban; await reply(context, mainMenu(config)); return { status: "main" }; }
  async function showLibrary(context, session) { await update(context, session, "library"); await reply(context, libraryMenu()); return { status: "library" }; }

  async function handleAnswer(context, text) {
    const session = await flows.getActiveFlow(...flowArgs(context)); if (!session || session.flowId !== FLOW_ID) return { status: "ignored" };
    const normalized = input.normalizeInput(text), navigation = input.resolveNavigation(text);
    if (navigation === "cancel" || normalized === "9") { await flows.cancelFlow(...flowArgs(context)); await reply(context, "❌ Configuração cancelada."); return { status: "cancelled" }; }
    const config = (await repository.getGroupConfig(session.data.groupId)).ban;
    if (session.step === "main") {
      if (normalized === "0") { await flows.finishFlow(...flowArgs(context)); await reply(context, "✅ Menu de banimento fechado."); return { status: "closed" }; }
      if (normalized === "1") return showLibrary(context, session);
      if (normalized === "2") { await update(context, session, "activation"); await reply(context, `⚙️ ATIVAÇÃO DO BANIMENTO\n\n1️⃣ Recurso completo: ${config.enabled ? "Ativo" : "Inativo"}\n2️⃣ Mídia: ${config.mediaEnabled ? "Ativa" : "Inativa"}\n3️⃣ Mensagem: ${config.textEnabled ? "Ativa" : "Inativa"}\n0️⃣ Voltar`); return { status: "activation" }; }
      const booleanFields = { 4: "mention", 5: "showReason", 6: "showDuration" };
      if (booleanFields[normalized]) { const field = booleanFields[normalized]; await repository.updateGroupConfig(session.data.groupId, { ban: { [field]: !config[field] } }); await reply(context, "✅ Configuração atualizada."); return showMain(context, session); }
      if (normalized === "3") { await update(context, session, "text"); await reply(context, "📝 Digite a nova mensagem. Use @Treinador, {motivo} e {duracao} como marcadores."); return { status: "awaiting_text" }; }
      if (normalized === "7") { await update(context, session, "deletion"); await reply(context, "Informe o tempo de exclusão em minutos (0 a 10080)."); return { status: "awaiting_deletion" }; }
      if (normalized === "8") { await experience.testBan(context.client, session.data.groupId); await reply(context, "✅ Teste de banimento enviado sem alterar a disciplina."); return { status: "tested" }; }
    }
    if (session.step === "activation") {
      if (normalized === "0" || navigation === "back") return showMain(context, session);
      const field = { 1: "enabled", 2: "mediaEnabled", 3: "textEnabled" }[normalized];
      if (!field) return { status: "invalid" };
      await repository.updateGroupConfig(session.data.groupId, { ban: { [field]: !config[field] } });
      await reply(context, "✅ Configuração atualizada."); return showMain(context, session);
    }
    if (session.step === "library") {
      if (normalized === "0" || navigation === "back") return showMain(context, session);
      if (normalized === "6") { const result = await experience.previewMedia(context.client, context.userId, "ban"); return { status: result.sent ? "previewed" : result.empty ? "empty" : "preview_failed" }; }
      if (normalized === "3") { await update(context, session, "toggle"); await reply(context, "Informe o ID da mídia:\n\nExemplo:\nME000001\n\n8️⃣ Voltar\n9️⃣ Cancelar"); return { status: "awaiting_id" }; }
      if (normalized === "1") { await update(context, session, "upload"); await reply(context, "📎 Envie agora a mídia de banimento pronta pelo WhatsApp.\n\nAceito:\n\n• Imagem\n• Sticker\n• GIF\n• Vídeo\n\n9️⃣ Cancelar"); return { status: "awaiting_upload" }; }
      if (normalized === "2") { await reply(context, list(await library.listMedia("ban"))); return { status: "listed" }; }
      if (["3", "4"].includes(normalized)) { await update(context, session, normalized === "3" ? "toggle" : "remove"); await reply(context, "Informe o mediaId."); return { status: "awaiting_id" }; }
      if (normalized === "5") { await experience.testBan(context.client, session.data.groupId); await reply(context, "✅ Teste da mídia de banimento concluído."); return { status: "tested" }; }
    }
    if (session.step === "upload") {
      const result = await library.importWhatsAppMedia({ message: context.message, originalMessage: context.originalMessage || context.message }, "ban");
      if (result.errorCode === "duplicate_message") return { status: "ignored", errorCode: result.errorCode };
      if (!result.created) { await reply(context, `❌ Não foi possível adicionar essa mídia.\n\nMotivo: ${uploadErrors[result.errorCode] || "mídia inválida"}.`); return { status: "invalid_media", errorCode: result.errorCode }; }
      await reply(context, `✅ Mídia adicionada com sucesso.\n\nTipo: ${result.item.mediaType}\nCategoria: Banimento\nID: ${result.item.mediaId}\nEstado: Ativa`); return showLibrary(context, session);
    }
    if ((normalized === "8" || navigation === "back") && ["toggle", "toggle_post"].includes(session.step)) return showLibrary(context, session);
    if (session.step === "toggle") {
      const item = await library.repository.getMedia(normalized.toUpperCase());
      if (!item || item.category !== "ban") { await reply(context, "❌ Mídia não encontrada."); return { status: "not_found" }; }
      const updated = await library.setEnabled(item.mediaId, !item.enabled);
      await update(context, session, "toggle_post");
      await reply(context, `✅ Estado da mídia atualizado.\n\n${updated.mediaId}\nEstado: ${updated.enabled ? "✅ Ativa" : "❌ Inativa"}\n\n1️⃣ Alterar outra mídia\n2️⃣ Listar mídias\n0️⃣ Voltar`);
      return { status: "updated" };
    }
    if (session.step === "toggle_post") {
      if (normalized === "1") { await update(context, session, "toggle"); await reply(context, "Informe o ID da mídia:\n\nExemplo:\nME000001\n\n8️⃣ Voltar\n9️⃣ Cancelar"); return { status: "awaiting_id" }; }
      if (normalized === "2") { await reply(context, list(await library.listMedia("ban"))); return { status: "listed" }; }
      if (normalized === "0") return showLibrary(context, session);
      return { status: "invalid" };
    }
    if (session.step === "toggle" || session.step === "remove") {
      const item = await library.repository.getMedia(normalized.toUpperCase()); if (!item || item.category !== "ban") { await reply(context, "❌ Mídia não encontrada."); return { status: "not_found" }; }
      await update(context, session, "remove_confirm", { mediaId: item.mediaId }); await reply(context, "⚠️ Confirmar remoção?\n\n1️⃣ Confirmar\n2️⃣ Cancelar"); return { status: "confirmation" };
    }
    if (session.step === "remove_confirm") { const yes = input.resolveYesNo(text); if (yes === false) return showLibrary(context, session); if (yes !== true) return { status: "invalid" }; await library.removeMedia(session.data.mediaId); await reply(context, "✅ Mídia removida."); return showLibrary(context, session); }
    if (session.step === "text") { const value = String(text || "").trim(); if (!value) return { status: "invalid" }; await repository.updateGroupConfig(session.data.groupId, { ban: { text: value } }); await reply(context, "✅ Mensagem atualizada."); return showMain(context, session); }
    if (session.step === "deletion") { const minutes = Number(normalized); if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10080) return { status: "invalid" }; await repository.updateGroupConfig(session.data.groupId, { ban: { deleteAfterMs: minutes * 60000 } }); await reply(context, "✅ Exclusão automática atualizada."); return showMain(context, session); }
    return { status: "ignored" };
  }
  return { start, hasActiveFlow, handleAnswer, mainMenu, libraryMenu, FLOW_ID };
}

const service = createBanExperienceAdministrationService();
module.exports = { ...service, createBanExperienceAdministrationService, FLOW_ID };
