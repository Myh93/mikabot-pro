"use strict";

const crypto = require("crypto");
const defaultRepository = require("../repositories/quizRepository");
const defaultQuestionService = require("./quizQuestionService");
const { answersMatch } = require("./quizAnswerNormalizer");
const localeService = require("./pokemonLocaleService");
const { normalizeAnswer } = require("./quizAnswerNormalizer");
const defaultPlayerProgressService = require("./playerProgressService");
const configurationServiceDefault = require("./configurationService");
const memberJourneyDefault = require("./memberJourneyService");

const roundLocks = new Map();

function createQuizService(options = {}) {
  const repository = options.repository || defaultRepository;
  const questionService = options.questionService || defaultQuestionService;
  const configurationService = options.configurationService || configurationServiceDefault;
  const explicitRoundDurationMs = options.roundDurationMs || null;
  const explicitRecentQuestionTtlMs = options.recentQuestionTtlMs || null;
  const clock = options.clock || (() => new Date());
  const playerProgressService = options.playerProgressService || (options.repository ? {
    registerCorrectAnswer: async () => ({ applied: false, leveledUp: false }),
    registerWrongAnswer: async () => ({ applied: false, leveledUp: false })
  } : defaultPlayerProgressService);
  const memberJourney = options.memberJourneyService || (options.repository ? { grant: async () => ({ granted: false }) } : memberJourneyDefault);

  function configurationContext(context = {}) {
    return {
      communityId: context?.communityId,
      platform: context?.platform,
      groupId: context?.groupId
    };
  }

  function roundDuration(context) {
    if (explicitRoundDurationMs) return explicitRoundDurationMs;
    return configurationService.getResolved(
      "quiz.roundDurationMilliseconds",
      configurationContext(context)
    ).value;
  }

  function recentQuestionTtl(context) {
    if (explicitRecentQuestionTtlMs) return explicitRecentQuestionTtlMs;
    const days = configurationService.getResolved(
      "quiz.recentQuestionRetentionDays",
      configurationContext(context)
    ).value;
    return days * 24 * 60 * 60 * 1000;
  }

  function contextKey(context) {
    if (!context?.platform || !context?.groupId) throw new Error("platform e groupId são obrigatórios.");
    return `${context.platform}:${context.groupId}`;
  }

  function withRoundLock(context, operation) {
    const key = contextKey(context);
    const previous = roundLocks.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    roundLocks.set(key, current);
    return current.finally(() => {
      if (roundLocks.get(key) === current) roundLocks.delete(key);
    });
  }

  function generateRoundId() {
    return `QR${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`;
  }

  async function canStartRound(context) {
    const active = await repository.getActiveSession(context.platform, context.groupId);
    if (!active) return { allowed: true, reason: null };
    if (active.isExpired) return { allowed: false, reason: "expired_session_pending", round: active };
    return { allowed: false, reason: "active_session_exists", round: active };
  }

  async function buildAndPersistRound(context, mode, configuration = {}) {
    return withRoundLock(context, async () => {
      const permission = await canStartRound(context);
      if (!permission.allowed) throw new Error(`Não é possível iniciar rodada: ${permission.reason}.`);
      if (mode === "individual" && !context.userId) throw new Error("userId é obrigatório para rodada individual.");
      const recentQuestions = await repository.getRecentQuestions(context.platform, context.groupId);
      const question = questionService.generateQuestion({
        questionType: configuration.questionType,
        pokemonId: configuration.pokemonId,
        recentQuestions,
        ...configurationContext(context)
      });
      const startedAt = clock();
      const roundId = configuration.roundId || generateRoundId();
      const session = await repository.createSession({
        platform: context.platform,
        groupId: context.groupId,
        roundId,
        mode,
        status: "active",
        questionType: question.type,
        pokemonId: question.pokemonId,
        acceptedAnswers: question.acceptedAnswers,
        attemptsByUser: {},
        participants: mode === "individual" ? { [context.userId]: { joinedAt: startedAt.toISOString() } } : {},
        initiatorId: context.userId || null,
        difficulty: question.difficulty,
        points: question.points,
        question,
        displayAnswer: question.displayAnswer,
        startedAt: startedAt.toISOString(),
        expiresAt: new Date(
          startedAt.getTime() +
          (configuration.durationMs || roundDuration(context))
        ).toISOString(),
        winnerId: null,
        finishedAt: null
      });
      return { status: "started", round: session, question };
    });
  }

  function startCollectiveRound(context, configuration = {}) {
    return buildAndPersistRound(context, "collective", configuration);
  }

  function startIndividualRound(context, configuration = {}) {
    return buildAndPersistRound(context, "individual", configuration);
  }

  async function recordRecent(session, context = {}) {
    const usedAt = clock();
    await repository.addRecentQuestion(session.platform, session.groupId, {
      pokemonId: session.pokemonId,
      questionType: session.questionType,
      correctAnswer: normalizeAnswer(session.displayAnswer || session.question?.displayAnswer || session.acceptedAnswers?.[0] || ""),
      usedAt: usedAt.toISOString(),
      expiresAt: new Date(
        usedAt.getTime() +
        recentQuestionTtl({ ...context, platform: session.platform, groupId: session.groupId })
      ).toISOString()
    });
  }

  async function finishRoundUnlocked(context, session, details = {}) {
    const finished = await repository.finishSession(context.platform, context.groupId, session.roundId, details);
    await recordRecent(finished, context);
    return finished;
  }

  async function submitAnswer(context, answer) {
    if (!context?.userId) throw new Error("userId é obrigatório para responder.");
    return withRoundLock(context, async () => {
      const session = await repository.getActiveSession(context.platform, context.groupId);
      if (!session) return { status: "no_active_round" };
      if (session.isExpired) return expireRoundUnlocked(context, session);
      if (session.mode === "individual" && session.initiatorId !== context.userId) return { status: "not_participant" };
      if (normalizeAnswer(answer)) await memberJourney.grant(context.userId, "first_quiz", { platform: context.platform, groupId: context.groupId });

      const correct = answersMatch(answer, session.acceptedAnswers);
      if (session.mode === "collective") {
        if (!correct) return { status: "ignored" };
        const finished = await finishRoundUnlocked(context, session, { winnerId: context.userId, finishReason: "correct_answer" });
        await repository.incrementUserStats(context.platform, context.groupId, context.userId, {
          points: session.points, correctAnswers: 1, gamesPlayed: 1, wins: 1, streakDelta: 1,
          questionType: session.questionType, difficulty: session.difficulty, lastPlayedAt: finished.finishedAt
        });
        const progression = await playerProgressService.registerCorrectAnswer({ platform: context.platform, groupId: context.groupId, playerId: context.userId, roundId: session.roundId, difficulty: session.difficulty, displayName: context.displayName, at: finished.finishedAt });
        return { status: "correct", round: finished, winnerId: context.userId, pointsAwarded: session.points, progression };
      }

      const attempts = Number(session.attemptsByUser?.[context.userId] || 0);
      if (correct) {
        const multiplier = [1, 0.75, 0.5][Math.min(attempts, 2)];
        const pointsAwarded = Number((session.points * multiplier).toFixed(2));
        const finished = await finishRoundUnlocked(context, session, { winnerId: context.userId, finishReason: "correct_answer", attemptsUsed: attempts + 1 });
        await repository.incrementUserStats(context.platform, context.groupId, context.userId, {
          points: pointsAwarded, correctAnswers: 1, gamesPlayed: 1, wins: 1, streakDelta: 1,
          questionType: session.questionType, difficulty: session.difficulty, lastPlayedAt: finished.finishedAt
        });
        const progression = await playerProgressService.registerCorrectAnswer({ platform: context.platform, groupId: context.groupId, playerId: context.userId, roundId: session.roundId, difficulty: session.difficulty, displayName: context.displayName, at: finished.finishedAt });
        return { status: "correct", round: finished, winnerId: context.userId, pointsAwarded, progression };
      }

      const nextAttempts = attempts + 1;
      await repository.incrementUserStats(context.platform, context.groupId, context.userId, {
        wrongAnswers: 1, questionType: session.questionType, difficulty: session.difficulty, lastPlayedAt: clock().toISOString()
      });
      const progression = await playerProgressService.registerWrongAnswer({ platform: context.platform, groupId: context.groupId, playerId: context.userId, roundId: session.roundId, difficulty: session.difficulty, displayName: context.displayName, at: clock().toISOString() });
      const updatedAttempts = { ...(session.attemptsByUser || {}), [context.userId]: nextAttempts };
      if (nextAttempts >= 3) {
        await repository.updateSession(context.platform, context.groupId, session.roundId, { attemptsByUser: updatedAttempts });
        const finished = await finishRoundUnlocked(context, { ...session, attemptsByUser: updatedAttempts }, { finishReason: "attempts_exhausted", attemptsUsed: nextAttempts });
        await repository.incrementUserStats(context.platform, context.groupId, context.userId, {
          gamesPlayed: 1, currentStreak: 0, questionType: session.questionType, difficulty: session.difficulty, lastPlayedAt: finished.finishedAt
        });
        return { status: "finished", reason: "attempts_exhausted", round: finished, attemptsRemaining: 0, correctAnswer: localizedCorrectAnswer(session), progression };
      }
      const updated = await repository.updateSession(context.platform, context.groupId, session.roundId, { attemptsByUser: updatedAttempts });
      return { status: "wrong", round: updated, attemptsRemaining: 3 - nextAttempts, progression };
    });
  }

  async function expireRoundUnlocked(context, session) {
    if (session.status === "finished") return { status: "expired", round: session, correctAnswer: localizedCorrectAnswer(session) };
    const finished = await finishRoundUnlocked(context, session, { finishReason: "expired", expiredAt: clock().toISOString() });
    if (session.mode === "individual" && session.initiatorId) {
      await repository.incrementUserStats(context.platform, context.groupId, session.initiatorId, {
        gamesPlayed: 1, currentStreak: 0, questionType: session.questionType, difficulty: session.difficulty, lastPlayedAt: finished.finishedAt
      });
    }
    return { status: "expired", round: finished, correctAnswer: localizedCorrectAnswer(session) };
  }

  async function expireRound(context) {
    return withRoundLock(context, async () => {
      const session = await repository.getActiveSession(context.platform, context.groupId);
      if (!session) {
        const persisted = await getPersistedSession(context, context.roundId);
        if (persisted?.status === "finished" && persisted.finishReason === "expired") return { status: "expired", round: persisted, correctAnswer: localizedCorrectAnswer(persisted) };
        return { status: "no_active_round" };
      }
      if (!session.isExpired) return { status: "not_expired", round: session };
      return expireRoundUnlocked(context, session);
    });
  }

  async function finishRound(context, details = {}) {
    return withRoundLock(context, async () => {
      const session = await repository.getActiveSession(context.platform, context.groupId);
      if (!session) {
        const persisted = await getPersistedSession(context, details.roundId || context.roundId);
        if (persisted?.status === "finished") return { status: "finished", round: persisted };
        return { status: "no_active_round" };
      }
      const finished = await finishRoundUnlocked(context, session, { ...details, finishReason: details.finishReason || "manual" });
      return { status: "finished", round: finished };
    });
  }

  async function getRoundStatus(context) {
    const session = await repository.getActiveSession(context.platform, context.groupId);
    if (!session) {
      const persisted = await getPersistedSession(context, context.roundId);
      return persisted ? { status: persisted.status, round: persisted } : { status: "none", round: null };
    }
    return { status: session.isExpired ? "expired" : "active", round: session };
  }

  async function getPersistedSession(context, roundId) {
    if (!roundId) return null;
    const database = await repository.loadQuizDatabase();
    return database.sessions.sessions[`${context.platform}:${context.groupId}:${roundId}`] || null;
  }

  function localizedCorrectAnswer(session) {
    return localeService.translateAnswer(session.displayAnswer || session.question?.displayAnswer || session.acceptedAnswers?.[0] || "");
  }

  return { startCollectiveRound, startIndividualRound, submitAnswer, expireRound, finishRound, getRoundStatus, canStartRound, generateRoundId };
}

const service = createQuizService();
module.exports = { ...service, createQuizService };
