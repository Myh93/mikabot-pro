"use strict";

const eventRepositoryDefault = require("../repositories/eventRepository");
const eventServiceDefault = require("./eventService");
const eventMessageFormatterDefault = require("./eventMessageFormatter");
const memberLeaveDefault = require("./memberLeaveService");
const memberMediaDefault = require("./memberMediaLibraryService");
const { logDetailedError, logInfo } = require("../../utils/logger");

const INTERVAL_MS = 30_000;
const TIMEZONE = "America/Fortaleza";
const activeSchedulers = new Map();

const NOTIFICATION_DEFINITIONS = [
  { key: "24h", offsetMs: 24 * 60 * 60 * 1000, level: "normal", formatter: "formatReminder24h" },
  { key: "1h", offsetMs: 60 * 60 * 1000, level: "important", formatter: "formatReminder1h" },
  { key: "30m", offsetMs: 30 * 60 * 1000, level: "important", formatter: "formatReminder30m" },
  { key: "10m", offsetMs: 10 * 60 * 1000, level: "critical", formatter: "formatReminder10m" }
];

const LEVEL_DESTINATIONS = {
  critical: "group", important: "group", normal: "group",
  administrative: "owner", debug: "owner"
};

function createEventSchedulerService(options = {}) {
  const repository = options.repository || eventRepositoryDefault;
  const eventService = options.eventService || eventServiceDefault;
  const messageFormatter = options.messageFormatter || eventMessageFormatterDefault;
  const memberLeaveService = options.memberLeaveService || ((options.repository || options.eventService) ? { evaluateDueRemovals: async () => [] } : memberLeaveDefault);
  const memberMediaService = options.memberMediaLibraryService || ((options.repository || options.eventService) ? { refreshDue: async () => ({ skipped: true }) } : memberMediaDefault);
  const clock = options.clock || (() => new Date());
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const schedulerKey = options.schedulerKey || "mikabot-events-default";
  const reportError = options.logError || ((context, error) => logDetailedError(context, error));
  const reportInfo = options.logInfo || ((message) => logInfo(message));
  const sendOwnerNotification = options.sendOwnerNotification || null;
  let timer = null;
  let client = options.client || null;
  let checking = false;

  const nowIso = () => clock().toISOString();

  function notificationRecords(event) {
    return Array.isArray(event.notifications) ? event.notifications : [];
  }

  function notificationConfiguration(event, key) {
    const configured = event.settings?.notifications;
    if (!configured) return { enabled: true };
    if (Array.isArray(configured)) {
      const entry = configured.find((item) => (typeof item === "string" ? item : item?.key) === key);
      if (!entry) return { enabled: false };
      return typeof entry === "string" ? { enabled: true } : { enabled: entry.enabled !== false, ...entry };
    }
    const entry = configured[key];
    if (entry === undefined) return { enabled: false };
    return typeof entry === "boolean" ? { enabled: entry } : { enabled: entry?.enabled !== false, ...entry };
  }

  function wasSent(event, key) {
    return notificationRecords(event).some((record) => record?.key === key && record.sentAt);
  }

  async function persistReceipt(event, definition, destination, sentAt) {
    const records = notificationRecords(event).filter((record) => record?.key !== definition.key);
    records.push({
      key: definition.key,
      level: definition.level,
      destination,
      scheduledFor: definition.scheduledFor,
      sentAt
    });
    return repository.updateEvent(event.id, { notifications: records }, {
      action: "updated",
      details: { notification: definition.key, level: definition.level, destination }
    });
  }

  async function deliver(event, definition) {
    const configured = notificationConfiguration(event, definition.key);
    if (!configured.enabled || wasSent(event, definition.key)) return { status: "ignored" };
    const destination = configured.destination || LEVEL_DESTINATIONS[configured.level || definition.level];
    const text = messageFormatter[definition.formatter](event, { now: clock() });
    if (destination === "group") {
      if (!event.groupId || !client?.sendMessage) throw new Error(`Canal de grupo indisponível para ${event.id}.`);
      await client.sendMessage(event.groupId, text);
    } else if (destination === "owner") {
      if (!sendOwnerNotification) return { status: "prepared", destination, text };
      await sendOwnerNotification(text, { event, definition });
    } else if (destination === "log") {
      reportInfo(`[Eventos] ${definition.key} processada para ${event.id}.`);
    } else {
      throw new Error(`Destino de notificação inválido: ${destination}.`);
    }
    await persistReceipt(event, { ...definition, level: configured.level || definition.level }, destination, nowIso());
    return { status: "sent", destination, text };
  }

  async function processWarnings(event, now) {
    const startsAt = Date.parse(event.startsAt);
    if (!Number.isFinite(startsAt)) return;
    for (const definition of NOTIFICATION_DEFINITIONS) {
      const scheduledForMs = startsAt - definition.offsetMs;
      if (now < scheduledForMs) continue;
      await deliver(event, { ...definition, scheduledFor: new Date(scheduledForMs).toISOString() });
      event = await repository.getEventById(event.id);
    }
  }

  async function startEvent(event, now) {
    if (now < Date.parse(event.startsAt) || !["scheduled", "published"].includes(event.status)) return event;
    if (!wasSent(event, "start")) {
      await deliver(event, {
        key: "start", level: "critical", scheduledFor: event.startsAt,
        formatter: "formatEventStarted"
      });
      event = await repository.getEventById(event.id);
    }
    return repository.startEvent(event.id, { startedAt: new Date(now).toISOString() }, { details: { source: "scheduler" } });
  }

  async function finishEvent(event, now) {
    if (event.status !== "running" || !event.endsAt || now < Date.parse(event.endsAt)) return event;
    if (!wasSent(event, "end")) {
      await deliver(event, {
        key: "end", level: "important", scheduledFor: event.endsAt,
        formatter: "formatEventFinished"
      });
      event = await repository.getEventById(event.id);
    }
    return repository.finishEvent(event.id, { finishedAt: new Date(now).toISOString() }, { details: { source: "scheduler" } });
  }

  async function processEvent(event, now) {
    if (["cancelled", "archived", "finished", "draft"].includes(event.status)) return;
    if (["scheduled", "published"].includes(event.status) && event.startsAt) {
      await processWarnings(event, now);
      event = await repository.getEventById(event.id);
      event = await startEvent(event, now);
    }
    if (event?.status === "running") await finishEvent(event, now);
  }

  async function checkNow() {
    if (checking) return { status: "busy", processed: 0 };
    checking = true;
    try {
      const now = clock().getTime();
      const events = await repository.listEvents({ includeArchived: true });
      const eligible = events.filter((event) => ["scheduled", "published", "running"].includes(event.status));
      for (const event of eligible) {
        try {
          await processEvent(event, now);
        } catch (error) {
          reportError(`Erro no scheduler do evento ${event.id}:`, error);
        }
      }
      try {
        await memberLeaveService.evaluateDueRemovals();
      } catch (error) {
        reportError("Erro ao avaliar remoções pendentes de membros:", error);
      }
      try { await memberMediaService.refreshDue(); } catch (error) { reportError("Erro ao atualizar cache de mídias:", error); }
      return { status: "checked", processed: eligible.length, checkedAt: nowIso() };
    } finally {
      checking = false;
    }
  }

  async function start(schedulerClient = client) {
    const existing = activeSchedulers.get(schedulerKey);
    if (existing) return { started: false, alreadyRunning: true, scheduler: existing };
    client = schedulerClient;
    if (!client?.sendMessage) throw new Error("Cliente de envio é obrigatório para iniciar o scheduler.");
    activeSchedulers.set(schedulerKey, api);
    try {
      await checkNow();
      timer = setIntervalFn(() => checkNow().catch((error) => reportError("Erro no ciclo do scheduler de Eventos:", error)), INTERVAL_MS);
      timer?.unref?.();
      reportInfo("Scheduler de Eventos iniciado.");
      return { started: true, alreadyRunning: false, scheduler: api };
    } catch (error) {
      activeSchedulers.delete(schedulerKey);
      throw error;
    }
  }

  function stop() {
    if (activeSchedulers.get(schedulerKey) !== api) return false;
    if (timer) clearIntervalFn(timer);
    timer = null;
    activeSchedulers.delete(schedulerKey);
    return true;
  }

  const api = {
    start, stop, checkNow,
    isRunning: () => activeSchedulers.get(schedulerKey) === api,
    getIntervalMs: () => INTERVAL_MS,
    getTimezone: () => TIMEZONE,
    getNotificationDefinitions: () => NOTIFICATION_DEFINITIONS.map((item) => ({ key: item.key, offsetMs: item.offsetMs, level: item.level })),
    getLevelDestinations: () => ({ ...LEVEL_DESTINATIONS })
  };
  return api;
}

const scheduler = createEventSchedulerService();
module.exports = { ...scheduler, createEventSchedulerService, INTERVAL_MS, TIMEZONE, NOTIFICATION_DEFINITIONS, LEVEL_DESTINATIONS };
