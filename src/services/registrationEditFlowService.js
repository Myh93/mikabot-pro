"use strict";

const registrationDefault = require("./registrationService");
const inputDefault = require("./inputResolverService");
const { SEPARATOR } = require("./messageStyleService");

const LINE = SEPARATOR;
const GROUP_GUIDANCE = "📝 Para editar seu cadastro com segurança, fale comigo no privado e envie:\n\n!editarcadastro";
const NOT_FOUND = "📊 Você ainda não possui cadastro.\n\nPara começar, envie:\n\ncadastro";
const REVIEW_REQUIRED = "⚠️ Seu cadastro precisa ser revisado.\n\nEnvie:\n\ncadastro";
const MAIN_MENU = [LINE, "👤 MEU CADASTRO", LINE, "", "✅ Cadastro ativo", "", "🔎 Para visualizar, responda: ver", "", "1️⃣ Nome", "2️⃣ Conta principal", "3️⃣ Cidade", "4️⃣ Fly e Canela", "5️⃣ Horários", "6️⃣ Telegram", "7️⃣ Preferências de avisos", "8️⃣ Contas secundárias", "9️⃣ Privacidade", "0️⃣ Sair", "", "Responda com o número ou o nome da opção.", LINE].join("\n");
const FOOTER = "\n\n0️⃣ Voltar\n9️⃣ Cancelar edição";
const menus = {
  main: ["Conta principal", "", "1️⃣ Nick", "2️⃣ Friend Code", "3️⃣ Time", "4️⃣ Nível"].join("\n") + FOOTER,
  style: ["Fly e Canela", "", "1️⃣ Fly", "2️⃣ Canela"].join("\n") + FOOTER,
  telegram: ["Telegram", "", "1️⃣ Possui Telegram", "2️⃣ Usuário", "3️⃣ Nome do grupo", "4️⃣ Link do grupo", "5️⃣ Limpar dados do Telegram"].join("\n") + FOOTER,
  preferences: ["Preferências de avisos", "", "1️⃣ Avisos de Raids", "2️⃣ Avisos de Eventos", "3️⃣ Avisos do Quiz", "4️⃣ Novidades do MikaBot"].join("\n") + FOOTER,
  secondary: ["Contas secundárias", "", "1️⃣ Listar contas", "2️⃣ Adicionar conta", "3️⃣ Editar conta", "4️⃣ Remover conta"].join("\n") + FOOTER,
  privacy: ["🔒 Privacidade", "", "1️⃣ Nick", "2️⃣ Friend Code", "3️⃣ Contas secundárias", "", "Nick e Friend Code visíveis facilitam amizades, Raids e organização do grupo."].join("\n") + FOOTER
};

function createRegistrationEditFlowService(options = {}) {
  const flows = options.guidedFlowService;
  const registrations = options.registrationService || registrationDefault;
  const resolver = options.inputResolverService || inputDefault;
  const input = { ...resolver, resolveMenuOption(value, choices) { return resolver.resolveMenuOption(value, choices.map(choice => typeof choice === "object" ? { ...choice, aliases: [choice.value, ...(choice.aliases || [])] } : choice)); } };
  if (!flows) throw new Error("guidedFlowService é obrigatório.");
  const args = context => [context.platform, context.conversationId || context.groupId, context.userId];
  const reply = (context, text) => context.replyText(String(text));
  const code = value => registrations.normalizeFriendCode(value).replace(/(\d{4})(?=\d)/g, "$1 ");
  const state = value => value ? "✅ Sim" : "❌ Não";
  const visibility = value => value ? "✅ Público" : "🔒 Privado";
  const team = value => input.resolveMenuOption(value, [{ value: "valor", label: "Valor" }, { value: "mystic", label: "Mystic", aliases: ["sabedoria"] }, { value: "instinct", label: "Instinct", aliases: ["instinto"] }]);
  const level = value => /^\d+$/.test(input.normalizeInput(value)) && Number(value) >= 1 ? Number(value) : null;
  async function move(context, step, changes, message) { await flows.advanceFlow(...args(context), step, changes); await reply(context, message); return { status: "advanced", step }; }
  async function menu(context, key = "root") { await flows.updateFlow(...args(context), { step: key === "root" ? "edit_menu" : `${key}_menu` }); await reply(context, key === "root" ? MAIN_MENU : menus[key]); return { status: "menu", menu: key }; }
  async function saved(context, result, message = "✅ Alteração salva com sucesso.") { const registration = result?.registrationId ? result : await registrations.getRegistrationByIdentity(context.userId); await flows.updateFlow(...args(context), { step: "edit_menu", data: { registration } }); await reply(context, `${message}\n\n${MAIN_MENU}`); return { status: "updated", registration }; }
  function listSecondary(registration) { const accounts = registration.secondaryAccounts || []; return accounts.length ? ["📱 Contas secundárias", "", ...accounts.flatMap((account, index) => [`${index + 1}️⃣ ${account.nick}`, `🆔 ${code(account.friendCode)}`, `🛡️ ${account.team}`, `⭐ Nível ${account.level}`, ""])].join("\n").trim() : "📱 Nenhuma conta secundária cadastrada."; }
  function viewRegistration(registration) { const main = registration.mainAccount || {}; return [LINE, "👤 MEU CADASTRO", LINE, "", `Nome: ${registration.name}`, `Nick: ${main.nick || registration.nick}`, `Friend Code: ${code(main.friendCode || registration.friendCode)}`, `Time: ${main.team || "Não informado"}`, `Nível: ${main.level || "Não informado"}`, `Cidade: ${registration.city || "Não informada"}`, "", listSecondary(registration), "", "0️⃣ Voltar"].join("\n"); }

  async function start(context) {
    if (context.isGroup) { await reply(context, GROUP_GUIDANCE); return { status: "group_guidance" }; }
    const registration = await registrations.getRegistrationByIdentity(context.userId);
    if (!registration) { await reply(context, NOT_FOUND); return { status: "not_registered" }; }
    if (registration.status === "review_required" || registration.validationStatus === "invalid_placeholder") { await reply(context, REVIEW_REQUIRED); return { status: "review_required" }; }
    const existing = await flows.getActiveFlow(...args(context)); if (existing) { await reply(context, "⚠️ Você já possui outro fluxo em andamento. Continue respondendo ou use !cancelar."); return { status: "conflict" }; }
    const result = await flows.startFlow({ flowId: "registration_edit", platform: context.platform, conversationId: context.conversationId || context.groupId, userId: context.userId, step: "edit_menu", data: { registration } });
    await reply(context, MAIN_MENU); return { status: "started", session: result.session };
  }

  async function handle(context, text, session) {
    const normalizedInput = input.normalizeInput(text);
    const resolvedNavigation = input.resolveNavigation(text);
    const nav = resolvedNavigation === "menu" && normalizedInput === "0" ? "back" : resolvedNavigation;
    const rootNumericChoice = session.step === "edit_menu" && /^[1-9]$/.test(normalizedInput);
    if (!rootNumericChoice && nav === "cancel") { await flows.cancelFlow(...args(context)); await reply(context, "❌ Edição cancelada. Alterações já confirmadas foram mantidas."); return { status: "cancelled" }; }
    if (!rootNumericChoice && nav === "repeat") { const prompt = session.data.lastPrompt || (session.step === "edit_menu" ? MAIN_MENU : menus[session.step.replace("_menu", "")] || MAIN_MENU); await reply(context, prompt); return { status: "repeated" }; }
    if (!rootNumericChoice && nav === "menu" && session.step !== "edit_menu") return menu(context);
    if (!rootNumericChoice && nav === "back") {
      if (session.step === "edit_menu") { await flows.finishFlow(...args(context)); await reply(context, "✅ Edição encerrada."); return { status: "finished" }; }
      if (["main_menu", "style_menu", "telegram_menu", "preferences_menu", "secondary_menu", "privacy_menu"].includes(session.step)) return menu(context);
      const parent = session.step.startsWith("main_") ? "main" : session.step.startsWith("style_") ? "style" : session.step.startsWith("telegram_") ? "telegram" : session.step.startsWith("preferences_") ? "preferences" : session.step.startsWith("secondary_") ? "secondary" : session.step.startsWith("privacy_") ? "privacy" : "main";
      return menu(context, parent);
    }
    if (session.step === "edit_menu") {
      const choice = input.resolveMenuOption(text, [
        { value: "name", aliases: ["nome"] }, { value: "main", aliases: ["conta principal"] }, { value: "city", aliases: ["cidade"] }, { value: "style", aliases: ["fly e canela", "fly", "canela"] }, { value: "schedule", aliases: ["horarios", "horários"] }, { value: "telegram", aliases: ["telegram"] }, { value: "preferences", aliases: ["preferencias", "preferências", "avisos"] }, { value: "secondary", aliases: ["contas secundarias", "contas secundárias"] }, { value: "privacy", aliases: ["privacidade"] }, { value: "view", aliases: ["ver", "visualizar", "ver cadastro"] }
      ]);
      if (!choice) { await reply(context, "❌ Opção inválida.\n\n" + MAIN_MENU); return { status: "validation_error" }; }
      if (choice === "view") { await reply(context, viewRegistration(session.data.registration)); return { status: "viewed" }; }
      if (["main", "style", "telegram", "preferences", "secondary", "privacy"].includes(choice)) return menu(context, choice);
      const prompts = { name: `Nome atual:\n${session.data.registration.name}\n\nInforme o novo nome.`, city: `Cidade atual:\n${session.data.registration.city || "Não informada"}\n\nInforme a nova cidade.`, schedule: `Horários atuais:\n${session.data.registration.playSchedule || "Não informados"}\n\nInforme os novos horários.` };
      return move(context, `input_${choice}`, { lastPrompt: prompts[choice] + FOOTER }, prompts[choice] + FOOTER);
    }
    if (session.step.startsWith("input_")) {
      const field = session.step.slice(6); try { return saved(context, await registrations.updateEditableField(context.userId, field === "schedule" ? "playSchedule" : field, text)); } catch (error) { await reply(context, `❌ ${error.message}`); return { status: "validation_error" }; }
    }
    if (session.step === "main_menu") {
      const field = input.resolveMenuOption(text, [{ value: "nick" }, { value: "friendCode", aliases: ["friend code", "codigo", "código"] }, { value: "team", aliases: ["time"] }, { value: "level", aliases: ["nivel", "nível"] }]);
      if (!field) { await reply(context, "❌ Opção inválida.\n\n" + menus.main); return { status: "validation_error" }; }
      const main = session.data.registration.mainAccount, labels = { nick: "Nick", friendCode: "Friend Code", team: "Time", level: "Nível" };
      return move(context, "main_input", { field, lastPrompt: `${labels[field]} atual:\n${field === "friendCode" ? code(main[field]) : main[field]}\n\nInforme o novo valor.${FOOTER}` }, `${labels[field]} atual:\n${field === "friendCode" ? code(main[field]) : main[field]}\n\nInforme o novo valor.${FOOTER}`);
    }
    if (session.step === "main_input") {
      const field = session.data.field; let value = text;
      try {
        if (field === "nick") { const result = registrations.validateNick(text); if (!result.valid) throw new Error(result.error); value = result.value; }
        if (field === "friendCode") { const result = registrations.validateFriendCode(text); if (!result.valid) throw new Error(result.error); value = result.value; }
        if (field === "team") { value = team(text); if (!value) throw new Error("Time inválido."); }
        if (field === "level") { value = level(text); if (!value) throw new Error("Nível inválido."); }
      } catch (error) { await reply(context, `❌ ${error.message}`); return { status: "validation_error" }; }
      if (["nick", "friendCode"].includes(field)) return move(context, "critical_confirm", { critical: { kind: "main", field, value }, lastPrompt: `Confirma alterar ${field === "nick" ? "o Nick" : "o Friend Code"} para:\n\n${field === "friendCode" ? code(value) : value}\n\n1️⃣ Confirmar\n2️⃣ Cancelar${FOOTER}` }, `Confirma alterar ${field === "nick" ? "o Nick" : "o Friend Code"} para:\n\n${field === "friendCode" ? code(value) : value}\n\n1️⃣ Confirmar\n2️⃣ Cancelar${FOOTER}`);
      try { return saved(context, await registrations.updateMainAccount(context.userId, field, value)); } catch (error) { await reply(context, `❌ ${error.message}`); return { status: "validation_error" }; }
    }
    if (session.step === "critical_confirm") {
      const yes = input.resolveYesNo(text); if (yes === null) { await reply(context, "❌ Responda 1 para confirmar ou 2 para cancelar."); return { status: "validation_error" }; }
      if (!yes) return menu(context, session.data.critical.kind.startsWith("secondary") ? "secondary" : session.data.critical.kind === "telegram_clear" ? "telegram" : "main");
      const c = session.data.critical;
      try {
        if (c.kind === "main") return saved(context, await registrations.updateMainAccount(context.userId, c.field, c.value));
        if (c.kind === "telegram_clear") return saved(context, await registrations.updateTelegram(context.userId, {}, { clear: true }), "✅ Dados do Telegram removidos.");
        if (c.kind === "secondary_update") return saved(context, await registrations.updateSecondaryAccount(context.userId, c.accountId, { [c.field]: c.value }));
        if (c.kind === "secondary_remove") return saved(context, await registrations.removeSecondaryAccount(context.userId, c.accountId), "✅ Conta secundária removida.");
      } catch (error) { await reply(context, `❌ ${error.message}`); return { status: "validation_error" }; }
    }
    if (session.step === "style_menu") { const field = input.resolveMenuOption(text, [{ value: "fly" }, { value: "canela" }]); if (!field) return reply(context, "❌ Opção inválida.\n\n" + menus.style); const current = Boolean(session.data.registration.playStyle?.[field]); return move(context, "style_input", { field, lastPrompt: `${field === "fly" ? "Fly" : "Canela"}\n\nAtual: ${state(current)}\n\n1️⃣ Sim\n2️⃣ Não${FOOTER}` }, `${field === "fly" ? "Fly" : "Canela"}\n\nAtual: ${state(current)}\n\n1️⃣ Sim\n2️⃣ Não${FOOTER}`); }
    if (session.step === "style_input") { const value = input.resolveYesNo(text); if (value === null) { await reply(context, "❌ Responda Sim ou Não."); return { status: "validation_error" }; } return saved(context, await registrations.updatePlayStyle(context.userId, session.data.field, value)); }
    if (session.step === "telegram_menu") {
      const field = input.resolveMenuOption(text, [{ value: "enabled", aliases: ["possui telegram"] }, { value: "username", aliases: ["usuario", "usuário"] }, { value: "groupName", aliases: ["nome do grupo"] }, { value: "groupLink", aliases: ["link", "link do grupo"] }, { value: "clear", aliases: ["limpar", "limpar dados"] }]); if (!field) { await reply(context, "❌ Opção inválida.\n\n" + menus.telegram); return { status: "validation_error" }; }
      if (field === "clear") return move(context, "critical_confirm", { critical: { kind: "telegram_clear" }, lastPrompt: `Confirma limpar todos os dados do Telegram?\n\n1️⃣ Confirmar\n2️⃣ Cancelar${FOOTER}` }, `Confirma limpar todos os dados do Telegram?\n\n1️⃣ Confirmar\n2️⃣ Cancelar${FOOTER}`);
      const current = session.data.registration.contacts?.telegram?.[field]; return move(context, "telegram_input", { field, lastPrompt: `${field}\n\nAtual: ${field === "enabled" ? state(current) : current || "Não informado"}\n\nInforme o novo valor.${field === "enabled" ? "\n1️⃣ Sim\n2️⃣ Não" : ""}${FOOTER}` }, `${field}\n\nAtual: ${field === "enabled" ? state(current) : current || "Não informado"}\n\nInforme o novo valor.${field === "enabled" ? "\n1️⃣ Sim\n2️⃣ Não" : ""}${FOOTER}`);
    }
    if (session.step === "telegram_input") { let value = text; if (session.data.field === "enabled") { value = input.resolveYesNo(text); if (value === null) { await reply(context, "❌ Responda Sim ou Não."); return { status: "validation_error" }; } } try { return saved(context, await registrations.updateTelegram(context.userId, { [session.data.field]: value })); } catch (error) { await reply(context, `❌ ${error.message}`); return { status: "validation_error" }; } }
    if (session.step === "preferences_menu") { const field = input.resolveMenuOption(text, [{ value: "raidNotifications", aliases: ["raids"] }, { value: "eventNotifications", aliases: ["eventos"] }, { value: "quizNotifications", aliases: ["quiz"] }, { value: "newsNotifications", aliases: ["novidades", "noticias", "notícias"] }]); if (!field) { await reply(context, "❌ Opção inválida.\n\n" + menus.preferences); return { status: "validation_error" }; } const current = session.data.registration.preferences[field]; return move(context, "preferences_input", { field, lastPrompt: `Atual: ${state(current)}\n\n1️⃣ Sim\n2️⃣ Não${FOOTER}` }, `Atual: ${state(current)}\n\n1️⃣ Sim\n2️⃣ Não${FOOTER}`); }
    if (session.step === "preferences_input") { const value = input.resolveYesNo(text); if (value === null) { await reply(context, "❌ Responda Sim ou Não."); return { status: "validation_error" }; } return saved(context, await registrations.updatePreferences(context.userId, { [session.data.field]: value })); }
    if (session.step === "privacy_menu") { const field = input.resolveMenuOption(text, [{ value: "showNick", aliases: ["nick"] }, { value: "showFriendCode", aliases: ["friend code"] }, { value: "showSecondaryAccounts", aliases: ["contas secundárias", "contas secundarias"] }]); if (!field) { await reply(context, "❌ Opção inválida.\n\n" + menus.privacy); return { status: "validation_error" }; } const privacy = await registrations.getPrivacy(context.userId); const current = field === "showNick" ? privacy[field] !== false : privacy[field]; const recommended = ["showNick", "showFriendCode"].includes(field) ? "\n💡 Recomendado: Visível" : ""; return move(context, "privacy_input", { field, lastPrompt: `Atual: ${visibility(current)}${recommended}\n\n1️⃣ Público\n2️⃣ Privado${FOOTER}` }, `Atual: ${visibility(current)}${recommended}\n\n1️⃣ Público\n2️⃣ Privado${FOOTER}`); }
    if (session.step === "privacy_input") { const value = input.resolveYesNo(text); if (value === null) { await reply(context, "❌ Escolha Público ou Privado."); return { status: "validation_error" }; } const field = session.data.field; return saved(context, field === "showNick" ? await registrations.setNickVisibility(context.userId, value) : field === "showFriendCode" ? await registrations.setFriendCodeVisibility(context.userId, value) : await registrations.setSecondaryAccountsVisibility(context.userId, value)); }
    if (session.step === "secondary_menu") {
      const choice = input.resolveMenuOption(text, [{ value: "list", aliases: ["listar", "listar contas"] }, { value: "add", aliases: ["adicionar", "adicionar conta"] }, { value: "edit", aliases: ["editar", "editar conta"] }, { value: "remove", aliases: ["remover", "remover conta"] }]); if (!choice) { await reply(context, "❌ Opção inválida.\n\n" + menus.secondary); return { status: "validation_error" }; }
      const fresh = await registrations.getRegistrationByIdentity(context.userId); if (choice === "list") { await reply(context, `${listSecondary(fresh)}${FOOTER}`); return { status: "listed" }; } if (!["add"].includes(choice) && !fresh.secondaryAccounts.length) { await reply(context, "❌ Não há contas secundárias cadastradas.\n\n" + menus.secondary); return { status: "validation_error" }; }
      if (choice === "add") return move(context, "secondary_add_nick", { pending: {}, lastPrompt: "Informe o Nick da nova conta." + FOOTER }, "Informe o Nick da nova conta." + FOOTER);
      return move(context, `secondary_${choice}_select`, { accounts: fresh.secondaryAccounts, lastPrompt: `${listSecondary(fresh)}\n\nEscolha a conta pela posição.${FOOTER}` }, `${listSecondary(fresh)}\n\nEscolha a conta pela posição.${FOOTER}`);
    }
    if (session.step.startsWith("secondary_add_")) {
      const field = session.step.slice(14), pending = { ...(session.data.pending || {}) }; let value = text;
      try { if (field === "nick") { const r = registrations.validateNick(text); if (!r.valid) throw new Error(r.error); value = r.value; } if (field === "friendCode") { const r = registrations.validateFriendCode(text); if (!r.valid) throw new Error(r.error); value = r.value; } if (field === "team") { value = team(text); if (!value) throw new Error("Time inválido."); } if (field === "level") { value = level(text); if (!value) throw new Error("Nível inválido."); } } catch (error) { await reply(context, `❌ ${error.message}`); return { status: "validation_error" }; }
      pending[field] = value; const next = { nick: "friendCode", friendCode: "team", team: "level" }[field]; if (next) return move(context, `secondary_add_${next}`, { pending, lastPrompt: `Informe ${next}.${FOOTER}` }, `Informe ${next}.${FOOTER}`);
      try { return saved(context, await registrations.addSecondaryAccount(context.userId, pending), "✅ Conta secundária adicionada."); } catch (error) { await reply(context, `❌ ${error.message}`); return { status: "validation_error" }; }
    }
    if (["secondary_edit_select", "secondary_remove_select"].includes(session.step)) { const index = input.resolveMenuOption(text, session.data.accounts.map((account, i) => ({ value: i, number: i + 1, aliases: [account.nick] }))); if (index === null) { await reply(context, "❌ Conta inválida."); return { status: "validation_error" }; } const account = session.data.accounts[index]; if (session.step.includes("remove")) return move(context, "critical_confirm", { critical: { kind: "secondary_remove", accountId: account.accountId }, lastPrompt: `Confirma remover a conta ${account.nick}?\n\n1️⃣ Confirmar\n2️⃣ Cancelar${FOOTER}` }, `Confirma remover a conta ${account.nick}?\n\n1️⃣ Confirmar\n2️⃣ Cancelar${FOOTER}`); return move(context, "secondary_edit_field", { account, lastPrompt: `Editar ${account.nick}\n\n1️⃣ Nick\n2️⃣ Friend Code\n3️⃣ Time\n4️⃣ Nível${FOOTER}` }, `Editar ${account.nick}\n\n1️⃣ Nick\n2️⃣ Friend Code\n3️⃣ Time\n4️⃣ Nível${FOOTER}`); }
    if (session.step === "secondary_edit_field") { const field = input.resolveMenuOption(text, [{ value: "nick" }, { value: "friendCode", aliases: ["friend code"] }, { value: "team", aliases: ["time"] }, { value: "level", aliases: ["nivel", "nível"] }]); if (!field) { await reply(context, "❌ Campo inválido."); return { status: "validation_error" }; } return move(context, "secondary_edit_input", { field, lastPrompt: `Informe o novo ${field}.${FOOTER}` }, `Informe o novo ${field}.${FOOTER}`); }
    if (session.step === "secondary_edit_input") { const field = session.data.field; let value = text; try { if (field === "nick") { const r = registrations.validateNick(text); if (!r.valid) throw new Error(r.error); value = r.value; } if (field === "friendCode") { const r = registrations.validateFriendCode(text); if (!r.valid) throw new Error(r.error); value = r.value; } if (field === "team") { value = team(text); if (!value) throw new Error("Time inválido."); } if (field === "level") { value = level(text); if (!value) throw new Error("Nível inválido."); } } catch (error) { await reply(context, `❌ ${error.message}`); return { status: "validation_error" }; } if (["nick", "friendCode"].includes(field)) return move(context, "critical_confirm", { critical: { kind: "secondary_update", accountId: session.data.account.accountId, field, value }, lastPrompt: `Confirma a alteração?\n\n1️⃣ Confirmar\n2️⃣ Cancelar${FOOTER}` }, `Confirma a alteração?\n\n1️⃣ Confirmar\n2️⃣ Cancelar${FOOTER}`); try { return saved(context, await registrations.updateSecondaryAccount(context.userId, session.data.account.accountId, { [field]: value })); } catch (error) { await reply(context, `❌ ${error.message}`); return { status: "validation_error" }; } }
    return { status: "ignored" };
  }

  return { start, handle, MAIN_MENU, GROUP_GUIDANCE, NOT_FOUND, REVIEW_REQUIRED, listSecondary };
}

module.exports = { createRegistrationEditFlowService, MAIN_MENU, GROUP_GUIDANCE, NOT_FOUND, REVIEW_REQUIRED };
