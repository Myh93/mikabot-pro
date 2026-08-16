"use strict";

const memberJourneyDefault = require("./memberJourneyService");

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const quizServiceDefault = require("./quizService");
const identityService = require("./identityService");
const localeService = require("./pokemonLocaleService");
const formatterDefault = require("./quizMarathonFormatter");
const { logDetailedError } = require("../../utils/logger");
const defaultPlayerProgressService = require("./playerProgressService");
const configurationServiceDefault = require("./configurationService");

const DEFAULT_FILE = path.join(__dirname, "..", "database", "quiz-marathon", "sessions.json");
const QUESTION_DURATION_MS = 120_000;
const INTERVAL_MS = 3_000;
const queues = new Map();

function createQuizMarathonService(options = {}) {
  const memberJourney = options.memberJourneyService || (options.quizService ? { grant: async () => ({ granted: false }) } : memberJourneyDefault);
  const filePath = path.resolve(options.filePath || DEFAULT_FILE);
  const quizService = options.quizService || quizServiceDefault;
  const configurationService = options.configurationService || configurationServiceDefault;
  const clock = options.clock || (() => new Date());
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const reportError = options.logError || ((context, error) => logDetailedError(context, error));
  const formatter = options.formatter || formatterDefault;
  const identities = options.identityService || identityService;
  const registrationsFile = options.registrationsFile;
  const progressService = options.playerProgressService || (options.quizService ? {
    registerMarathonParticipation: async () => ({ applied: false }), registerMarathonCompletion: async () => ({ applied: false }),
    registerMarathonWin: async () => ({ applied: false }), registerMvp: async () => ({ applied: false })
  } : defaultPlayerProgressService);
  const timers = new Map();
  const senders = new Map();

  function configurationContext(context = {}) {
    return {
      communityId: context?.communityId,
      platform: context?.platform,
      groupId: context?.groupId
    };
  }

  function questionDuration(context = {}) {
    return configurationService.getResolved(
      "quiz.marathon.questionDurationMilliseconds",
      configurationContext(context)
    ).value;
  }

  function nextQuestionDelay(context = {}) {
    return configurationService.getResolved(
      "quiz.marathon.nextQuestionDelayMilliseconds",
      configurationContext(context)
    ).value;
  }

  const keyFor = (platform, groupId) => `${platform}:${groupId}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function enqueue(operation) {
    const previous = queues.get(filePath) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(filePath, current);
    return current.finally(() => { if (queues.get(filePath) === current) queues.delete(filePath); });
  }

  async function atomicWrite(database) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(temporary, filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async function loadDatabase() {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) await atomicWrite({ schemaVersion: 1, updatedAt: null, sessions: {} });
    const database = JSON.parse(await fsp.readFile(filePath, "utf8"));
    if (database.schemaVersion !== 1 || !database.sessions || typeof database.sessions !== "object") throw new Error("Banco de Maratonas inválido.");
    return database;
  }

  async function mutate(operation) {
    return enqueue(async () => {
      const database = await loadDatabase();
      const result = await operation(database);
      database.updatedAt = clock().toISOString();
      await atomicWrite(database);
      return clone(result);
    });
  }

  async function getSession(platform, groupId) {
    const database = await loadDatabase();
    return clone(database.sessions[keyFor(platform, groupId)] || null);
  }

  async function getActiveMarathon(context) {
    const session = await getSession(context.platform, context.groupId);
    return session?.status === "active" ? session : null;
  }

  async function participantName(context) {
    return identities.resolveDisplayName(context.userId || context.identity, { registrationsFile, msg: context.msg, contact: context.contact, displayName: context.displayName });
  }

  function orderedRanking(session) {
    return Object.values(session?.ranking || {}).sort((a, b) => b.points - a.points || b.correctAnswers - a.correctAnswers || Date.parse(a.firstCorrectAt) - Date.parse(b.firstCorrectAt));
  }

  function formatScoreboard(session, final = false) {
    return formatter.formatScoreboard(orderedRanking(session), final);
  }

  function finalText(session) {
    const ranking = orderedRanking(session);
    const elapsed = Math.max(0, Date.parse(session.finishedAt || clock().toISOString()) - Date.parse(session.startedAt));
    return formatter.formatFinal(session, ranking, elapsed);
  }

  function clearTimer(key) {
    const timer = timers.get(key);
    if (timer) clearTimeoutFn(timer);
    timers.delete(key);
  }

  function schedule(key, delay, operation) {
    clearTimer(key);
    const timer = setTimeoutFn(() => {
      timers.delete(key);
      return Promise.resolve(operation()).catch((error) => reportError("Erro na Maratona do Quiz:", error));
    }, Math.max(0, delay));
    timer?.unref?.();
    timers.set(key, timer);
  }

  async function finishMarathon(context, reason = "completed") {
    const key = keyFor(context.platform, context.groupId);
    clearTimer(key);
    const session = await mutate((database) => {
      const current = database.sessions[key];
      if (!current || current.status !== "active") return current;
      current.status = "finished";
      current.finishReason = reason;
      current.finishedAt = clock().toISOString();
      current.updatedAt = current.finishedAt;
      return current;
    });
    if (session) {
      const ranking = orderedRanking(session);
      const participants = Object.entries(session.participants || {});
      const marathonId = session.marathonId || session.startedAt;
      for (const [playerId, participant] of participants) await progressService.registerMarathonCompletion({ platform: session.platform, groupId: session.groupId, playerId, marathonId, displayName: participant.name, at: session.finishedAt });
      if (ranking.length) {
        const winner = ranking[0];
        await progressService.registerMarathonWin({ platform: session.platform, groupId: session.groupId, playerId: winner.userId, marathonId, displayName: winner.name, at: session.finishedAt });
        await progressService.registerMvp({ platform: session.platform, groupId: session.groupId, playerId: winner.userId, marathonId, displayName: winner.name, at: session.finishedAt });
      }
      await senders.get(key)?.(finalText(session));
    }
    return session;
  }

  async function startNextQuestion(context) {
    const key = keyFor(context.platform, context.groupId);
    let session = await getActiveMarathon(context);
    if (!session) return null;
    if (session.currentQuestion >= session.totalQuestions) return finishMarathon(context);
    const durationMs = questionDuration(context);
    const started = await quizService.startCollectiveRound(context, { durationMs });
    const now = clock();
    session = await mutate((database) => {
      const current = database.sessions[key];
      current.currentQuestion += 1;
      current.currentRoundId = started.round.roundId;
      current.questionStartedAt = now.toISOString();
      current.questionExpiresAt = new Date(now.getTime() + durationMs).toISOString();
      current.nextQuestionAt = null;
      current.updatedAt = now.toISOString();
      return current;
    });
    await senders.get(key)?.(formatter.formatQuestion(started.question, session.currentQuestion, session.totalQuestions, localeService.translateDifficulty));
    schedule(key, durationMs, () => expireCurrentQuestion(context));
    return session;
  }

  async function queueNextQuestion(context) {
    const key = keyFor(context.platform, context.groupId);
    const intervalMs = nextQuestionDelay(context);
    const nextAt = new Date(clock().getTime() + intervalMs).toISOString();
    await mutate((database) => {
      const session = database.sessions[key];
      session.nextQuestionAt = nextAt;
      session.currentRoundId = null;
      session.questionExpiresAt = null;
      session.updatedAt = clock().toISOString();
      return session;
    });
    schedule(key, intervalMs, () => startNextQuestion(context));
  }

  async function expireCurrentQuestion(context) {
    const session = await getActiveMarathon(context);
    if (!session?.currentRoundId) return null;
    await quizService.expireRound({ ...context, roundId: session.currentRoundId });
    if (session.currentQuestion >= session.totalQuestions) return finishMarathon(context);
    await senders.get(keyFor(context.platform, context.groupId))?.(formatter.formatTimeout(true));
    return queueNextQuestion(context);
  }

  async function startMarathon(context, totalQuestions, sendText) {
    if (!context?.isGroup) throw new Error("❌ A Maratona só pode ser iniciada em grupos.");
    if (await getActiveMarathon(context)) return { status: "already_active" };
    const availability = await quizService.canStartRound(context);
    if (!availability.allowed) throw new Error("Já existe uma rodada do Quiz em andamento.");
    const total = Number(totalQuestions || 10);
    if (!Number.isInteger(total) || total < 1 || total > 100) throw new Error("❌ Quantidade de perguntas inválida.");
    const key = keyFor(context.platform, context.groupId);
    senders.set(key, sendText);
    const now = clock().toISOString();
    await mutate((database) => {
      database.sessions[key] = { marathonId: `QM${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`, platform: context.platform, groupId: context.groupId, status: "active", totalQuestions: total, currentQuestion: 0, currentRoundId: null, ranking: {}, participants: {}, startedAt: now, updatedAt: now, questionStartedAt: null, questionExpiresAt: null, nextQuestionAt: null, finishedAt: null, finishReason: null };
      return database.sessions[key];
    });
    await sendText(formatter.formatStart(total));
    const session = await startNextQuestion(context);
    return { status: "started", session };
  }

  async function handleAnswer(context, answer, sendText) {
    const session = await getActiveMarathon(context);
    if (!session) return { status: "no_active_marathon" };
    const key = keyFor(context.platform, context.groupId);
    if (sendText) senders.set(key, sendText);
    const result = await quizService.submitAnswer(context, answer);
    const answeredAt = clock().toISOString();
    const resolvedName = await participantName(context);
    await memberJourney.grant(context.userId, "first_marathon", { platform: context.platform, groupId: context.groupId });
    await mutate((database) => {
      const current = database.sessions[key];
      current.participants[context.userId] ||= { name: resolvedName, joinedAt: answeredAt };
      current.updatedAt = answeredAt;
      return current;
    });
    await progressService.registerMarathonParticipation({ platform: context.platform, groupId: context.groupId, playerId: context.userId, marathonId: session.marathonId || session.startedAt, displayName: resolvedName, at: answeredAt });
    if (result.status !== "correct") return result;
    clearTimer(key);
    const updated = await mutate((database) => {
      const current = database.sessions[key];
      const entry = current.ranking[context.userId] || { userId: context.userId, name: resolvedName, points: 0, correctAnswers: 0, firstCorrectAt: answeredAt };
      entry.name = resolvedName;
      entry.points += Number(result.pointsAwarded || 0);
      entry.correctAnswers += 1;
      current.ranking[context.userId] = entry;
      current.participants[context.userId] ||= { name: entry.name, joinedAt: answeredAt };
      current.currentRoundId = null;
      current.questionExpiresAt = null;
      current.updatedAt = answeredAt;
      return current;
    });
    if (updated.currentQuestion >= updated.totalQuestions) {
      await senders.get(key)?.(formatter.formatCorrectAnswer(resolvedName, result.pointsAwarded, false));
      await finishMarathon(context);
    } else {
      await senders.get(key)?.(formatter.formatCorrectAnswer(resolvedName, result.pointsAwarded, true));
      await queueNextQuestion(context);
    }
    if (result.progression?.leveledUp) {
      await senders.get(key)?.(["━━━━━━━━━━━━━━━━━━━━━━", "🎉 *SUBIU DE NÍVEL!*", "━━━━━━━━━━━━━━━━━━━━━━", "", `⭐ *${resolvedName} alcançou o nível ${result.progression.newLevel}!*`, "", "Continue participando dos Quizzes e Maratonas para evoluir.", "━━━━━━━━━━━━━━━━━━━━━━"].join("\n"));
    }
    return { ...result, marathon: updated };
  }

  async function getStatus(context) {
    const session = await getActiveMarathon(context);
    if (!session) return { active: false, session: null };
    const remaining = session.questionExpiresAt ? Math.max(0, Date.parse(session.questionExpiresAt) - clock().getTime()) : 0;
    return { active: true, session, remainingMs: remaining, participants: Object.keys(session.participants || {}).length };
  }

  async function resetUserData(userId) {
    return mutate(database => {
      let removed = 0;
      for (const session of Object.values(database.sessions)) {
        for (const field of ["participants", "ranking"]) {
          if (session[field] && Object.prototype.hasOwnProperty.call(session[field], userId)) { delete session[field][userId]; removed += 1; }
        }
      }
      return { removed: removed > 0, itemsRemoved: removed };
    });
  }

  async function stopMarathon(context, sendText) {
    const session = await getActiveMarathon(context);
    if (!session) return { status: "none" };
    const key = keyFor(context.platform, context.groupId);
    if (sendText) senders.set(key, sendText);
    if (session.currentRoundId) await quizService.finishRound({ ...context, roundId: session.currentRoundId }, { finishReason: "marathon_stopped" });
    return { status: "stopped", session: await finishMarathon(context, "stopped") };
  }

  async function resume(client) {
    const database = await loadDatabase();
    const active = Object.values(database.sessions).filter((session) => session.status === "active");
    for (const session of active) {
      const context = { platform: session.platform, groupId: session.groupId, isGroup: true };
      const key = keyFor(session.platform, session.groupId);
      senders.set(key, (text) => client.sendMessage(session.groupId, text));
      if (session.nextQuestionAt) schedule(key, Date.parse(session.nextQuestionAt) - clock().getTime(), () => startNextQuestion(context));
      else if (session.questionExpiresAt) schedule(key, Date.parse(session.questionExpiresAt) - clock().getTime(), () => expireCurrentQuestion(context));
      else schedule(key, 0, () => startNextQuestion(context));
    }
    return active.length;
  }

  return { loadDatabase, getSession, startMarathon, handleAnswer, getActiveMarathon, getStatus, getScoreboard: async (context) => { const session = await getActiveMarathon(context); return session ? formatScoreboard(session) : null; }, stopMarathon, resume, resetUserData, orderedRanking, formatScoreboard, finalText, formatter, getIntervalMs: (context) => nextQuestionDelay(context), getQuestionDurationMs: (context) => questionDuration(context) };
}

const service = createQuizMarathonService();
module.exports = { ...service, createQuizMarathonService, QUESTION_DURATION_MS, INTERVAL_MS };
