"use strict";

const raidRepositoryDefault = require("../repositories/raidRepository");
const { logDetailedError, logInfo } = require("../../utils/logger");

const INTERVAL_MS = 30_000;
const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000;
const activeSchedulers = new Map();
const REMINDERS = [
  { key: "15m", offsetMs: 15 * 60 * 1000, label: "15 minutos" },
  { key: "5m", offsetMs: 5 * 60 * 1000, label: "5 minutos" },
  { key: "start", offsetMs: 0, label: "agora" }
];

function pokemonName(value) {
  return String(value || "").split(" ")
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function createRaidLifecycleService(options = {}) {
  const repository = options.repository || raidRepositoryDefault;
  const clock = options.clock || (() => new Date());
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const schedulerKey = options.schedulerKey || "mikabot-raids-default";
  const reportError = options.logError || ((context, error) => logDetailedError(context, error));
  const reportInfo = options.logInfo || ((message) => logInfo(message));
  let client = options.client || null;
  let timer = null;
  let checking = false;

  function destinations(raid) {
    const publications = Array.isArray(raid.publications) ? raid.publications : [];
    return [...new Set([
      ...publications.map(item => item?.groupId),
      ...(publications.length ? [] : [raid.groupId || raid.primaryGroupId])
    ].filter(Boolean))];
  }

  function receipts(raid) {
    return new Set(Array.isArray(raid.lifecycleNotifications)
      ? raid.lifecycleNotifications
      : []);
  }

  function reminderText(raid, reminder) {
    if (reminder.key === "start") {
      return `🚨 Raid ${raid.id} começou agora.\n👾 ${pokemonName(raid.name)}`;
    }
    return `⏰ Raid ${raid.id}\n👾 ${pokemonName(raid.name)}\n⏱️ Começa em ${reminder.label}.`;
  }

  function finalText(raid) {
    return [
      `🏁 Raid ${raid.id} encerrada.`,
      `👾 ${pokemonName(raid.name || raid.nomeOficial)}`,
      `👥 ${(raid.participants || []).length} participantes.`
    ].join("\n");
  }

  async function sendOnce(raid, key, text) {
    let current = raid;
    for (const groupId of destinations(current)) {
      const receipt = `${key}:${groupId}`;
      if (receipts(current).has(receipt)) continue;
      await client.sendMessage(groupId, text);
      current = repository.updateRaid(current.id, {
        lifecycleNotifications: [...receipts(current), receipt]
      });
    }
    return current;
  }

  async function processPublished(raid, now) {
    const expiresAt = Date.parse(raid.expiresAt);
    if (Number.isFinite(expiresAt) && now >= expiresAt) {
      const endedAt = new Date(now).toISOString();
      raid = repository.updateRaid(raid.id, {
        status: "completed",
        completedAt: endedAt,
        endedAt
      });
      return sendOnce(raid, "end", finalText(raid));
    }

    const startsAt = Date.parse(raid.startsAt);
    if (Number.isFinite(startsAt)) {
      for (const reminder of REMINDERS) {
        if (now < startsAt - reminder.offsetMs) continue;
        raid = await sendOnce(raid, reminder.key, reminderText(raid, reminder));
      }
    }

    return raid;
  }

  function archiveCompleted(raid, now) {
    const completedAt = Date.parse(raid.completedAt || raid.endedAt);
    if (!Number.isFinite(completedAt) || now < completedAt + ARCHIVE_AFTER_MS) return raid;
    return repository.updateRaid(raid.id, {
      status: "archived",
      archivedAt: new Date(now).toISOString(),
      archiveReason: "automatic_lifecycle_24h"
    });
  }

  async function processCompleted(raid, now) {
    raid = await sendOnce(raid, "end", finalText(raid));
    return archiveCompleted(raid, now);
  }

  async function checkNow() {
    if (checking) return { status: "busy", processed: 0 };
    checking = true;
    let processed = 0;
    try {
      const now = clock().getTime();
      const raids = repository.listLifecycleRaids();
      for (const current of raids) {
        try {
          if (current.status === "published") await processPublished(current, now);
          else if (current.status === "completed") await processCompleted(current, now);
          processed += 1;
        } catch (error) {
          reportError(`Erro no ciclo da Raid ${current.id}:`, error);
        }
      }
      return { status: "checked", processed, checkedAt: clock().toISOString() };
    } finally {
      checking = false;
    }
  }

  async function start(schedulerClient = client) {
    const existing = activeSchedulers.get(schedulerKey);
    if (existing) return { started: false, alreadyRunning: true, scheduler: existing };
    client = schedulerClient;
    if (!client?.sendMessage) throw new Error("Cliente de envio é obrigatório para o ciclo de Raids.");
    activeSchedulers.set(schedulerKey, api);
    try {
      await checkNow();
      timer = setIntervalFn(() => checkNow().catch(error =>
        reportError("Erro no ciclo automático de Raids:", error)
      ), INTERVAL_MS);
      timer?.unref?.();
      reportInfo("Ciclo automático de Raids iniciado.");
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
    start,
    stop,
    checkNow,
    isRunning: () => activeSchedulers.get(schedulerKey) === api,
    getIntervalMs: () => INTERVAL_MS
  };
  return api;
}

const service = createRaidLifecycleService();
module.exports = {
  ...service,
  createRaidLifecycleService,
  INTERVAL_MS,
  ARCHIVE_AFTER_MS,
  REMINDERS
};
