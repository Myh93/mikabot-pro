"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createConfigurationRepository } = require("../src/repositories/configurationRepository");
const { createConfigurationService } = require("../src/services/configurationService");
const { createQuizService } = require("../src/services/quizService");

const CONTEXT = {
  communityId: "community-1",
  platform: "whatsapp",
  groupId: "group-1",
  userId: "user-1"
};

function fixture(configurationService, options = {}) {
  let active = null;
  const recent = [];
  const repository = {
    async getActiveSession() { return active; },
    async getRecentQuestions() { return []; },
    async createSession(session) {
      active = { ...session, isExpired: false };
      return active;
    },
    async finishSession(platform, groupId, roundId, details) {
      active = {
        ...active, ...details, status: "finished",
        finishedAt: "2026-07-30T12:01:00.000Z", isExpired: false
      };
      return active;
    },
    async addRecentQuestion(platform, groupId, entry) {
      recent.push({ platform, groupId, ...entry });
      return entry;
    },
    async incrementUserStats() {},
    async updateSession() { return active; }
  };
  const questionService = {
    calls: [],
    generateQuestion(input) {
      this.calls.push(input);
      return {
        id: "Q1", type: "pokemon_type", pokemonId: 25,
        acceptedAnswers: ["electric"], difficulty: "normal",
        points: 15, displayAnswer: "Elétrico", prompt: "Pergunta",
        options: [], correctOption: null
      };
    }
  };
  const service = createQuizService({
    repository,
    questionService,
    configurationService,
    clock: () => new Date("2026-07-30T12:00:00.000Z"),
    ...options
  });
  return { service, repository, questionService, recent, getActive: () => active };
}

test("defaults preservam duração e retenção anteriores", async () => {
  const item = fixture(createConfigurationService());
  const started = await item.service.startCollectiveRound(CONTEXT);
  assert.equal(
    Date.parse(started.round.expiresAt) - Date.parse(started.round.startedAt),
    60_000
  );
  await item.service.submitAnswer(CONTEXT, "electric");
  assert.equal(
    Date.parse(item.recent[0].expiresAt) - Date.parse(item.recent[0].usedAt),
    7 * 24 * 60 * 60 * 1000
  );
});

test("override runtime contextual controla timeout e retenção", async () => {
  const configuration = createConfigurationService();
  configuration.set("quiz.roundDurationMilliseconds", 90_000, CONTEXT);
  configuration.set("quiz.recentQuestionRetentionDays", 3, CONTEXT);
  const item = fixture(configuration);
  const started = await item.service.startCollectiveRound(CONTEXT);
  assert.equal(Date.parse(started.round.expiresAt) - Date.parse(started.round.startedAt), 90_000);
  await item.service.submitAnswer(CONTEXT, "electric");
  assert.equal(
    Date.parse(item.recent[0].expiresAt) - Date.parse(item.recent[0].usedAt),
    3 * 24 * 60 * 60 * 1000
  );
});

test("override persistente por grupo é resolvido", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-quiz-config-"));
  try {
    const repository = createConfigurationRepository({
      databaseDir: path.join(root, "database"),
      backupRoot: path.join(root, "backups")
    });
    const configuration = createConfigurationService();
    configuration.attachRepository(repository);
    await configuration.initialize();
    await configuration.setPersistent("quiz.roundDurationMilliseconds", 75_000, CONTEXT);
    const item = fixture(configuration);
    const started = await item.service.startCollectiveRound(CONTEXT);
    assert.equal(Date.parse(started.round.expiresAt) - Date.parse(started.round.startedAt), 75_000);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hierarquia prioriza runtime contextual e mantém fallback comunitário", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-quiz-priority-"));
  try {
    const repository = createConfigurationRepository({
      databaseDir: path.join(root, "database"),
      backupRoot: path.join(root, "backups")
    });
    const configuration = createConfigurationService();
    configuration.attachRepository(repository);
    await configuration.initialize();
    await configuration.setPersistent("quiz.roundDurationMilliseconds", 70_000, {
      communityId: CONTEXT.communityId
    });
    await configuration.setPersistent("quiz.roundDurationMilliseconds", 80_000, CONTEXT);
    configuration.set("quiz.roundDurationMilliseconds", 100_000, CONTEXT);

    const contextual = fixture(configuration);
    const first = await contextual.service.startCollectiveRound(CONTEXT);
    assert.equal(Date.parse(first.round.expiresAt) - Date.parse(first.round.startedAt), 100_000);

    const fallback = fixture(configuration);
    const second = await fallback.service.startCollectiveRound({
      ...CONTEXT, groupId: "other-group"
    });
    assert.equal(Date.parse(second.round.expiresAt) - Date.parse(second.round.startedAt), 70_000);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("duração explícita por chamada e fábrica preserva prioridade legada", async () => {
  const configuration = createConfigurationService();
  configuration.set("quiz.roundDurationMilliseconds", 90_000);
  const item = fixture(configuration, { roundDurationMs: 30_000 });
  const started = await item.service.startCollectiveRound(CONTEXT, {
    durationMs: 5_000
  });
  assert.equal(Date.parse(started.round.expiresAt) - Date.parse(started.round.startedAt), 5_000);

  const factory = fixture(configuration, { roundDurationMs: 30_000 });
  const fallback = await factory.service.startIndividualRound(CONTEXT);
  assert.equal(Date.parse(fallback.round.expiresAt) - Date.parse(fallback.round.startedAt), 30_000);
});

test("contexto é encaminhado ao quizQuestionService sem alterar a pergunta", async () => {
  const item = fixture(createConfigurationService());
  const started = await item.service.startCollectiveRound(CONTEXT);
  assert.equal(started.question.points, 15);
  assert.deepEqual(
    {
      communityId: item.questionService.calls[0].communityId,
      platform: item.questionService.calls[0].platform,
      groupId: item.questionService.calls[0].groupId
    },
    {
      communityId: CONTEXT.communityId,
      platform: CONTEXT.platform,
      groupId: CONTEXT.groupId
    }
  );
});

test("ausência de override usa fallback e exclusivamente getResolved", async () => {
  const calls = [];
  const defaults = createConfigurationService();
  const configuration = {
    getResolved(key, context) {
      calls.push({ key, context });
      return defaults.getResolved(key, context);
    }
  };
  const item = fixture(configuration);
  await item.service.startCollectiveRound(CONTEXT);
  await item.service.submitAnswer(CONTEXT, "electric");
  assert.deepEqual(calls.map((call) => call.key), [
    "quiz.roundDurationMilliseconds",
    "quiz.recentQuestionRetentionDays"
  ]);
  assert.ok(calls.every((call) => call.context.groupId === CONTEXT.groupId));
});

test("quiz individual, coletivo, encerramento e pontuação permanecem compatíveis", async () => {
  const collective = fixture(createConfigurationService());
  await collective.service.startCollectiveRound(CONTEXT);
  const correct = await collective.service.submitAnswer(CONTEXT, "electric");
  assert.equal(correct.status, "correct");
  assert.equal(correct.pointsAwarded, 15);

  const individual = fixture(createConfigurationService());
  const started = await individual.service.startIndividualRound(CONTEXT);
  assert.equal(started.round.mode, "individual");
  const finished = await individual.service.finishRound(CONTEXT);
  assert.equal(finished.status, "finished");
});
