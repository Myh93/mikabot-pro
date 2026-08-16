"use strict";

const guidedFlowDefault = require("./guidedFlowService");
const eventServiceDefault = require("./eventService");
const identityServiceDefault = require("./identityService");
const menuSessionServiceDefault = require("./menuSessionService");
const groupDirectoryServiceDefault = require("./groupDirectoryService");
const eventMessageFormatterDefault = require("./eventMessageFormatter");
const whatsappWarningLimiterDefault = require("../utils/whatsappWarningLimiter");
const inputResolverDefault = require("./inputResolverService");

const TYPES = [
  ["quiz", "Quiz"], ["raid", "Raid"], ["championship", "Campeonato"], ["giveaway", "Sorteio"],
  ["pokemon_go", "Pokémon GO"], ["notice", "Aviso"], ["custom", "Personalizado"]
];
const NOTICE_OPTIONS = {
  "1": { keys: ["start", "end"], label: "Somente na hora" },
  "2": { keys: ["30m", "10m", "start", "end"], label: "30min e 10min" },
  "3": { keys: ["1h", "30m", "10m", "start", "end"], label: "1h, 30min e 10min" },
  "4": { keys: ["24h", "1h", "30m", "10m", "start", "end"], label: "24h, 1h, 30min e 10min" },
  "5": { keys: ["start", "end"], label: "Sem avisos extras" }
};

function createEventGuidedFlowService(options = {}) {
  const flows = options.guidedFlowService || guidedFlowDefault;
  const events = options.eventService || eventServiceDefault;
  const identities = options.identityService || identityServiceDefault;
  const menuSessions = options.menuSessionService || menuSessionServiceDefault;
  const groupDirectory = options.groupDirectoryService || groupDirectoryServiceDefault;
  const messageFormatter = options.messageFormatter || eventMessageFormatterDefault;
  const warningLimiter = options.warningLimiter || whatsappWarningLimiterDefault;
  const inputResolver = options.inputResolverService || inputResolverDefault;

  function privateContext(context) {
    return Boolean(context && !context.isGroup && context.conversationId && context.userId);
  }

  async function listManageableGroups(client, identity) {
    const role = identity?.role || {};
    const owner = role.isOwner || role.isProtectedOwner || ["owner", "protectedOwner"].includes(role.name);
    const directoryGroups = await groupDirectory.listActiveGroups("whatsapp");
    const groups = [];
    for (const directoryGroup of directoryGroups) {
      if (owner) { groups.push({ id: directoryGroup.groupId, name: groupDirectory.formatGroupDisplayName(directoryGroup), isAdmin: true }); continue; }
      let chat = null;
      try {
        if (typeof client?.getChatById === "function") chat = await client.getChatById(directoryGroup.groupId);
      } catch (error) {
        warningLimiter.warn("eventGuidedFlow", "getChatById");
      }
      const participant = Array.isArray(chat?.participants) && chat.participants.find((item) => identities.identitiesMatch(identity, item.id));
      if (participant) groups.push({ id: directoryGroup.groupId, name: groupDirectory.formatGroupDisplayName({ ...directoryGroup, name: directoryGroup.name || chat?.name }), isAdmin: Boolean(participant.isAdmin || participant.isSuperAdmin) });
    }
    return groups.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }

  const flowArgs = (context) => [context.platform, context.conversationId, context.userId];
  const reply = (context, text) => context.replyText(text);

  function groupPrompt(groups) {
    return ["📂 *ESCOLHA O GRUPO*", "", ...groups.map((group, index) => `${index + 1}️⃣ ${group.name}`), "", "Responda com o número."].join("\n");
  }
  const typePrompt = () => ["📌 *TIPO DO EVENTO*", "", ...TYPES.map((type, index) => `${index + 1}️⃣ ${type[1]}`)].join("\n");
  const noticePrompt = () => ["🔔 *AVISOS AUTOMÁTICOS*", "", "Escolha uma opção:", "", "1️⃣ Somente na hora", "2️⃣ 30 e 10 minutos antes", "3️⃣ 1 hora, 30 e 10 minutos antes", "4️⃣ 24 horas, 1 hora, 30 e 10 minutos antes", "5️⃣ Sem avisos extras"].join("\n");

  function roleData(role = {}) {
    return { name: role.name || "member", isAdmin: Boolean(role.isAdmin), isOwner: Boolean(role.isOwner), isProtectedOwner: Boolean(role.isProtectedOwner) };
  }

  async function begin(flowId, step, data, context) {
    if (!privateContext(context)) return { status: "ignored" };
    const result = await flows.startFlow({ flowId, platform: context.platform, conversationId: context.conversationId, userId: context.userId, step, data });
    if (result.conflict) {
      await reply(context, "⚠️ Você já possui um fluxo em andamento. Continue respondendo ou use !cancelar para cancelar.");
      return { status: "conflict", session: result.session };
    }
    await menuSessions.closeMenu(context.platform, context.conversationId, context.userId).catch(() => false);
    return { status: "started", session: result.session };
  }

  async function startCreateFlow(client, context, role = {}) {
    const directoryGroups = await groupDirectory.listActiveGroups("whatsapp");
    if (!directoryGroups.length) {
      await reply(context, "📂 Ainda não encontrei nenhum grupo.\n\nEnvie qualquer comando do MikaBot dentro do grupo desejado e tente novamente no privado.");
      return { status: "empty" };
    }
    const groups = await listManageableGroups(client, { ...(context.identity || { id: context.userId }), role });
    if (!groups.length) { await reply(context, "❌ Nenhum grupo disponível para criar eventos."); return { status: "empty" }; }
    const started = await begin("create_event", "select_group", { groups, role: roleData(role) }, context);
    if (started.status === "started") await reply(context, groupPrompt(groups));
    return started;
  }

  async function manageableEvents(client, context, role, statuses, options = {}) {
    const directoryGroups = await groupDirectory.listActiveGroups("whatsapp");
    const groups = await listManageableGroups(client, { ...(context.identity || { id: context.userId }), role });
    const list = await events.listManageableEvents(
      { platform: context.platform, userId: context.userId, identity: context.identity, role },
      groups.map((group) => group.id),
      groups.filter((group) => group.isAdmin).map((group) => group.id),
      { statuses, futureOnly: Boolean(options.futureOnly) }
    );
    const resolvedGroups = [...groups];
    for (const event of list) {
      if (resolvedGroups.some((group) => group.id === event.groupId)) continue;
      const known = directoryGroups.find((group) => group.groupId === event.groupId);
      resolvedGroups.push({ id: event.groupId, name: known?.name || "Grupo do evento", isAdmin: false });
    }
    return { groups: resolvedGroups, list };
  }

  function formatGroupedEvents(result, title) {
    if (!result.list.length) return "📅 Não há eventos disponíveis no momento.";
    const sections = [title];
    for (const group of result.groups) {
      const groupEvents = result.list.filter((event) => event.groupId === group.id);
      if (!groupEvents.length) continue;
      sections.push("", `📂 *${group.name}*`, "", events.formatEventList(groupEvents, "").trim());
    }
    return sections.join("\n").trim();
  }

  async function getManageableEvent(client, context, role, eventId) {
    const result = await manageableEvents(client, context, role);
    const normalized = String(eventId || "").trim().toUpperCase();
    const event = result.list.find((item) => item.id === normalized);
    if (!event) {
      const error = new Error("❌ Evento não encontrado ou você não possui permissão para consultá-lo.");
      error.code = "EVENT_NOT_FOUND";
      throw error;
    }
    return event;
  }

  function eventChoicePrompt(title, list) {
    return [title, "", ...list.map((event, index) => `${index + 1}️⃣ ${event.id} — ${event.title}`), "", "Responda com o número."].join("\n");
  }

  async function startActionFlow(action, client, context, role = {}) {
    const statusMap = {
      edit_event: ["draft", "scheduled", "published"], publish_event: ["draft", "scheduled"],
      cancel_event: ["draft", "scheduled", "published", "running"], finish_event: ["published", "running"]
    };
    const { groups, list } = await manageableEvents(client, context, role, statusMap[action]);
    if (!list.length) { await reply(context, "❌ Nenhum evento disponível para esta ação."); return { status: "empty" }; }
    const started = await begin(action, `select_${action}`, { groups, events: list.map((event) => ({ id: event.id, title: event.title, groupId: event.groupId })), role: roleData(role) }, context);
    if (started.status === "started") await reply(context, eventChoicePrompt("📅 *ESCOLHA O EVENTO*", list));
    return started;
  }

  function contextFor(session, groupId) {
    const group = session.data.groups?.find((item) => item.id === groupId);
    const storedRole = session.data.role || {};
    const role = group?.isAdmin && !storedRole.isOwner ? { ...storedRole, name: "admin", isAdmin: true } : storedRole;
    return { platform: session.platform, groupId, userId: session.userId, identity: { id: session.userId }, role };
  }

  function reviewText(data) {
    return messageFormatter.formatGuidedReview(data);
  }

  async function advance(session, context, step, changes, prompt) {
    const updated = await flows.advanceFlow(...flowArgs(context), step, changes);
    if (prompt) await reply(context, typeof prompt === "function" ? prompt(updated.data) : prompt);
    return { status: "advanced", session: updated };
  }

  function validChoice(text, max) {
    const value = Number(String(text).trim());
    return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
  }

  async function saveCreation(session, context, client, mode) {
    const data = session.data;
    const event = await events.createEvent({
      title: data.title, description: data.description, type: data.type, date: data.date, time: data.time,
      endDate: data.endDate, endTime: data.endTime, prize: data.prize, status: mode === "draft" ? "draft" : "scheduled",
      settings: { notifications: data.noticeKeys }
    }, contextFor(session, data.groupId));
    let published = false;
    if (mode === "publish") {
      await events.publishEvent(event.id, contextFor(session, data.groupId), (groupId, text) => client.sendMessage(groupId, text));
      published = true;
    }
    await flows.finishFlow(...flowArgs(context));
    await reply(context, messageFormatter.formatPrivateConfirmation(event, { groupName: data.groupName, published, status: published ? "published" : event.status }));
    return { status: "finished", event, published };
  }

  async function handleCreate(session, text, context, client) {
    const value = String(text || "").trim();
    if (session.step === "select_group") {
      const choice = validChoice(value, session.data.groups.length); if (!choice) throw Object.assign(new Error("❌ Escolha um grupo válido pelo número."), { validation: true });
      const group = session.data.groups[choice - 1]; return advance(session, context, "select_type", { groupId: group.id, groupName: group.name }, typePrompt());
    }
    if (session.step === "select_type") {
      const choice = validChoice(value, TYPES.length); if (!choice) throw Object.assign(new Error("❌ Escolha um tipo válido pelo número."), { validation: true });
      return advance(session, context, "title", { type: TYPES[choice - 1][0], typeLabel: TYPES[choice - 1][1] }, "✏️ Digite o título do evento.\n\nExemplo:\nQuiz Pokémon de Hoje");
    }
    if (session.step === "title") { if (!value) throw Object.assign(new Error("❌ O título não pode ficar vazio."), { validation: true }); return advance(session, context, "description", { title: value }, "📝 Digite a descrição.\n\nPode escrever do seu jeito."); }
    if (session.step === "description") return advance(session, context, "date", { description: value }, "📅 Digite a data.\n\nExemplos:\nhoje\namanhã\n16/07\n16/07/2026");
    if (session.step === "date") { events.parseDate(value); return advance(session, context, "time", { date: value }, "⏰ Digite o horário.\n\nExemplos:\n20:00\n20h\n20h30"); }
    if (session.step === "time") { events.parseTime(value); return advance(session, context, "end_choice", { time: value }, "⏳ Deseja informar horário de término?\n\n1️⃣ Sim\n2️⃣ Não"); }
    if (session.step === "end_choice") { const choice = inputResolver.resolveYesNo(value); if (choice === null) throw Object.assign(new Error("❌ Responda 1 para Sim ou 2 para Não."), { validation: true }); return choice ? advance(session, context, "end_date", {}, "📅 Digite a data de término.") : advance(session, context, "prize_choice", { endDate: null, endTime: null }, "🎁 Vai ter prêmio?\n\n1️⃣ Sim\n2️⃣ Não"); }
    if (session.step === "end_date") { events.parseDate(value); return advance(session, context, "end_time", { endDate: value }, "⏰ Digite o horário de término."); }
    if (session.step === "end_time") {
      events.parseTime(value);
      const startDate = events.parseDate(session.data.date); const startTime = events.parseTime(session.data.time); const endDate = events.parseDate(session.data.endDate); const endTime = events.parseTime(value);
      const toNumber = (date, time) => Date.UTC(date.year, date.month - 1, date.day, time.hour + 3, time.minute);
      if (toNumber(endDate, endTime) < toNumber(startDate, startTime)) throw Object.assign(new Error("❌ O término não pode ser anterior ao início."), { validation: true });
      return advance(session, context, "prize_choice", { endTime: value }, "🎁 Vai ter prêmio?\n\n1️⃣ Sim\n2️⃣ Não");
    }
    if (session.step === "prize_choice") { const choice = inputResolver.resolveYesNo(value); if (choice === null) throw Object.assign(new Error("❌ Responda 1 para Sim ou 2 para Não."), { validation: true }); return choice ? advance(session, context, "prize", {}, "Digite o prêmio.\n\nExemplos:\nPikachu Shiny\nPasse Premium\nBrinde surpresa") : advance(session, context, "notifications", { prize: null }, noticePrompt()); }
    if (session.step === "prize") return advance(session, context, "notifications", { prize: value }, noticePrompt());
    if (session.step === "notifications") { const selected = NOTICE_OPTIONS[value]; if (!selected) throw Object.assign(new Error("❌ Escolha uma opção de avisos entre 1 e 5."), { validation: true }); return advance(session, context, "review", { noticeKeys: selected.keys, noticeLabel: selected.label }, reviewText({ ...session.data, noticeKeys: selected.keys, noticeLabel: selected.label })); }
    if (session.step === "review") {
      const choice = validChoice(value, 5); if (!choice) throw Object.assign(new Error("❌ Escolha uma opção entre 1 e 5."), { validation: true });
      if (choice === 1) return saveCreation(session, context, client, "draft");
      if (choice === 2) return saveCreation(session, context, client, "scheduled");
      if (choice === 3) return saveCreation(session, context, client, "publish");
      if (choice === 4) return advance(session, context, "review_edit", {}, "✏️ *EDITAR ANTES DE SALVAR*\n\n1️⃣ Título\n2️⃣ Descrição\n3️⃣ Tipo\n4️⃣ Data\n5️⃣ Hora\n6️⃣ Prêmio\n7️⃣ Voltar à revisão");
      await flows.cancelFlow(...flowArgs(context)); await reply(context, "❌ Criação do evento cancelada."); return { status: "cancelled" };
    }
    if (session.step === "review_edit") {
      const choice = validChoice(value, 7); if (!choice) throw Object.assign(new Error("❌ Escolha um campo válido."), { validation: true });
      if (choice === 7) return advance(session, context, "review", {}, reviewText(session.data));
      const fields = ["title", "description", "type", "date", "time", "prize"];
      return advance(session, context, `review_edit_${fields[choice - 1]}`, {}, choice === 3 ? typePrompt() : "Digite o novo valor.");
    }
    if (session.step.startsWith("review_edit_")) {
      const field = session.step.slice("review_edit_".length);
      let changes = { [field]: value };
      if (field === "type") { const choice = validChoice(value, TYPES.length); if (!choice) throw Object.assign(new Error("❌ Escolha um tipo válido."), { validation: true }); changes = { type: TYPES[choice - 1][0], typeLabel: TYPES[choice - 1][1] }; }
      if (field === "date") events.parseDate(value); if (field === "time") events.parseTime(value);
      const updated = await flows.advanceFlow(...flowArgs(context), "review", changes); await reply(context, reviewText(updated.data)); return { status: "advanced", session: updated };
    }
    return { status: "ignored" };
  }

  async function handleAction(session, text, context, client) {
    const value = String(text || "").trim();
    if (session.step.startsWith("select_")) {
      const choice = validChoice(value, session.data.events.length); if (!choice) throw Object.assign(new Error("❌ Escolha um evento válido pelo número."), { validation: true });
      const selected = session.data.events[choice - 1];
      if (session.flowId === "edit_event") return advance(session, context, "edit_menu", { eventId: selected.id, eventGroupId: selected.groupId }, `✏️ *EDITAR EVENTO ${selected.id}*\n\n1️⃣ Título\n2️⃣ Descrição\n3️⃣ Tipo\n4️⃣ Data\n5️⃣ Hora\n6️⃣ Término\n7️⃣ Prêmio\n8️⃣ Avisos\n9️⃣ Grupo\n🔟 Salvar e sair\n1️⃣1️⃣ Cancelar edição`);
      const event = await events.getEvent(selected.id, contextFor(session, selected.groupId));
      const verb = session.flowId === "publish_event" ? "Publicar" : session.flowId === "cancel_event" ? "Cancelar" : "Finalizar";
      return advance(session, context, "confirm_action", { eventId: selected.id, eventGroupId: selected.groupId, wasPublished: ["published", "running"].includes(event.status) }, `${events.formatEvent(event)}\n\n1️⃣ ${verb}\n2️⃣ Voltar\n3️⃣ Cancelar`);
    }
    if (session.step === "edit_menu") {
      const choice = validChoice(value, 11); if (!choice) throw Object.assign(new Error("❌ Escolha uma opção válida."), { validation: true });
      if (choice === 10) { await flows.finishFlow(...flowArgs(context)); await reply(context, "✅ Edição concluída."); return { status: "finished" }; }
      if (choice === 11) { await flows.cancelFlow(...flowArgs(context)); await reply(context, "❌ Edição cancelada."); return { status: "cancelled" }; }
      if (choice === 9) return advance(session, context, "edit_group", {}, groupPrompt(session.data.groups));
      const fields = ["titulo", "descricao", "tipo", "data", "hora", "termino", "premio", "avisos"];
      const prompt = choice === 8 ? noticePrompt() : choice === 6 ? "Digite o término como DATA | HORA. Exemplo: 17/07/2026 | 22h. Envie não para remover." : "Digite o novo valor.";
      return advance(session, context, `edit_field_${fields[choice - 1]}`, {}, prompt);
    }
    if (session.step === "edit_group") {
      const choice = validChoice(value, session.data.groups.length); if (!choice) throw Object.assign(new Error("❌ Escolha um grupo válido."), { validation: true });
      const group = session.data.groups[choice - 1];
      await events.moveEvent(session.data.eventId, group.id, contextFor(session, session.data.eventGroupId), session.data.groups.map((item) => item.id));
      return advance(session, context, "edit_menu", { eventGroupId: group.id }, `✅ Grupo atualizado.\n\nEnvie 9 para salvar e sair ou escolha outro campo.`);
    }
    if (session.step.startsWith("edit_field_")) {
      const field = session.step.slice("edit_field_".length);
      if (field === "avisos") {
        const selected = NOTICE_OPTIONS[value]; if (!selected) throw Object.assign(new Error("❌ Escolha uma opção de avisos entre 1 e 5."), { validation: true });
        const event = await events.getEvent(session.data.eventId, contextFor(session, session.data.eventGroupId));
        await events.updateEventData(event.id, { settings: { ...(event.settings || {}), notifications: selected.keys } }, contextFor(session, session.data.eventGroupId));
      } else if (field === "termino") {
        const remove = inputResolver.resolveYesNo(value) === false;
        const [date, time] = remove ? [null, null] : value.split("|").map((item) => item.trim());
        if (!remove && (!date || !time)) throw Object.assign(new Error("❌ Use DATA | HORA para definir o término."), { validation: true });
        await events.updateEventEnd(session.data.eventId, date, time, contextFor(session, session.data.eventGroupId));
      } else await events.updateEvent(session.data.eventId, field, value, contextFor(session, session.data.eventGroupId));
      return advance(session, context, "edit_menu", {}, "✅ Campo atualizado.\n\nEnvie 10 para salvar e sair ou escolha outro campo.");
    }
    if (session.step === "confirm_action") {
      const choice = validChoice(value, 3); if (!choice) throw Object.assign(new Error("❌ Escolha uma opção entre 1 e 3."), { validation: true });
      if (choice === 2) { const previous = await flows.goBack(...flowArgs(context)); await reply(context, eventChoicePrompt("📅 *ESCOLHA O EVENTO*", session.data.events)); return { status: "back", session: previous }; }
      if (choice === 3) { await flows.cancelFlow(...flowArgs(context)); await reply(context, "❌ Operação cancelada."); return { status: "cancelled" }; }
      const eventContext = contextFor(session, session.data.eventGroupId);
      let event;
      if (session.flowId === "publish_event") event = await events.publishEvent(session.data.eventId, eventContext, (groupId, message) => client.sendMessage(groupId, message));
      if (session.flowId === "cancel_event") {
        const before = await events.getEvent(session.data.eventId, eventContext); event = await events.cancelEvent(session.data.eventId, eventContext);
        if (session.data.wasPublished) await client.sendMessage(before.groupId, messageFormatter.formatEventCancelled(before));
      }
      if (session.flowId === "finish_event") { const before = await events.getEvent(session.data.eventId, eventContext); event = await events.finishEvent(session.data.eventId, eventContext); await client.sendMessage(before.groupId, messageFormatter.formatEventFinished(before)); }
      await flows.finishFlow(...flowArgs(context)); await reply(context, `✅ Ação concluída no evento ${event.id}.`); return { status: "finished", event };
    }
    return { status: "ignored" };
  }

  async function handleAnswer(client, context, text) {
    if (!privateContext(context)) return { status: "ignored" };
    const session = await flows.getActiveFlow(...flowArgs(context));
    if (!session) return { status: "ignored" };
    try {
      return session.flowId === "create_event" ? await handleCreate(session, text, context, client) : await handleAction(session, text, context, client);
    } catch (error) {
      if (error.validation || error.code) { await reply(context, error.message); return { status: "validation_error", error }; }
      throw error;
    }
  }

  async function handleControl(command, context) {
    const session = await flows.getActiveFlow(...flowArgs(context));
    if (!session) { await reply(context, "❌ Não há fluxo guiado ativo."); return { status: "empty" }; }
    const navigation = inputResolver.resolveNavigation(command);
    if (navigation === "back") { const previous = await flows.goBack(...flowArgs(context)); await reply(context, previous.cannotGoBack ? "⚠️ Não é possível voltar além desta etapa." : "↩️ Etapa anterior restaurada. Continue respondendo ao fluxo."); return { status: "back", session: previous }; }
    await flows.cancelFlow(...flowArgs(context)); await reply(context, inputResolver.normalizeInput(command) === "sair" ? "👋 Fluxo encerrado sem salvar." : "❌ Fluxo cancelado."); return { status: "cancelled" };
  }

  const hasActiveFlow = async (context) => privateContext(context) && Boolean(await flows.getActiveFlow(...flowArgs(context)));
  return { startCreateFlow, startActionFlow, handleAnswer, handleControl, hasActiveFlow, listManageableGroups, manageableEvents, getManageableEvent, formatGroupedEvents, reviewText };
}

const service = createEventGuidedFlowService();
module.exports = { ...service, createEventGuidedFlowService, TYPES, NOTICE_OPTIONS };
