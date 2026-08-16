"use strict";

const { createGuidedFlowService } = require("./guidedFlowService");
const guidedFlowDefault = createGuidedFlowService({ ttlMs: 30 * 60 * 1000 });
const registrationDefault = require("./registrationService");
const inputResolver = require("./inputResolverService");
const { createRegistrationEditFlowService } = require("./registrationEditFlowService");
const { SEPARATOR } = require("./messageStyleService");
const memberExperienceDefault = require("./memberExperienceService");

const LINE = SEPARATOR;
const START = [LINE, "📝 CADASTRO DO TREINADOR", LINE, "", "Vamos começar?", "", "1️⃣ Sim", "2️⃣ Cancelar", LINE].join("\n");
const GROUP_GUIDANCE = [LINE, "📝 CADASTRO DO TREINADOR", LINE, "", "Para proteger seus dados e não poluir o grupo, o cadastro é realizado no privado do MikaBot.", "", "Abra meu contato e envie:", "", "cadastro", LINE].join("\n");
const PROMPTS = {
  name: "👤 Qual é o seu nome?\n\nExemplo:\nJoão Pedro",
  nick: "🎮 Qual é o seu Nick principal no Pokémon GO?",
  friendCode: "🆔 Informe o Friend Code da sua conta principal.\n\nExemplo:\n1234 5678 9012",
  team: "🛡️ Escolha seu Time no Pokémon GO.\n\n1️⃣ Valor 🔥\n2️⃣ Mystic ❄️\n3️⃣ Instinct ⚡",
  city: "📍 Em qual cidade você joga?",
  level: "⭐ Qual é o nível atual da sua conta principal?\n\nDigite apenas o número.\n\nExemplo:\n50",
  fly: "✈️ Você faz Fly?\n\n1️⃣ Sim\n2️⃣ Não",
  canela: "🚶 Você joga presencialmente, também chamado de Canela?\n\n1️⃣ Sim\n2️⃣ Não",
  playSchedule: "🕒 Em quais horários você costuma jogar?\n\nPode responder do seu jeito.\n\nExemplos:\nManhã\nNoite\nDepois das 18h\nFim de semana\nHorário variado"
};
const STEPS = ["name", "nick", "friendCode", "team", "city", "level", "fly", "canela", "playSchedule"];
const TEAM_LABELS = { valor: "Valor", mystic: "Mystic", instinct: "Instinct" };
const OFFICIAL_TELEGRAM_INVITE = "https://t.me/+X_Uvz11GqwY4YWRh";
const OFFICIAL_TELEGRAM_MESSAGE = ["✅ Entre no grupo oficial da Tropa Pokémon GO:", "", OFFICIAL_TELEGRAM_INVITE, "", "Depois de entrar, volte aqui para continuar seu cadastro."].join("\n");
const FILLING_FOOTER = ["", "💾 salvar · ↩️ voltar · ✖️ cancelar"].join("\n");
const STEPS_WITH_OWN_OPTIONS = new Set(["confirm_start", "draft_choice", "review"]);
const withNavigation = (text, step) => `${text}${STEPS_WITH_OWN_OPTIONS.has(step) ? "" : FILLING_FOOTER}`;
const SECONDARY_PROMPTS = { secondary_nick: "🎮 Qual é o Nick da conta secundária?", secondary_friendCode: "🆔 Informe o Friend Code da conta secundária.", secondary_team: PROMPTS.team, secondary_level: PROMPTS.level };
const PRIVATE_STEPS = {
  telegram_offer: "📨 Você utiliza Telegram?\n\n1️⃣ Sim\n2️⃣ Não",
  telegram_same_number: "📱 Este mesmo número do WhatsApp também é seu número do Telegram?\n\n1️⃣ Sim\n2️⃣ Não",
  telegram_number: "📱 Informe somente o número usado no Telegram.\n\nExemplo:\n5583999999999",
  telegram_official_invite: "Deseja entrar no grupo oficial da Tropa Pokémon GO no Telegram?\n\n1️⃣ Sim\n2️⃣ Não",
  preferences_choice: [LINE, "📢 Avisos", LINE, "", "Quais avisos deseja receber?", "", "1️⃣ Todos", "2️⃣ Nenhum", "3️⃣ Personalizar", LINE].join("\n"),
  preference_raid: "Receber avisos de Raids?\n\n1️⃣ Sim\n2️⃣ Não",
  preference_event: "Receber avisos de Eventos?\n\n1️⃣ Sim\n2️⃣ Não",
  preference_quiz: "Receber avisos do Quiz?\n\n1️⃣ Sim\n2️⃣ Não",
  preference_news: "Receber novidades do MikaBot?\n\n1️⃣ Sim\n2️⃣ Não",
  privacy_choice: [LINE, "🔒 Privacidade", LINE, "", "1️⃣ Tudo público", "2️⃣ Tudo privado", "3️⃣ Personalizar", LINE].join("\n"),
  privacy_friend_code: "Permitir mostrar seu Friend Code publicamente?\n\n1️⃣ Sim\n2️⃣ Não",
  privacy_secondary: "Permitir mostrar suas contas secundárias?\n\n1️⃣ Sim\n2️⃣ Não"
};
const PRIVACY_GROUP_GUIDANCE = "🔒 Por segurança, configure sua privacidade conversando comigo no privado.";
const privacyMenu = () => [LINE, "🔒 PRIVACIDADE", LINE, "", "1️⃣ Nick", "", "2️⃣ Friend Code", "", "3️⃣ Contas secundárias", "", "0️⃣ Voltar", "", "9️⃣ Cancelar", "", LINE].join("\n");
const privacyChoice = (label, current) => [label, "", "Atual:", current ? "✅ Público" : "🔒 Privado", ...(["Nick", "Friend Code"].includes(label) ? ["", "💡 Recomendado: Visível"] : []), "", "1️⃣ Público", "", "2️⃣ Privado", "", "0️⃣ Voltar", "", "9️⃣ Cancelar"].join("\n");

function createRegistrationGuidedFlowService(options = {}) {
  const flows = options.guidedFlowService || guidedFlowDefault;
  const registrations = options.registrationService || registrationDefault;
  const memberExperience = options.memberExperienceService || (options.registrationService ? {
    registrationCompleted: async () => ({ reward: { granted: false }, text: null })
  } : memberExperienceDefault);
  const editFlow = createRegistrationEditFlowService({ guidedFlowService: flows, registrationService: registrations, inputResolverService: inputResolver });
  const flowArgs = context => [context.platform, context.conversationId || context.groupId, context.userId];
  const reply = (context, text) => context.replyText(text);
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const validateTelegramPhone = value => {
    const digits = clean(value).replace(/\D/g, "");
    return { valid: /^\d{10,15}$/.test(digits), value: /^\d{10,15}$/.test(digits) ? `+${digits}` : "" };
  };
  const whatsappPhone = context => {
    const candidates = [
      ...(context.identity?.candidates || []),
      context.userId
    ];
    for (const candidate of candidates) {
      const raw = String(candidate || "");
      if (/@lid$/i.test(raw)) continue;
      const user = raw.split("@")[0].split(":")[0];
      const result = validateTelegramPhone(user);
      if (result.valid) return result.value;
    }
    return "";
  };
  const formatCode = value => registrations.normalizeFriendCode(value).replace(/(\d{4})(?=\d)/g, "$1 ");
  function team(value) { return inputResolver.resolveMenuOption(value, [{ value: "valor", label: "Valor" }, { value: "mystic", label: "Mystic", aliases: ["sabedoria"] }, { value: "instinct", label: "Instinct", aliases: ["instinto"] }]); }
  function validLevel(value) { const normalized = inputResolver.normalizeInput(value); return /^\d+$/.test(normalized) && Number(normalized) >= 1 ? Number(normalized) : null; }
  function validSchedule(value) { const normalized = clean(value); return normalized && normalized.length <= 120 && !/\$\{[^}]+\}/.test(normalized) ? normalized : null; }

  function review(data) {
    const secondary = (data.secondaryAccounts || []).length ? (data.secondaryAccounts || []).flatMap((account, index) => ["", `📱 Secundária ${index + 1}: ${account.nick}`, `🆔 ${formatCode(account.friendCode)} · ${TEAM_LABELS[account.team]} · Nível ${account.level}`]) : ["", "📱 Contas secundárias: nenhuma"];
    const telegram = registrations.normalizeTelegram(data.contacts?.telegram || {}), preferences = registrations.normalizePreferences(data.preferences), privacy = registrations.normalizePrivacy(data.privacy);
    const telegramLabel = data.telegramContactMode === "same_number" ? "Mesmo número do WhatsApp" : data.telegramContactMode === "informed_number" ? "Número informado" : telegram.username;
    const telegramLines = telegram.enabled ? ["", "📨 Telegram", telegramLabel] : ["", "📨 Telegram", "Não utilizado"];
    const noticeSummary = [["Raids", preferences.raidNotifications], ["Eventos", preferences.eventNotifications], ["Quiz", preferences.quizNotifications], ["Novidades", preferences.newsNotifications]].map(([label, enabled]) => `${enabled ? "✅" : "❌"} ${label}`).join("\n");
    const noticeMode = Object.values(preferences).every(Boolean) ? "Todos" : Object.values(preferences).every(value => !value) ? "Nenhum" : null;
    const privacySummary = [`Nick: ${privacy.showNick !== false ? "Visível" : "Privado"}`, `Friend Code: ${privacy.showFriendCode ? "Público" : "Privado"}`, `Contas secundárias: ${privacy.showSecondaryAccounts ? "Públicas" : "Privadas"}`, "Telegram: Privado"].join("\n");
    const privacyMode = privacy.showNick !== false && privacy.showFriendCode && privacy.showSecondaryAccounts ? "Tudo público" : privacy.showNick === false && !privacy.showFriendCode && !privacy.showSecondaryAccounts ? "Tudo privado" : null;
    return withNavigation([LINE, "📋 REVISE SEU CADASTRO", LINE, "", `👤 Nome: ${data.name}`, `🎮 Nick: ${data.nick}`, `🆔 Friend Code: ${formatCode(data.friendCode)}`, `🛡️ Time: ${TEAM_LABELS[data.team]} · Nível ${data.level}`, `📍 Cidade: ${data.city}`, `✈️ Fly: ${data.fly ? "Sim" : "Não"} · 🚶 Canela: ${data.canela ? "Sim" : "Não"}`, `🕒 Horários: ${data.playSchedule}`, ...secondary, ...telegramLines, "", "📢 Avisos", ...(noticeMode ? [noticeMode] : []), noticeSummary, "", "🔒 Privacidade", ...(privacyMode ? [privacyMode] : []), privacySummary, "", LINE, "", "1️⃣ Confirmar", "2️⃣ Editar", "3️⃣ Salvar para depois", "4️⃣ Cancelar", LINE].join("\n"), "review");
  }
  const editPrompt = ["📋 Qual informação deseja corrigir?", "", "1️⃣ Nome", "2️⃣ Nick principal", "3️⃣ Friend Code", "4️⃣ Time", "• Cidade — digite: cidade", "• Nível — digite: nível", "• Fly — digite: fly", "• Canela — digite: canela", "• Horários — digite: horários", "🔟 Voltar para revisão"].join("\n");
  function completion(data) { return [LINE, "✅ CADASTRO CONCLUÍDO!", LINE, "", "Seu cadastro foi salvo com sucesso.", "", `🎮 Nick:\n${data.nick}`, "", `🆔 Friend Code:\n${formatCode(data.friendCode)}`, "", "Agora você já pode utilizar os recursos do MikaBot que dependem de cadastro.", LINE].join("\n"); }

  async function start(context) {
    if (context.isGroup) { await reply(context, GROUP_GUIDANCE); return { status: "group_guidance" }; }
    const registration = await registrations.getRegistrationByIdentity({ id: context.userId, candidates: context.identity?.candidates || [] });
    if (registration?.status === "active" && !["invalid_placeholder", "review_required"].includes(registration.validationStatus)) {
      const stale = await flows.getActiveFlow(...flowArgs(context));
      if (stale?.flowId === "registration") await flows.cancelFlow(...flowArgs(context));
      return editFlow.start(context);
    }
    const existing = await flows.getActiveFlow(...flowArgs(context));
    if (existing?.flowId === "registration") {
      const resumeStep = existing.step === "draft_choice" ? existing.data.resumeStep : existing.step === "draft_paused" ? existing.data.resumeStep : existing.step;
      await flows.updateFlow(...flowArgs(context), { step: "draft_choice", data: { ...existing.data, resumeStep } });
      await reply(context, "📋 Você possui um cadastro em andamento.\n\n1️⃣ Continuar\n2️⃣ Recomeçar\n3️⃣ Cancelar rascunho");
      return { status: "draft_found" };
    }
    if (existing) { await reply(context, "⚠️ Você já possui outro fluxo em andamento. Continue respondendo ou use !cancelar."); return { status: "conflict" }; }
    const result = await flows.startFlow({ flowId: "registration", platform: context.platform, conversationId: context.conversationId || context.groupId, userId: context.userId, step: "confirm_start", data: {} });
    await reply(context, withNavigation(START, "confirm_start")); return { status: "started", session: result.session };
  }

  async function startPrivacy(context) {
    if (context.isGroup) { await reply(context, PRIVACY_GROUP_GUIDANCE); return { status: "group_guidance" }; }
    const current = await registrations.getPrivacy(context.userId);
    if (!current) { await reply(context, "❌ Cadastro não encontrado. Conclua primeiro o seu cadastro enviando:\n\ncadastro"); return { status: "not_registered" }; }
    const existing = await flows.getActiveFlow(...flowArgs(context));
    if (existing) { await reply(context, "⚠️ Você já possui outro fluxo em andamento. Continue respondendo ou use !cancelar."); return { status: "conflict" }; }
    const result = await flows.startFlow({ flowId: "registration_privacy", platform: context.platform, conversationId: context.conversationId || context.groupId, userId: context.userId, step: "privacy_menu", data: { privacy: current } });
    await reply(context, privacyMenu()); return { status: "started", session: result.session };
  }
  const startEdit = context => editFlow.start(context);
  async function startReturnRevalidation(context, data = {}) {
    const existing = await flows.getActiveFlow(...flowArgs(context)); if (existing) await flows.cancelFlow(...flowArgs(context));
    const result = await flows.startFlow({ flowId: "join_return_revalidation", platform: context.platform, conversationId: context.conversationId || context.groupId, userId: context.userId, step: "choice", data });
    await reply(context, [`👋 Faz mais de ${data.days || 7} dias desde sua saída.`, "", "Precisamos confirmar se seus dados continuam atualizados.", "", "1️⃣ Confirmar dados atuais", "2️⃣ Atualizar cadastro", "3️⃣ Cancelar retorno"].join("\n"));
    return { status: "started", session: result.session };
  }
  async function handleReturnRevalidation(context, text) {
    const choice = inputResolver.resolveMenuOption(text, [{ value: "confirm", number: 1, aliases: ["confirmar dados atuais"] }, { value: "edit", number: 2, aliases: ["atualizar cadastro"] }, { value: "cancel", number: 3, aliases: ["cancelar retorno"] }]);
    if (choice === "cancel" || inputResolver.resolveNavigation(text) === "cancel") { await flows.cancelFlow(...flowArgs(context)); await require("./joinRequestService").handleRegistrationCancelled(context); await reply(context, "❌ Retorno cancelado. Seu cadastro e progresso foram preservados."); return { status: "cancelled" }; }
    if (choice === "confirm") { await flows.finishFlow(...flowArgs(context)); const results = await require("./joinRequestService").completeReturnRevalidation(context); return { status: results.some(item => item.status === "approved") ? "approved" : "approval_failed", results }; }
    if (choice === "edit") { await flows.finishFlow(...flowArgs(context)); await require("./joinRequestService").markRevalidationEditing(context.userId); return startEdit(context); }
    await reply(context, "❌ Escolha 1, 2 ou 3."); return { status: "validation_error" };
  }

  async function handlePrivacyAnswer(context, text, session) {
    const navigation = inputResolver.resolveNavigation(text);
    if (navigation === "cancel") { await flows.cancelFlow(...flowArgs(context)); await reply(context, "❌ Configuração de privacidade cancelada."); return { status: "cancelled" }; }
    if (session.step === "privacy_menu") {
      if (["menu", "back"].includes(navigation)) { await flows.finishFlow(...flowArgs(context)); await reply(context, "✅ Configuração de privacidade encerrada."); return { status: "back" }; }
      const choice = inputResolver.resolveMenuOption(text, [{ value: "nick", number: 1, aliases: ["nick"] }, { value: "friendCode", number: 2, aliases: ["friend code"] }, { value: "secondaryAccounts", number: 3, aliases: ["contas secundárias", "contas secundarias"] }]);
      if (!choice) { await reply(context, "❌ Escolha 1, 2, 3, 0 ou 9."); return { status: "validation_error" }; }
      const step = choice === "nick" ? "privacy_set_nick" : choice === "friendCode" ? "privacy_set_friend_code" : "privacy_set_secondary_accounts";
      await flows.advanceFlow(...flowArgs(context), step, { selectedPrivacy: choice });
      const label = choice === "nick" ? "Nick" : choice === "friendCode" ? "Friend Code" : "Contas secundárias";
      const current = choice === "nick" ? session.data.privacy.showNick !== false : choice === "friendCode" ? session.data.privacy.showFriendCode : session.data.privacy.showSecondaryAccounts;
      await reply(context, privacyChoice(label, current));
      return { status: "selecting", field: choice };
    }
    if (["menu", "back"].includes(navigation)) { await flows.advanceFlow(...flowArgs(context), "privacy_menu", { selectedPrivacy: null }); await reply(context, privacyMenu()); return { status: "back" }; }
    const visible = inputResolver.resolveYesNo(text);
    if (visible === null) { await reply(context, "❌ Escolha 1 para Público, 2 para Privado, 0 para Voltar ou 9 para Cancelar."); return { status: "validation_error" }; }
    const field = session.step === "privacy_set_nick" ? "showNick" : session.step === "privacy_set_friend_code" ? "showFriendCode" : "showSecondaryAccounts";
    const saved = field === "showNick" ? await registrations.setNickVisibility(context.userId, visible) : field === "showFriendCode" ? await registrations.setFriendCodeVisibility(context.userId, visible) : await registrations.setSecondaryAccountsVisibility(context.userId, visible);
    await flows.updateFlow(...flowArgs(context), { step: "privacy_menu", data: { privacy: saved.privacy } });
    await reply(context, "✅ Preferência atualizada com sucesso.\n\n" + privacyMenu());
    return { status: "updated", field, value: visible, registration: saved };
  }

  async function advance(context, step, changes = {}, message = PROMPTS[step]) { const session = await flows.advanceFlow(...flowArgs(context), step, changes); if (message) await reply(context, withNavigation(message, step)); return { status: "advanced", session }; }
  function validateField(field, raw) {
    if (field === "name") return registrations.validateName(raw);
    if (field === "nick") return registrations.validateNick(raw);
    if (field === "friendCode") { const result = registrations.validateFriendCode(raw); return { ...result, error: "❌ Friend Code inválido.\n\nDigite os 12 números do código." }; }
    if (field === "team") { const value = team(raw); return { valid: Boolean(value), value, error: "❌ Time inválido. Escolha Valor, Mystic ou Instinct." }; }
    if (field === "city") return registrations.validateCity(raw);
    if (field === "level") { const value = validLevel(raw); return { valid: Boolean(value), value, error: "❌ Nível inválido.\n\nDigite um número inteiro a partir de 1." }; }
    if (["fly", "canela"].includes(field)) { const value = inputResolver.resolveYesNo(raw); return { valid: typeof value === "boolean", value, error: "❌ Responda 1 para Sim ou 2 para Não." }; }
    if (field === "playSchedule") { const value = validSchedule(raw); return { valid: Boolean(value), value, error: "❌ Informe um horário ou período válido." }; }
    return { valid: false, error: "Campo inválido." };
  }
  async function storeField(session, context, field, text) {
    const result = validateField(field, text); if (!result.valid) { await reply(context, `❌ ${result.error.replace(/^❌\s*/, "")}`); return { status: "validation_error" }; }
    if (session.data.editingField) {
      const updated = await flows.advanceFlow(...flowArgs(context), "review", { [field]: result.value, editingField: null });
      await reply(context, review(updated.data)); return { status: "review", session: updated };
    }
    const next = STEPS[STEPS.indexOf(field) + 1];
    if (!next) { const updated = await flows.advanceFlow(...flowArgs(context), "secondary_offer", { [field]: result.value, secondaryAccounts: session.data.secondaryAccounts || [] }); await reply(context, withNavigation("Deseja cadastrar uma conta secundária?\n\n1️⃣ Sim\n2️⃣ Não", "secondary_offer")); return { status: "secondary_offer", session: updated }; }
    return advance(context, next, { [field]: result.value });
  }

  async function handleAnswer(context, text) {
    if (context.isGroup) return { status: "ignored" };
    const session = await flows.getActiveFlow(...flowArgs(context)); if (!session) return { status: "ignored" };
    if (session.flowId === "join_return_revalidation") return handleReturnRevalidation(context, text);
    if (session.flowId === "registration_edit") { const result = await editFlow.handle(context, text, session); if (result?.status === "finished") await require("./joinRequestService").completeReturnRevalidation(context); return result; }
    if (session.flowId === "registration_privacy") return handlePrivacyAnswer(context, text, session);
    if (session.flowId !== "registration") return { status: "ignored" };
    const control = inputResolver.normalizeInput(text);
    const navigation = inputResolver.resolveNavigation(text);
    const promptForStep = step => PROMPTS[step] || SECONDARY_PROMPTS[step] || PRIVATE_STEPS[step] || START;
    const currentPrompt = () => session.step === "review" ? review(session.data) : session.step === "edit_select" ? withNavigation(editPrompt, session.step) : session.step === "confirm_start" ? withNavigation(START, session.step) : withNavigation(PROMPTS[session.step] || SECONDARY_PROMPTS[session.step] || PRIVATE_STEPS[session.step] || START, session.step);
    if (navigation === "cancel") { await flows.cancelFlow(...flowArgs(context)); await require("./joinRequestService").handleRegistrationCancelled(context); await reply(context, "❌ Cadastro cancelado."); return { status: "cancelled" }; }
    if (navigation === "repeat" || navigation === "menu") { await reply(context, currentPrompt()); return { status: navigation }; }
    if (navigation === "draft" && !["confirm_start", "draft_choice"].includes(session.step)) { await flows.updateFlow(...flowArgs(context), { step: "draft_paused", data: { ...session.data, resumeStep: session.step } }); await reply(context, "💾 Cadastro salvo como rascunho.\n\nPara continuar depois, envie:\n\ncadastro"); return { status: "draft_saved" }; }
    if (navigation === "back") {
      const currentIndex = STEPS.indexOf(session.step);
      const contextualBack = {
        secondary_offer: "playSchedule",
        preferences_choice: "secondary_offer",
        telegram_offer: "privacy_choice",
        telegram_same_number: "telegram_offer",
        telegram_number: "telegram_same_number",
        telegram_official_invite: "telegram_same_number",
        preference_raid: "preferences_choice",
        preference_event: "preference_raid",
        preference_quiz: "preference_event",
        preference_news: "preference_quiz",
        privacy_choice: "preferences_choice",
        privacy_friend_code: "privacy_choice",
        privacy_secondary: "privacy_friend_code"
      };
      const previousStep = currentIndex > 0 ? STEPS[currentIndex - 1] : session.step === "review" ? "telegram_offer" : session.step === "edit_select" ? "review" : contextualBack[session.step] || "confirm_start";
      const previous = await flows.updateFlow(...flowArgs(context), { step: previousStep, data: { ...session.data, editingField: null } });
      await reply(context, previousStep === "review" ? review(previous.data) : previousStep === "confirm_start" ? withNavigation(START, previousStep) : withNavigation(promptForStep(previousStep), previousStep));
      return { status: "back", session: previous };
    }
    if (navigation === "confirm" && !["confirm_start", "review"].includes(session.step)) { await reply(context, `ℹ️ Complete as perguntas antes de confirmar.\n\n${currentPrompt()}`); return { status: "not_ready" }; }
    if (session.step === "confirm_start") { const answer = inputResolver.resolveYesNo(text); if (answer === false) { await flows.cancelFlow(...flowArgs(context)); await require("./joinRequestService").handleRegistrationCancelled(context); await reply(context, "❌ Cadastro cancelado."); return { status: "cancelled" }; } if (answer !== true) { await reply(context, "❌ Escolha 1 para começar ou 2 para cancelar."); return { status: "validation_error" }; } return advance(context, "name"); }
    if (session.step === "draft_choice") {
      const choice = inputResolver.resolveMenuOption(text, [{ value: "continue", aliases: ["continuar", "prosseguir"] }, { value: "restart", aliases: ["recomecar", "recomeçar"] }, { value: "cancel_draft", aliases: ["cancelar rascunho"] }]);
      if (choice === "continue") { const step = session.data.resumeStep || "name"; await flows.updateFlow(...flowArgs(context), { step }); await reply(context, step === "review" ? review(session.data) : withNavigation(PROMPTS[step], step)); return { status: "resumed" }; }
      if (choice === "restart") { await flows.cancelFlow(...flowArgs(context)); return start(context); }
      if (choice === "cancel_draft") { await flows.cancelFlow(...flowArgs(context)); await require("./joinRequestService").handleRegistrationCancelled(context); await reply(context, "❌ Cadastro cancelado."); return { status: "cancelled" }; }
      await reply(context, "❌ Escolha 1, 2 ou 3."); return { status: "validation_error" };
    }
    if (session.step === "secondary_offer") {
      const answer = inputResolver.resolveYesNo(text);
      if (answer === true) return advance(context, "secondary_nick", { pendingSecondary: {} }, SECONDARY_PROMPTS.secondary_nick);
      if (answer === false) {
        if (session.data.settingsCompleted) { const updated = await flows.advanceFlow(...flowArgs(context), "review", {}); await reply(context, review(updated.data)); return { status: "review", session: updated }; }
        return advance(context, "preferences_choice", { secondaryPromptShown: true, contacts: session.data.contacts || registrations.getDefaultContacts(), preferences: session.data.preferences || registrations.getDefaultPreferences(), privacy: session.data.privacy || registrations.getDefaultPrivacy() }, PRIVATE_STEPS.preferences_choice);
      }
      await reply(context, "❌ Responda Sim ou Não."); return { status: "validation_error" };
    }
    if (["secondary_nick", "secondary_friendCode", "secondary_team", "secondary_level"].includes(session.step)) {
      const field = { secondary_nick: "nick", secondary_friendCode: "friendCode", secondary_team: "team", secondary_level: "level" }[session.step];
      const result = validateField(field, text); if (!result.valid) { await reply(context, result.error); return { status: "validation_error" }; }
      const pending = { ...(session.data.pendingSecondary || {}), [field]: result.value };
      if (session.step !== "secondary_level") { const next = { secondary_nick: "secondary_friendCode", secondary_friendCode: "secondary_team", secondary_team: "secondary_level" }[session.step]; return advance(context, next, { pendingSecondary: pending }, SECONDARY_PROMPTS[next]); }
      const all = [session.data.mainAccount || { nick: session.data.nick, friendCode: session.data.friendCode }, ...(session.data.secondaryAccounts || [])];
      if (all.some(account => inputResolver.normalizeInput(account.nick) === inputResolver.normalizeInput(pending.nick))) { await reply(context, "❌ Nick duplicado neste cadastro."); return { status: "validation_error" }; }
      if (all.some(account => registrations.normalizeFriendCode(account.friendCode) === pending.friendCode)) { await reply(context, "❌ Friend Code duplicado neste cadastro."); return { status: "validation_error" }; }
      return advance(context, "secondary_offer", { secondaryAccounts: [...(session.data.secondaryAccounts || []), pending], pendingSecondary: null }, "Deseja cadastrar outra conta secundária?\n\n1️⃣ Sim\n2️⃣ Não");
    }
    if (session.step === "telegram_offer") { const answer = inputResolver.resolveYesNo(text); if (answer === true) return advance(context, "telegram_same_number", { contacts: { telegram: { enabled: true, username: "" } } }, PRIVATE_STEPS.telegram_same_number); if (answer === false) { const updated = await flows.advanceFlow(...flowArgs(context), "review", { contacts: registrations.getDefaultContacts(), settingsCompleted: true }); await reply(context, review(updated.data)); return { status: "review", session: updated }; } await reply(context, "❌ Responda Sim ou Não."); return { status: "validation_error" }; }
    if (session.step === "telegram_username") return advance(context, "telegram_same_number", { contacts: { telegram: { enabled: true, username: "" } } }, PRIVATE_STEPS.telegram_same_number);
    if (session.step === "telegram_same_number") {
      const answer = inputResolver.resolveYesNo(text);
      if (answer === false) return advance(context, "telegram_number", {}, PRIVATE_STEPS.telegram_number);
      if (answer === true) {
        const phone = whatsappPhone(context);
        if (!phone) return advance(context, "telegram_number", {}, PRIVATE_STEPS.telegram_number);
        return advance(context, "telegram_official_invite", { contacts: { telegram: { enabled: true, username: phone } }, telegramContactMode: "same_number" }, PRIVATE_STEPS.telegram_official_invite);
      }
      await reply(context, "❌ Responda Sim ou Não."); return { status: "validation_error" };
    }
    if (session.step === "telegram_number") { const result = validateTelegramPhone(text); if (!result.valid) { await reply(context, "❌ Número do Telegram inválido."); return { status: "validation_error" }; } return advance(context, "telegram_official_invite", { contacts: { telegram: { enabled: true, username: result.value } }, telegramContactMode: "informed_number" }, PRIVATE_STEPS.telegram_official_invite); }
    if (session.step === "telegram_official_invite") {
      const answer = inputResolver.resolveYesNo(text);
      if (answer === null) { await reply(context, "❌ Responda Sim ou Não."); return { status: "validation_error" }; }
      if (answer) await reply(context, OFFICIAL_TELEGRAM_MESSAGE);
      const updated = await flows.advanceFlow(...flowArgs(context), "review", { settingsCompleted: true });
      await reply(context, review(updated.data)); return { status: "review", session: updated };
    }
    if (session.step === "preferences_choice") {
      const choice = inputResolver.resolveMenuOption(text, [{ value: "all", number: 1, aliases: ["todos", "tudo"] }, { value: "none", number: 2, aliases: ["nenhum", "nenhuma"] }, { value: "custom", number: 3, aliases: ["personalizar", "personalizado"] }]);
      if (choice === "custom") return advance(context, "preference_raid", {}, PRIVATE_STEPS.preference_raid);
      if (choice === "all" || choice === "none") {
        const enabled = choice === "all";
        if (session.data.settingsCompleted) { const updated = await flows.advanceFlow(...flowArgs(context), "review", { preferences: registrations.normalizePreferences({ raidNotifications: enabled, eventNotifications: enabled, quizNotifications: enabled, newsNotifications: enabled }) }); await reply(context, review(updated.data)); return { status: "review", session: updated }; }
        return advance(context, "privacy_choice", { preferences: registrations.normalizePreferences({ raidNotifications: enabled, eventNotifications: enabled, quizNotifications: enabled, newsNotifications: enabled }) }, PRIVATE_STEPS.privacy_choice);
      }
      await reply(context, "❌ Escolha 1, 2 ou 3."); return { status: "validation_error" };
    }
    const preferenceMap = { preference_raid: ["raidNotifications", "preference_event"], preference_event: ["eventNotifications", "preference_quiz"], preference_quiz: ["quizNotifications", "preference_news"], preference_news: ["newsNotifications", "privacy_choice"] };
    if (preferenceMap[session.step]) { const answer = inputResolver.resolveYesNo(text); if (answer === null) { await reply(context, "❌ Responda Sim ou Não."); return { status: "validation_error" }; } const [field, next] = preferenceMap[session.step], preferences = registrations.normalizePreferences({ ...(session.data.preferences || {}), [field]: answer }); if (session.data.settingsCompleted && session.step === "preference_news") { const updated = await flows.advanceFlow(...flowArgs(context), "review", { preferences }); await reply(context, review(updated.data)); return { status: "review", session: updated }; } return advance(context, next, { preferences }, PRIVATE_STEPS[next]); }
    if (session.step === "privacy_choice") {
      const choice = inputResolver.resolveMenuOption(text, [{ value: "public", number: 1, aliases: ["tudo publico", "tudo público"] }, { value: "private", number: 2, aliases: ["tudo privado"] }, { value: "custom", number: 3, aliases: ["personalizar", "personalizada"] }]);
      if (choice === "custom") return advance(context, "privacy_friend_code", {}, PRIVATE_STEPS.privacy_friend_code);
      if (choice === "public" || choice === "private") {
        const visible = choice === "public";
        if (session.data.settingsCompleted) { const updated = await flows.advanceFlow(...flowArgs(context), "review", { privacy: registrations.normalizePrivacy({ showNick: visible, showFriendCode: visible, showSecondaryAccounts: visible }) }); await reply(context, review(updated.data)); return { status: "review", session: updated }; }
        return advance(context, "telegram_offer", { privacy: registrations.normalizePrivacy({ showNick: visible, showFriendCode: visible, showSecondaryAccounts: visible }) }, PRIVATE_STEPS.telegram_offer);
      }
      await reply(context, "❌ Escolha 1, 2 ou 3."); return { status: "validation_error" };
    }
    if (session.step === "privacy_friend_code") { const answer = inputResolver.resolveYesNo(text); if (answer === null) { await reply(context, "❌ Responda Sim ou Não."); return { status: "validation_error" }; } return advance(context, "privacy_secondary", { privacy: registrations.normalizePrivacy({ ...(session.data.privacy || {}), showFriendCode: answer }) }, PRIVATE_STEPS.privacy_secondary); }
    if (session.step === "privacy_secondary") { const answer = inputResolver.resolveYesNo(text); if (answer === null) { await reply(context, "❌ Responda Sim ou Não."); return { status: "validation_error" }; } const privacy = registrations.normalizePrivacy({ ...(session.data.privacy || {}), showSecondaryAccounts: answer }); if (session.data.settingsCompleted) { const updated = await flows.advanceFlow(...flowArgs(context), "review", { privacy }); await reply(context, review(updated.data)); return { status: "review", session: updated }; } return advance(context, "telegram_offer", { privacy }, PRIVATE_STEPS.telegram_offer); }
    if (session.step === "review") {
      const choice = navigation === "confirm" ? "confirm" : navigation === "draft" ? "draft" : inputResolver.resolveMenuOption(text, [{ value: "confirm", number: 1, aliases: ["confirmar cadastro"] }, { value: "edit", number: 2, aliases: ["editar", "corrigir"] }, { value: "draft", number: 3, aliases: ["rascunho"] }, { value: "cancel_legacy", number: 4, aliases: ["cancelar cadastro"] }, { value: "add_account", number: 11, aliases: ["adicionar conta"] }, { value: "edit_main", number: 12, aliases: ["editar conta principal"] }, { value: "edit_secondary", number: 13, aliases: ["editar conta secundaria", "editar conta secundária"] }, { value: "remove_secondary", number: 14, aliases: ["remover conta secundaria", "remover conta secundária"] }, { value: "edit_telegram", number: 15, aliases: ["editar telegram"] }, { value: "edit_preferences", number: 16, aliases: ["editar preferencias", "editar preferências"] }, { value: "edit_privacy", number: 17, aliases: ["editar privacidade"] }]);
      if (choice === "confirm") {
        const data = session.data;
        const previous = await registrations.getRegistrationByIdentity(context.identity || { id: context.userId });
        const saved = await registrations.upsertRegistration({ primaryIdentity: context.userId, identityAliases: context.identity?.candidates || [], name: data.name, nick: data.nick, friendCode: data.friendCode, city: data.city, mainAccount: { nick: data.nick, friendCode: data.friendCode, team: data.team, level: data.level }, secondaryAccounts: data.secondaryAccounts || [], contacts: data.contacts, preferences: data.preferences, privacy: data.privacy, playStyle: { fly: data.fly, canela: data.canela }, playSchedule: data.playSchedule, source: "guided_private" });
        await flows.finishFlow(...flowArgs(context));
        let experience = { reward: { granted: false }, text: null };
        try { experience = await memberExperience.registrationCompleted(context, saved, !previous); } catch (_) { /* cadastro já foi persistido; experiência é complementar */ }
        const joinResults = await require("./joinRequestService").handleRegistrationCompleted(context);
        if (!joinResults?.length) await reply(context, experience.text || completion(data));
        return { status: "finished", registration: saved, reward: experience.reward };
      }
      if (choice === "edit") return advance(context, "edit_select", {}, editPrompt);
      if (choice === "add_account") return advance(context, "secondary_nick", { pendingSecondary: {} }, SECONDARY_PROMPTS.secondary_nick);
      if (choice === "edit_main") return advance(context, "main_account_edit", {}, "📋 O que deseja editar na conta principal?\n\n1️⃣ Nick\n2️⃣ Friend Code\n3️⃣ Time\n4️⃣ Nível");
      if (choice === "edit_telegram") return advance(context, "telegram_offer", {}, PRIVATE_STEPS.telegram_offer);
      if (choice === "edit_preferences") return advance(context, "preferences_choice", {}, PRIVATE_STEPS.preferences_choice);
      if (choice === "edit_privacy") return advance(context, "privacy_choice", {}, PRIVATE_STEPS.privacy_choice);
      if (["edit_secondary", "remove_secondary"].includes(choice)) { const accounts = session.data.secondaryAccounts || []; if (!accounts.length) { await reply(context, "❌ Não há contas secundárias cadastradas."); return { status: "validation_error" }; } return advance(context, choice === "edit_secondary" ? "secondary_edit_select" : "secondary_remove_select", {}, ["📱 Escolha a conta secundária:", "", ...accounts.map((account, index) => `${index + 1}️⃣ ${account.nick}`)].join("\n")); }
      if (choice === "draft") { await flows.updateFlow(...flowArgs(context), { step: "draft_paused", data: { ...session.data, resumeStep: "review" } }); await reply(context, "💾 Cadastro salvo como rascunho.\n\nPara continuar depois, envie:\n\ncadastro"); return { status: "draft_saved" }; }
      if (choice === "cancel_legacy") { await flows.cancelFlow(...flowArgs(context)); await require("./joinRequestService").handleRegistrationCancelled(context); await reply(context, "❌ Cadastro cancelado."); return { status: "cancelled" }; }
      await reply(context, "❌ Escolha uma opção entre 1 e 4."); return { status: "validation_error" };
    }
    if (session.step === "main_account_edit") { const field = inputResolver.resolveMenuOption(text, [{ value: "nick", label: "nick" }, { value: "friendCode", label: "friend code", aliases: ["codigo", "código"] }, { value: "team", label: "time" }, { value: "level", label: "nivel", aliases: ["nível"] }]); if (!field) { await reply(context, "❌ Escolha uma opção entre 1 e 4."); return { status: "validation_error" }; } await flows.advanceFlow(...flowArgs(context), field, { editingField: field }); await reply(context, withNavigation(PROMPTS[field], field)); return { status: "editing_main", field }; }
    if (session.step === "secondary_edit_select") { const accounts = session.data.secondaryAccounts || [], index = inputResolver.resolveMenuOption(text, accounts.map((account, i) => ({ value: i, label: account.nick }))); if (index === null) { await reply(context, "❌ Conta inválida."); return { status: "validation_error" }; } return advance(context, "secondary_edit_field", { editingSecondaryIndex: index }, "📋 O que deseja editar?\n\n1️⃣ Nick\n2️⃣ Friend Code\n3️⃣ Time\n4️⃣ Nível"); }
    if (session.step === "secondary_edit_field") { const field = inputResolver.resolveMenuOption(text, [{ value: "nick", label: "nick" }, { value: "friendCode", label: "friend code", aliases: ["codigo", "código"] }, { value: "team", label: "time" }, { value: "level", label: "nivel", aliases: ["nível"] }]); if (!field) { await reply(context, "❌ Escolha uma opção entre 1 e 4."); return { status: "validation_error" }; } return advance(context, `secondary_edit_${field}`, { editingSecondaryField: field }, SECONDARY_PROMPTS[`secondary_${field}`] || PROMPTS[field]); }
    if (session.step.startsWith("secondary_edit_")) { const field = session.data.editingSecondaryField, result = validateField(field, text); if (!result.valid) { await reply(context, result.error); return { status: "validation_error" }; } const accounts = [...session.data.secondaryAccounts], current = accounts[session.data.editingSecondaryIndex], candidate = { ...current, [field]: result.value }; const others = [{ nick: session.data.nick, friendCode: session.data.friendCode }, ...accounts.filter((_, index) => index !== session.data.editingSecondaryIndex)]; if (field === "nick" && others.some(account => inputResolver.normalizeInput(account.nick) === inputResolver.normalizeInput(result.value))) { await reply(context, "❌ Nick duplicado neste cadastro."); return { status: "validation_error" }; } if (field === "friendCode" && others.some(account => registrations.normalizeFriendCode(account.friendCode) === result.value)) { await reply(context, "❌ Friend Code duplicado neste cadastro."); return { status: "validation_error" }; } accounts[session.data.editingSecondaryIndex] = candidate; const updated = await flows.advanceFlow(...flowArgs(context), "review", { secondaryAccounts: accounts, editingSecondaryField: null, editingSecondaryIndex: null }); await reply(context, review(updated.data)); return { status: "review" }; }
    if (session.step === "secondary_remove_select") { const accounts = [...(session.data.secondaryAccounts || [])], index = inputResolver.resolveMenuOption(text, accounts.map((account, i) => ({ value: i, label: account.nick }))); if (index === null) { await reply(context, "❌ Conta inválida."); return { status: "validation_error" }; } accounts.splice(index, 1); const updated = await flows.advanceFlow(...flowArgs(context), "review", { secondaryAccounts: accounts }); await reply(context, review(updated.data)); return { status: "removed" }; }
    if (session.step === "edit_select") { const labels = { name: ["nome"], nick: ["nick", "nick principal"], friendCode: ["friend code", "codigo", "código"], team: ["time"], city: ["cidade"], level: ["nivel", "nível"], fly: ["fly"], canela: ["canela"], playSchedule: ["horarios", "horários"] }; const field = inputResolver.resolveMenuOption(text, [...STEPS.map((value, index) => ({ value, label: value, aliases: labels[value], number: index + 1 })), { value: "review", number: 10, aliases: ["revisao", "revisão"] }]); if (field === "review") { await flows.updateFlow(...flowArgs(context), { step: "review" }); await reply(context, review(session.data)); return { status: "review" }; } if (!STEPS.includes(field)) { await reply(context, "❌ Escolha uma opção entre 1 e 10."); return { status: "validation_error" }; } await flows.advanceFlow(...flowArgs(context), field, { editingField: field }); await reply(context, withNavigation(PROMPTS[field], field)); return { status: "editing", field }; }
    if (session.step === "draft_paused") return { status: "ignored" };
    return storeField(session, context, session.step, text);
  }

  async function hasActiveFlow(context) { if (context?.isGroup) return false; const session = await flows.getActiveFlow(...flowArgs(context)); return Boolean((session?.flowId === "registration" && session.step !== "draft_paused") || session?.flowId === "registration_privacy" || session?.flowId === "registration_edit" || session?.flowId === "join_return_revalidation"); }
  return { start, startPrivacy, startEdit, startReturnRevalidation, handleAnswer, hasActiveFlow, review, formatCode, validateField, GROUP_GUIDANCE, PRIVACY_GROUP_GUIDANCE, START, PROMPTS, OFFICIAL_TELEGRAM_INVITE };
}

const service = createRegistrationGuidedFlowService();
module.exports = { ...service, createRegistrationGuidedFlowService, GROUP_GUIDANCE, PRIVACY_GROUP_GUIDANCE, START, PROMPTS, OFFICIAL_TELEGRAM_INVITE };
