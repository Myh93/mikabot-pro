"use strict";

const eventRepositoryDefault = require("../repositories/eventRepository");
const identityServiceDefault = require("./identityService");
const eventMessageFormatterDefault = require("./eventMessageFormatter");
const configurationServiceDefault = require("./configurationService");

const DEFAULT_TIMEZONE = configurationServiceDefault
  .getResolved("events.timezone")
  .value;
const AUTHORIZATION_MESSAGE = "❌ Você só pode alterar eventos criados por você.";
const STATUS_LABELS = eventMessageFormatterDefault.STATUS_LABELS;

function createDomainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createEventService(options = {}) {
  const repository = options.repository || eventRepositoryDefault;
  const identities = options.identityService || identityServiceDefault;
  const clock = options.clock || (() => new Date());
  const messageFormatter = options.messageFormatter || eventMessageFormatterDefault;
  const configurationService = options.configurationService || configurationServiceDefault;

  function timezone(context = {}) {
    return configurationService.getResolved("events.timezone", {
      communityId: context?.communityId,
      platform: context?.platform,
      groupId: context?.groupId
    }).value;
  }

  function isPrivileged(context) {
    const role = context?.role || {};
    return Boolean(role.isAdmin || role.isOwner || role.isProtectedOwner || ["admin", "trustedGroupCreator", "owner", "protectedOwner"].includes(role.name));
  }

  function sameGroup(event, context) {
    return Boolean(event?.groupId && context?.groupId && event.groupId === context.groupId && event.platform === context.platform);
  }

  function isCreator(event, context) {
    return identities.identitiesMatch(event?.creatorId, context?.userId || context?.identity);
  }

  function canManage(event, context) {
    if (!sameGroup(event, context)) return false;
    return isCreator(event, context) || isPrivileged(context);
  }

  function requireGroup(context) {
    if (!context?.groupId || !String(context.groupId).endsWith("@g.us")) throw createDomainError("GROUP_ONLY", "❌ Este comando só pode ser usado em grupos.");
  }

  function requireManage(event, context) {
    if (!canManage(event, context)) throw createDomainError("EVENT_FORBIDDEN", AUTHORIZATION_MESSAGE);
  }

  function requireAdmin(event, context) {
    if (!sameGroup(event, context) || !isPrivileged(context)) throw createDomainError("EVENT_ADMIN_ONLY", "❌ Apenas administradores e owners podem arquivar eventos.");
  }

  function localParts(date = clock(), context = {}) {
    const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone(context), year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    return { year: values.year, month: values.month, day: values.day };
  }

  function addLocalDays(parts, amount) {
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
  }

  function parseDate(value, context = {}) {
    const input = String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (!input) return null;
    const today = localParts(clock(), context);
    if (input === "hoje") return { ...today, explicitYear: true };
    if (input === "amanha") return { ...addLocalDays(today, 1), explicitYear: true };
    const match = input.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
    if (!match) throw createDomainError("INVALID_DATE", "❌ Data inválida. Use DD/MM/AAAA, DD/MM, hoje ou amanhã.");
    const day = Number(match[1]);
    const month = Number(match[2]);
    const explicitYear = Boolean(match[3]);
    let year = explicitYear ? Number(match[3]) : today.year;
    const valid = (candidateYear) => {
      const date = new Date(Date.UTC(candidateYear, month - 1, day));
      return date.getUTCFullYear() === candidateYear && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    };
    if (!valid(year)) throw createDomainError("INVALID_DATE", "❌ Data inválida. Use DD/MM/AAAA, DD/MM, hoje ou amanhã.");
    if (!explicitYear) {
      const todayNumber = today.year * 10000 + today.month * 100 + today.day;
      if (year * 10000 + month * 100 + day < todayNumber) year += 1;
    }
    return { year, month, day, explicitYear };
  }

  function parseTime(value) {
    const input = String(value || "").trim().toLowerCase();
    if (!input) return null;
    const match = input.match(/^(\d{1,2})(?::|h)(\d{2})?$|^(\d{1,2}):?(\d{2})$/);
    if (!match) throw createDomainError("INVALID_TIME", "❌ Horário inválido. Use 20:00, 20h ou 20h30.");
    const hour = Number(match[1] ?? match[3]);
    const minute = Number(match[2] ?? match[4] ?? 0);
    if (hour > 23 || minute > 59) throw createDomainError("INVALID_TIME", "❌ Horário inválido. Use 20:00, 20h ou 20h30.");
    return { hour, minute };
  }

  function toIso(date, time, context = {}) {
    if (!date || !time) return null;
    const target = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
    const zone = timezone(context);
    let candidate = target;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hourCycle: "h23"
      }).formatToParts(new Date(candidate))
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]));
      const represented = Date.UTC(
        parts.year, parts.month - 1, parts.day, parts.hour, parts.minute
      );
      candidate += target - represented;
    }
    return new Date(candidate).toISOString();
  }

  function isoParts(iso, context = {}) {
    if (!iso) return null;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone(context), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(iso)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return parts;
  }

  function formatDateTime(iso, context = {}) {
    const parts = isoParts(iso, context);
    if (!parts) return { date: "Não informada", time: "Não informado" };
    return { date: `${parts.day}/${parts.month}/${parts.year}`, time: `${parts.hour}:${parts.minute}` };
  }

  async function createEvent(input, context) {
    requireGroup(context);
    const title = String(input?.title || "").trim();
    if (!title) throw createDomainError("EMPTY_TITLE", "❌ Informe o título do evento.");
    const date = input.date ? parseDate(input.date, context) : null;
    const time = input.time ? parseTime(input.time) : null;
    if ((date && !time) || (!date && time)) throw createDomainError("INCOMPLETE_SCHEDULE", "❌ Informe data e hora juntas para agendar o evento.");
    const startsAt = toIso(date, time, context);
    const endDate = input.endDate ? parseDate(input.endDate, context) : null;
    const endTime = input.endTime ? parseTime(input.endTime) : null;
    if ((endDate && !endTime) || (!endDate && endTime)) throw createDomainError("INCOMPLETE_END", "❌ Informe data e hora de término juntas.");
    const endsAt = toIso(endDate, endTime, context);
    if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) throw createDomainError("INVALID_END", "❌ O término não pode ser anterior ao início.");
    const status = input.status || (startsAt ? "scheduled" : "draft");
    return repository.createEvent({
      title, description: String(input.description || "").trim(), type: String(input.type || "custom").trim(),
      platform: context.platform, groupId: context.groupId, creatorId: context.userId,
      timezone: input.timezone || timezone(context), startsAt, endsAt, status, prize: input.prize || null,
      settings: input.settings || {}, notifications: input.notifications || []
    }, { authorId: context.userId });
  }

  async function getEvent(id, context) {
    const event = await repository.getEventById(id);
    if (!event || !sameGroup(event, context)) throw createDomainError("EVENT_NOT_FOUND", "❌ Evento não encontrado neste grupo.");
    if (event.status === "draft" && !canManage(event, context)) throw createDomainError("EVENT_NOT_FOUND", "❌ Evento não encontrado neste grupo.");
    return event;
  }

  async function getManageable(id, context, adminOnly = false) {
    const event = await repository.getEventById(id);
    if (!event) throw createDomainError("EVENT_NOT_FOUND", "❌ Evento não encontrado neste grupo.");
    if (adminOnly) requireAdmin(event, context); else requireManage(event, context);
    return event;
  }

  async function updateEvent(id, field, value, context) {
    const event = await getManageable(id, context);
    const normalizedField = String(field || "").toLowerCase();
    const map = { titulo: "title", descricao: "description", premio: "prize", tipo: "type" };
    let changes;
    if (map[normalizedField]) changes = { [map[normalizedField]]: String(value || "").trim() };
    else if (["data", "hora"].includes(normalizedField)) {
      const current = isoParts(event.startsAt, context);
      const date = normalizedField === "data" ? parseDate(value, context) : current && { year: Number(current.year), month: Number(current.month), day: Number(current.day), explicitYear: true };
      const time = normalizedField === "hora" ? parseTime(value) : current && { hour: Number(current.hour), minute: Number(current.minute) };
      if (!date || !time) throw createDomainError("INCOMPLETE_SCHEDULE", "❌ Defina data e hora antes de agendar o evento.");
      changes = { startsAt: toIso(date, time, context) };
      if (event.status === "draft") changes.status = "scheduled";
    } else throw createDomainError("INVALID_FIELD", "❌ Campo inválido. Use titulo, descricao, data, hora, premio ou tipo.");
    if (["title", "type"].includes(map[normalizedField]) && !Object.values(changes)[0]) throw createDomainError("EMPTY_FIELD", "❌ Este campo não pode ficar vazio.");
    return repository.updateEvent(event.id, changes, { authorId: context.userId });
  }

  async function updateEventData(id, changes, context) {
    const event = await getManageable(id, context);
    const allowed = ["title", "description", "type", "startsAt", "endsAt", "prize", "settings"];
    if (Object.keys(changes || {}).some((field) => !allowed.includes(field))) throw createDomainError("INVALID_FIELD", "❌ Campo de evento inválido.");
    return repository.updateEvent(event.id, changes, { authorId: context.userId });
  }

  async function updateEventEnd(id, dateValue, timeValue, context) {
    const event = await getManageable(id, context);
    if (!dateValue && !timeValue) return repository.updateEvent(event.id, { endsAt: null }, { authorId: context.userId });
    const date = parseDate(dateValue, context);
    const time = parseTime(timeValue);
    const endsAt = toIso(date, time, context);
    if (event.startsAt && Date.parse(endsAt) < Date.parse(event.startsAt)) throw createDomainError("INVALID_END", "❌ O término não pode ser anterior ao início.");
    return repository.updateEvent(event.id, { endsAt }, { authorId: context.userId });
  }

  async function scheduleEvent(id, schedule, context) { const event = await getManageable(id, context); const startsAt = toIso(parseDate(schedule.date, context), parseTime(schedule.time), context); return repository.scheduleEvent(event.id, { startsAt }, { authorId: context.userId }); }
  async function publishEvent(id, context, publishText) {
    const event = await getManageable(id, context);
    if (event.status === "published") throw createDomainError("ALREADY_PUBLISHED", "❌ Este evento já foi publicado.");
    if (["cancelled", "finished", "archived", "running"].includes(event.status)) throw createDomainError("INVALID_STATUS", "❌ Este evento não pode ser publicado no status atual.");
    if (typeof publishText !== "function") throw new Error("Canal de publicação indisponível.");
    await publishText(event.groupId, messageFormatter.formatPublicEvent(event, { now: clock() }));
    return repository.publishEvent(event.id, {}, { authorId: context.userId });
  }
  async function cancelEvent(id, context) { const event = await getManageable(id, context); return repository.cancelEvent(event.id, {}, { authorId: context.userId }); }
  async function archiveEvent(id, context) { const event = await getManageable(id, context, true); return repository.archiveEvent(event.id, {}, { authorId: context.userId }); }
  async function finishEvent(id, context) { const event = await getManageable(id, context); return repository.finishEvent(event.id, {}, { authorId: context.userId }); }

  async function listEvents(context) {
    requireGroup(context);
    const events = await repository.listEvents({ platform: context.platform, groupId: context.groupId });
    return events.filter((event) => ["scheduled", "published", "running"].includes(event.status) || (event.status === "draft" && (isCreator(event, context) || isPrivileged(context))));
  }

  async function listUpcomingEvents(context) {
    const events = await repository.listEvents({ platform: context.platform, groupId: context.groupId, startsAfter: clock().toISOString() });
    return events.filter((event) => ["scheduled", "published"].includes(event.status));
  }

  async function listActiveEvents(context) { return (await listEvents(context)).filter((event) => ["scheduled", "published", "running"].includes(event.status)); }
  async function listEventHistory(context) {
    if (!isPrivileged(context)) throw createDomainError("EVENT_ADMIN_ONLY", "❌ Apenas administradores e owners podem consultar o histórico.");
    return repository.listEvents({ platform: context.platform, groupId: context.groupId, includeArchived: true }).then((events) => events.filter((event) => ["finished", "cancelled", "archived"].includes(event.status)));
  }

  async function listManageableEvents(context, groupIds = [], adminGroupIds = [], filters = {}) {
    const all = await repository.listEvents({ platform: context.platform, includeArchived: true });
    const owner = ["owner", "protectedOwner"].includes(context.role?.name) || context.role?.isOwner || context.role?.isProtectedOwner;
    return all.filter((event) => {
      const creator = isCreator(event, { ...context, groupId: event.groupId });
      if (!(creator || owner || adminGroupIds.includes(event.groupId))) return false;
      if (filters.statuses && !filters.statuses.includes(event.status)) return false;
      if (filters.futureOnly && (!event.startsAt || Date.parse(event.startsAt) <= clock().getTime())) return false;
      return true;
    });
  }

  async function moveEvent(id, groupId, context, allowedGroupIds = []) {
    const event = await repository.getEventById(id);
    if (!event) throw createDomainError("EVENT_NOT_FOUND", "❌ Evento não encontrado.");
    requireManage(event, { ...context, groupId: event.groupId });
    if (["running", "finished"].includes(event.status)) throw createDomainError("MOVE_BLOCKED", "❌ Não é possível mover um evento em andamento ou finalizado.");
    if (!allowedGroupIds.includes(groupId)) throw createDomainError("GROUP_FORBIDDEN", "❌ Você não possui autorização nesse grupo.");
    return repository.updateEvent(event.id, { groupId }, { authorId: context.userId, details: { previousGroupId: event.groupId, newGroupId: groupId } });
  }

  function formatEvent(event, options = {}) {
    if (options.publication) return messageFormatter.formatPublicEvent(event, { ...options, now: options.now || clock() });
    return messageFormatter.formatEventDetails(event, { ...options, now: options.now || clock() });
  }

  function formatEventList(events, title = "📅 EVENTOS DO GRUPO") {
    if (!events.length) return "📅 Não há eventos disponíveis no momento.";
    const lines = [title, ""];
    events.forEach((event, index) => lines.push(messageFormatter.formatEventListItem(event, index + 1, { now: clock() }), ""));
    return lines.join("\n").trim();
  }

  return { createEvent, getEvent, updateEvent, updateEventData, updateEventEnd, scheduleEvent, publishEvent, cancelEvent, archiveEvent, finishEvent, listEvents, listUpcomingEvents, listActiveEvents, listEventHistory, listManageableEvents, moveEvent, formatEvent, formatEventList, parseDate, parseTime, formatDateTime, messageFormatter, STATUS_LABELS, AUTHORIZATION_MESSAGE };
}

const service = createEventService();
module.exports = { ...service, createEventService, STATUS_LABELS, AUTHORIZATION_MESSAGE, DEFAULT_TIMEZONE };
