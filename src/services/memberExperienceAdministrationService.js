"use strict";

const repositoryDefault = require("../repositories/memberExperienceRepository");
const flowsDefault = require("./guidedFlowService");
const inputDefault = require("./inputResolverService");
const experienceDefault = require("./memberExperienceService");
const libraryDefault = require("./memberMediaLibraryService");

const FLOW_ID = "member_experience_admin";
const args = context => [context.platform, context.conversationId || context.groupId, context.userId];
const labels = { welcome: "BOAS-VINDAS", return: "RETORNO", farewell: "DESPEDIDA", removal: "REMOÇÃO" };
const typeLabels = { image: "Imagem", gif: "GIF", sticker: "Sticker", video: "Vídeo" };
const uploadErrors = { no_media: "nenhuma mídia foi encontrada", download_unavailable: "download indisponível", download_failed: "falha ao baixar a mídia", download_returned_empty: "o download retornou vazio", invalid_base64: "arquivo recebido inválido", unsupported_mime: "formato não suportado", invalid_file_signature: "assinatura do arquivo inválida", file_too_large: "arquivo acima do limite permitido", corrupted_media: "arquivo corrompido", save_failed: "falha ao salvar a mídia" };
const pair = kind => kind === "welcome" ? ["welcome", "return"] : ["farewell", "removal"];

function createMemberExperienceAdministrationService(options = {}) {
  const repository = options.repository || repositoryDefault;
  const flows = options.guidedFlowService || flowsDefault;
  const input = options.inputResolverService || inputDefault;
  const experience = options.memberExperienceService || experienceDefault;
  const library = options.memberMediaLibraryService || libraryDefault;
  const reply = (context, text) => context.replyText(text);

  function mainMenu(kind, draft) {
    const section = draft[kind]; const categories = pair(kind);
    return [`⚙️ ${labels[categories[0]]} E ${labels[categories[1]]}`, "", `Estado: ${section.enabled ? "✅ Ativo" : "❌ Inativo"}`, "",
      `1️⃣ Biblioteca de ${labels[categories[0]].toLowerCase()}`, `2️⃣ Biblioteca de ${labels[categories[1]].toLowerCase()}`,
      "3️⃣ Ativar/desativar", "4️⃣ Editar mensagens", "5️⃣ Mencionar usuário", "6️⃣ Exclusão automática", "", "Digite salvar para persistir", "7️⃣ Repetir", "9️⃣ Cancelar"
    ].join("\n");
  }

  function mediaMenu(category) {
    return [`🎉 BIBLIOTECA DE ${labels[category]}`, "", "1️⃣ Adicionar mídia", "2️⃣ Listar mídias", "3️⃣ Ativar/desativar", "4️⃣ Remover mídia", "5️⃣ Testar no grupo", "6️⃣ Pré-visualizar no privado", "0️⃣ Voltar"].join("\n");
  }

  function sourceMenu() { return ["🌐 FONTES EXTERNAS", "", "Nenhuma fonte real é ativada automaticamente.", "", "1️⃣ Usar somente biblioteca local", "2️⃣ Frequência de atualização", "3️⃣ Limite de itens no cache", "4️⃣ Limite diário de downloads", "5️⃣ Espaço máximo do cache", "6️⃣ Listar adaptadores autorizados", "7️⃣ Configurar adaptador autorizado", "0️⃣ Voltar"].join("\n"); }
  function adapterMenu(sourceId) { return [`🌐 FONTE ${sourceId}`, "", "1️⃣ Ativar/desativar", "2️⃣ Categorias permitidas", "3️⃣ Tipos permitidos", "4️⃣ Frequência", "5️⃣ Downloads máximos por dia", "6️⃣ Palavras-chave seguras", "0️⃣ Voltar"].join("\n"); }
  function mediaList(items) { return items.length ? ["📚 MÍDIAS", "", ...items.flatMap(item => [`${item.mediaId} · ${item.origin === "external" ? "cache externo" : "local"}`, `${item.category} · ${item.mediaType} · ${item.enabled ? "ativo" : "inativo"}`, `${Math.ceil(item.size / 1024)} KB · ${String(item.addedAt || item.downloadedAt || "").slice(0, 10)}`, ...(item.sourceId ? [`Fonte: ${item.sourceId}`] : []), ""])].join("\n").trim() : "📂 Nenhuma mídia cadastrada nesta categoria."; }

  async function start(context, kind) {
    if (!context?.isGroup || !context.groupId) return reply(context, "❌ Este comando só pode ser usado em grupos.");
    const config = await repository.getGroupConfig(context.groupId);
    const result = await flows.startFlow({ flowId: FLOW_ID, platform: context.platform, conversationId: context.conversationId || context.groupId, userId: context.userId, step: "main", data: { kind, groupId: context.groupId, draft: config } });
    if (!result.started) return reply(context, "⚠️ Conclua ou cancele o fluxo guiado atual antes de continuar.");
    await reply(context, mainMenu(kind, config)); return { status: "started" };
  }

  async function hasActiveFlow(context) { const session = await flows.getActiveFlow(...args(context)); return session?.flowId === FLOW_ID; }
  async function update(context, session, step, data = {}) { return flows.updateFlow(...args(context), { step, data: { ...session.data, ...data } }); }
  async function backToLibrary(context, session) { await update(context, session, "library"); await reply(context, mediaMenu(session.data.category)); return { status: "back" }; }

  async function handleMain(context, text, session) {
    const normalized = input.normalizeInput(text);
    if (normalized === "salvar") { await repository.updateGroupConfig(session.data.groupId, session.data.draft); await flows.finishFlow(...args(context)); await reply(context, "✅ Configuração salva com sucesso."); return { status: "saved" }; }
    if (normalized === "7" || input.resolveNavigation(text) === "repeat") { await reply(context, mainMenu(session.data.kind, session.data.draft)); return { status: "repeated" }; }
    const option = input.resolveMenuOption(text, [{ value: "primary", number: 1 }, { value: "secondary", number: 2 }, { value: "enabled", number: 3 }, { value: "messages", number: 4 }, { value: "mention", number: 5 }, { value: "deletion", number: 6 }]);
    if (["primary", "secondary"].includes(option)) { const category = pair(session.data.kind)[option === "primary" ? 0 : 1]; await update(context, session, "library", { category }); await reply(context, mediaMenu(category)); return { status: "library" }; }
    if (option === "enabled" || option === "mention") { await update(context, session, "boolean", { field: option }); await reply(context, `${option === "enabled" ? "Ativar mensagens" : "Mencionar usuário"}?\n\n1️⃣ Sim\n2️⃣ Não\n8️⃣ Voltar\n9️⃣ Cancelar`); return { status: "awaiting_value" }; }
    if (option === "messages") { await update(context, session, "message_choice"); await reply(context, `1️⃣ ${labels[pair(session.data.kind)[0]]}\n2️⃣ ${labels[pair(session.data.kind)[1]]}\n0️⃣ Voltar`); return { status: "message_choice" }; }
    if (option === "deletion") { await update(context, session, "deletion"); await reply(context, "Informe 0, 1, 5, 10 ou outro total de minutos (máximo 10080).\n\n8️⃣ Voltar\n9️⃣ Cancelar"); return { status: "awaiting_value" }; }
    await reply(context, "❌ Opção inválida.\n\n" + mainMenu(session.data.kind, session.data.draft)); return { status: "invalid" };
  }

  async function handleLibrary(context, text, session) {
    const normalized = input.normalizeInput(text); if (normalized === "0" || normalized === "voltar") { await update(context, session, "main", { category: null }); await reply(context, mainMenu(session.data.kind, session.data.draft)); return { status: "back" }; }
    const option = Number(normalized);
    if (option === 6) { const result = await experience.previewMedia(context.client, context.userId, session.data.category); return { status: result.sent ? "previewed" : result.empty ? "empty" : "preview_failed" }; }
    if (option === 3) { await update(context, session, "toggle_id"); await reply(context, "Informe o ID da mídia:\n\nExemplo:\nME000001\n\n8️⃣ Voltar\n9️⃣ Cancelar"); return { status: "awaiting_id" }; }
    if (option === 1) { await update(context, session, "upload"); await reply(context, "📎 Envie agora a mídia pronta pelo WhatsApp.\n\nAceito:\n\n• Imagem\n• Sticker\n• GIF\n• Vídeo\n\n9️⃣ Cancelar"); return { status: "awaiting_upload" }; }
    if (option === 2) { await reply(context, mediaList(await library.listMedia(session.data.category))); return { status: "listed" }; }
    if ([3, 4].includes(option)) { await update(context, session, option === 3 ? "toggle_id" : "remove_id"); await reply(context, `Informe o ID curto da mídia para ${option === 3 ? "ativar/desativar" : "remover"}.\n\n8️⃣ Voltar\n9️⃣ Cancelar`); return { status: "awaiting_id" }; }
    if (option === 5) { const result = await experience.testMedia(context.client, session.data.groupId, session.data.category); await reply(context, result.visualSent || result.stickerSent ? `✅ Teste enviado usando a seleção real da biblioteca.\nCategoria: ${labels[session.data.category]}` : "ℹ️ Nenhuma mídia válida disponível; o fluxo real usaria somente texto."); return { status: "tested" }; }
    await reply(context, "❌ Opção inválida.\n\n" + mediaMenu(session.data.category)); return { status: "invalid" };
  }

  async function handleAnswer(context, text) {
    const session = await flows.getActiveFlow(...args(context)); if (!session || session.flowId !== FLOW_ID) return { status: "ignored" };
    const normalized = input.normalizeInput(text);
    if ((normalized === "9" && session.step !== "library") || normalized === "cancelar") { await flows.cancelFlow(...args(context)); await reply(context, "❌ Configuração cancelada."); return { status: "cancelled" }; }
    if (session.step === "main") return handleMain(context, text, session);
    if (session.step === "library") return handleLibrary(context, text, session);
    if (session.step === "upload") {
      let result;
      try { result = await library.importWhatsAppMedia({ message: context.message, originalMessage: context.originalMessage || context.message }, session.data.category); }
      catch (_) { result = { created: false, errorCode: "save_failed" }; }
      if (result.errorCode === "duplicate_message") return { status: "ignored", errorCode: result.errorCode };
      if (!result.created) { const reason = uploadErrors[result.errorCode] || "não foi possível validar a mídia"; await reply(context, `❌ Não foi possível adicionar essa mídia.\n\nMotivo: ${reason}.\n\nEnvie uma imagem, sticker, GIF ou vídeo válido.`); return { status: "invalid_media", errorCode: result.errorCode }; }
      await update(context, session, "library"); await reply(context, `✅ Mídia adicionada com sucesso.\n\nTipo: ${typeLabels[result.item.mediaType] || result.item.mediaType}\nCategoria: ${labels[session.data.category]}\nID: ${result.item.mediaId}\nEstado: ${result.item.enabled ? "Ativa" : "Inativa"}\n\n${mediaMenu(session.data.category)}`); return { status: "uploaded", media: result.item };
    }
    if ((normalized === "8" || normalized === "voltar") && ["toggle_id", "toggle_post"].includes(session.step)) return backToLibrary(context, session);
    if (session.step === "toggle_id") {
      const item = await library.repository.getMedia(normalized.toUpperCase());
      if (!item || item.category !== session.data.category) { await reply(context, "❌ Mídia não encontrada nesta categoria."); return { status: "not_found" }; }
      const updated = await library.setEnabled(item.mediaId, !item.enabled);
      await update(context, session, "toggle_post");
      await reply(context, `✅ Estado da mídia atualizado.\n\n${updated.mediaId}\nEstado: ${updated.enabled ? "✅ Ativa" : "❌ Inativa"}\n\n1️⃣ Alterar outra mídia\n2️⃣ Listar mídias\n0️⃣ Voltar`);
      return { status: "updated" };
    }
    if (session.step === "toggle_post") {
      if (normalized === "1") { await update(context, session, "toggle_id"); await reply(context, "Informe o ID da mídia:\n\nExemplo:\nME000001\n\n8️⃣ Voltar\n9️⃣ Cancelar"); return { status: "awaiting_id" }; }
      if (normalized === "2") { await reply(context, mediaList(await library.listMedia(session.data.category))); return { status: "listed" }; }
      if (normalized === "0") return backToLibrary(context, session);
      return { status: "invalid" };
    }
    if (normalized === "8" || normalized === "voltar") return session.step === "sources" ? backToLibrary(context, session) : (await update(context, session, "main"), await reply(context, mainMenu(session.data.kind, session.data.draft)), { status: "back" });
    if (session.step === "remove_id") { const item = await library.repository.getMedia(normalized.toUpperCase()); if (!item || item.category !== session.data.category) { await reply(context, "❌ Mídia não encontrada nesta categoria."); return { status: "not_found" }; } await update(context, session, "remove_confirm", { pendingMediaId: item.mediaId }); await reply(context, "⚠️ Confirmar remoção da mídia?\n\n1️⃣ Confirmar\n2️⃣ Cancelar"); return { status: "awaiting_confirmation" }; }
    if (session.step === "remove_confirm") { const value = input.resolveYesNo(text); if (value === null) return { status: "invalid" }; if (!value) return backToLibrary(context, session); const removed = await library.removeMedia(session.data.pendingMediaId); await update(context, session, "library", { pendingMediaId: null }); await reply(context, removed ? "✅ Mídia removida." : "❌ Mídia não encontrada."); await reply(context, mediaMenu(session.data.category)); return { status: removed ? "removed" : "not_found" }; }
    if (session.step === "boolean") { const value = input.resolveYesNo(text); if (value === null) { await reply(context, "❌ Responda Sim ou Não."); return { status: "invalid" }; } const section = { ...session.data.draft[session.data.kind], [session.data.field]: value }; const draft = { ...session.data.draft, [session.data.kind]: section }; await update(context, session, "main", { draft, field: null }); await reply(context, mainMenu(session.data.kind, draft)); return { status: "updated" }; }
    if (session.step === "deletion") { const minutes = Number(normalized); if (!Number.isInteger(minutes) || minutes < 0 || minutes > 10080) { await reply(context, "❌ Informe minutos entre 0 e 10080."); return { status: "invalid" }; } const section = { ...session.data.draft[session.data.kind], deleteAfterMs: minutes * 60000 }; const draft = { ...session.data.draft, [session.data.kind]: section }; await update(context, session, "main", { draft }); await reply(context, mainMenu(session.data.kind, draft)); return { status: "updated" }; }
    if (session.step === "message_choice") { if (normalized === "0") { await update(context, session, "main"); await reply(context, mainMenu(session.data.kind, session.data.draft)); return { status: "back" }; } const index = Number(normalized) - 1; if (![0, 1].includes(index)) return { status: "invalid" }; await update(context, session, "message_value", { messageCategory: pair(session.data.kind)[index] }); await reply(context, "Digite a nova mensagem. Use @Treinador como marcador opcional."); return { status: "awaiting_message" }; }
    if (session.step === "message_value") { const value = String(text || "").trim(); if (!value) return { status: "invalid" }; const fields = { welcome: "firstText", return: "returnText", farewell: "leaveText", removal: "removedText" }; const section = { ...session.data.draft[session.data.kind], [fields[session.data.messageCategory]]: value }; const draft = { ...session.data.draft, [session.data.kind]: section }; await update(context, session, "main", { draft, messageCategory: null }); await reply(context, mainMenu(session.data.kind, draft)); return { status: "updated" }; }
    if (session.step === "sources") {
      if (normalized === "0") return backToLibrary(context, session);
      if (normalized === "1") { const settings = await library.repository.getCacheSettings(); await library.repository.updateCacheSettings({ localOnly: !settings.localOnly }); await reply(context, `✅ Somente biblioteca local: ${!settings.localOnly ? "Sim" : "Não"}.`); return { status: "updated" }; }
      if (normalized === "6") { const values = library.listAdapters(); await reply(context, values.length ? values.map(item => `${item.sourceId} · ${item.licensePolicy}`).join("\n") : "ℹ️ Nenhum adaptador externo autorizado foi instalado."); return { status: "listed" }; }
      if (normalized === "7") { await update(context, session, "source_id"); await reply(context, "Informe o sourceId de um adaptador autorizado já instalado."); return { status: "awaiting_source" }; }
      const fields = { 2: "updateFrequency", 3: "maxItems", 4: "maxDownloadsPerDay", 5: "maxBytes" }; if (fields[normalized]) { await update(context, session, "source_value", { sourceField: fields[normalized] }); await reply(context, fields[normalized] === "updateFrequency" ? "Informe: disabled, daily ou weekly." : fields[normalized] === "maxBytes" ? "Informe o espaço máximo em MB." : "Informe um número inteiro seguro."); return { status: "awaiting_value" }; }
      await reply(context, sourceMenu()); return { status: "invalid" };
    }
    if (session.step === "source_value") { const field = session.data.sourceField; const allowed = field === "updateFrequency" ? ["disabled", "daily", "weekly"].includes(normalized) : Number.isInteger(Number(normalized)) && Number(normalized) >= 0; if (!allowed) { await reply(context, "❌ Valor inválido."); return { status: "invalid" }; } await library.repository.updateCacheSettings({ [field]: field === "updateFrequency" ? normalized : field === "maxBytes" ? Number(normalized) * 1024 * 1024 : Number(normalized) }); await update(context, session, "sources", { sourceField: null }); await reply(context, sourceMenu()); return { status: "updated" }; }
    if (session.step === "source_id") { const adapter = library.listAdapters().find(item => item.sourceId === normalized); if (!adapter) { await reply(context, "❌ Adaptador não autorizado ou não instalado."); return { status: "not_found" }; } await update(context, session, "source_config", { sourceId: adapter.sourceId }); await reply(context, adapterMenu(adapter.sourceId)); return { status: "source_config" }; }
    if (session.step === "source_config") {
      if (normalized === "0") { await update(context, session, "sources", { sourceId: null }); await reply(context, sourceMenu()); return { status: "back" }; }
      const existing = (await library.repository.listSources()).find(item => item.sourceId === session.data.sourceId) || {};
      if (normalized === "1") { await library.configureSource(session.data.sourceId, { ...existing, enabled: !existing.enabled }); await reply(context, adapterMenu(session.data.sourceId)); return { status: "updated" }; }
      const fields = { 2: "categories", 3: "types", 4: "updateFrequency", 5: "maxDownloadsPerDay", 6: "keywords" }; if (!fields[normalized]) return { status: "invalid" };
      await update(context, session, "source_config_value", { sourceConfigField: fields[normalized] }); await reply(context, fields[normalized] === "keywords" ? "Use: categoria: termo 1 | termo 2" : fields[normalized] === "maxDownloadsPerDay" ? "Informe um número inteiro." : `Informe ${fields[normalized]} separados por vírgula.`); return { status: "awaiting_value" };
    }
    if (session.step === "source_config_value") {
      const existing = (await library.repository.listSources()).find(item => item.sourceId === session.data.sourceId) || {}; const field = session.data.sourceConfigField; const changes = { ...existing };
      if (field === "categories" || field === "types") changes[field] = normalized.split(",").map(value => value.trim()).filter(Boolean);
      else if (field === "updateFrequency") { if (!["disabled", "daily", "weekly"].includes(normalized)) return { status: "invalid" }; changes[field] = normalized; }
      else if (field === "maxDownloadsPerDay") { if (!Number.isInteger(Number(normalized)) || Number(normalized) < 0) return { status: "invalid" }; changes[field] = Number(normalized); }
      else { const [category, values] = String(text).split(":"); if (!values) return { status: "invalid" }; changes.keywords = { ...(existing.keywords || {}), [input.normalizeInput(category)]: values.split("|").map(value => value.trim()).filter(Boolean) }; }
      await library.configureSource(session.data.sourceId, changes); await update(context, session, "source_config", { sourceConfigField: null }); await reply(context, adapterMenu(session.data.sourceId)); return { status: "updated" };
    }
    return { status: "ignored" };
  }

  return { start, hasActiveFlow, handleAnswer, mainMenu, mediaMenu, sourceMenu, adapterMenu, mediaList, FLOW_ID };
}

const service = createMemberExperienceAdministrationService();
module.exports = { ...service, createMemberExperienceAdministrationService, FLOW_ID };
