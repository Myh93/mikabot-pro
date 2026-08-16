"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createConfigurationRepository } = require("../src/repositories/configurationRepository");
const { createConfigurationService } = require("../src/services/configurationService");
const {
  createQuizMarathonService,
  QUESTION_DURATION_MS,
  INTERVAL_MS
} = require("../src/services/quizMarathonService");

const CONTEXT = {
  communityId: "community-1",
  platform: "whatsapp",
  groupId: "group-1",
  userId: "user-1",
  isGroup: true,
  displayName: "Treinador"
};

async function fixture(configurationService) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-marathon-config-"));
  const timers = [];
  let sequence = 0;
  const quizService = {
    async canStartRound() { return { allowed: true }; },
    async startCollectiveRound(context, configuration) {
      sequence += 1;
      return {
        round: { roundId: `Q${sequence}`, points: 15 },
        question: {
          prompt: "Pergunta", difficulty: "normal", points: 15,
          options: [], acceptedAnswers: ["resposta"]
        },
        configuration
      };
    },
    async submitAnswer() {
      return { status: "correct", pointsAwarded: 15 };
    },
    async expireRound() { return { status: "expired" }; },
    async finishRound() { return { status: "finished" }; }
  };
  const service = createQuizMarathonService({
    filePath: path.join(root, "sessions.json"),
    quizService,
    configurationService,
    clock: () => new Date("2026-07-30T12:00:00.000Z"),
    identityService: {
      async resolveDisplayName() { return "Treinador"; }
    },
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) { timer.cleared = true; }
  });
  return { root, service, timers, quizService };
}

async function cleanup(item) {
  await fsp.rm(item.root, { recursive: true, force: true });
}

function activeTimer(item) {
  return [...item.timers].reverse().find((timer) => !timer.cleared);
}

test("defaults preservam duração e intervalo anteriores", async () => {
  const item = await fixture(createConfigurationService());
  try {
    const result = await item.service.startMarathon(CONTEXT, 5, async () => {});
    assert.equal(QUESTION_DURATION_MS, 120_000);
    assert.equal(INTERVAL_MS, 3_000);
    assert.equal(item.service.getQuestionDurationMs(CONTEXT), 120_000);
    assert.equal(item.service.getIntervalMs(CONTEXT), 3_000);
    assert.equal(activeTimer(item).delay, 120_000);
    assert.equal(
      Date.parse(result.session.questionExpiresAt) -
      Date.parse(result.session.questionStartedAt),
      120_000
    );
  } finally {
    await cleanup(item);
  }
});

test("override runtime contextual controla duração e troca de rodada", async () => {
  const configuration = createConfigurationService();
  configuration.set("quiz.marathon.questionDurationMilliseconds", 45_000, CONTEXT);
  configuration.set("quiz.marathon.nextQuestionDelayMilliseconds", 7_000, CONTEXT);
  const item = await fixture(configuration);
  try {
    await item.service.startMarathon(CONTEXT, 5, async () => {});
    assert.equal(activeTimer(item).delay, 45_000);
    await item.service.handleAnswer(CONTEXT, "resposta", async () => {});
    assert.equal(activeTimer(item).delay, 7_000);
    const session = await item.service.getActiveMarathon(CONTEXT);
    assert.equal(
      Date.parse(session.nextQuestionAt) -
      Date.parse("2026-07-30T12:00:00.000Z"),
      7_000
    );
  } finally {
    await cleanup(item);
  }
});

test("override persistente por grupo é resolvido", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-marathon-persistent-"));
  try {
    const repository = createConfigurationRepository({
      databaseDir: path.join(root, "database"),
      backupRoot: path.join(root, "backups")
    });
    const configuration = createConfigurationService();
    configuration.attachRepository(repository);
    await configuration.initialize();
    await configuration.setPersistent(
      "quiz.marathon.questionDurationMilliseconds",
      75_000,
      CONTEXT
    );
    const item = await fixture(configuration);
    try {
      await item.service.startMarathon(CONTEXT, 5, async () => {});
      assert.equal(activeTimer(item).delay, 75_000);
    } finally {
      await cleanup(item);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hierarquia prioriza runtime contextual e mantém fallback comunitário", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-marathon-priority-"));
  try {
    const repository = createConfigurationRepository({
      databaseDir: path.join(root, "database"),
      backupRoot: path.join(root, "backups")
    });
    const configuration = createConfigurationService();
    configuration.attachRepository(repository);
    await configuration.initialize();
    await configuration.setPersistent(
      "quiz.marathon.nextQuestionDelayMilliseconds",
      5_000,
      { communityId: CONTEXT.communityId }
    );
    await configuration.setPersistent(
      "quiz.marathon.nextQuestionDelayMilliseconds",
      6_000,
      CONTEXT
    );
    configuration.set(
      "quiz.marathon.nextQuestionDelayMilliseconds",
      8_000,
      CONTEXT
    );
    const item = await fixture(configuration);
    try {
      assert.equal(item.service.getIntervalMs(CONTEXT), 8_000);
      assert.equal(item.service.getIntervalMs({
        ...CONTEXT, groupId: "other-group"
      }), 5_000);
    } finally {
      await cleanup(item);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
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
  const item = await fixture(configuration);
  try {
    await item.service.startMarathon(CONTEXT, 5, async () => {});
    await item.service.handleAnswer(CONTEXT, "resposta", async () => {});
    assert.ok(calls.some((call) =>
      call.key === "quiz.marathon.questionDurationMilliseconds"
    ));
    assert.ok(calls.some((call) =>
      call.key === "quiz.marathon.nextQuestionDelayMilliseconds"
    ));
    assert.ok(calls.every((call) => call.context.groupId === CONTEXT.groupId));
  } finally {
    await cleanup(item);
  }
});

test("rodadas, encerramento e integração com quizService permanecem iguais", async () => {
  const item = await fixture(createConfigurationService());
  try {
    await item.service.startMarathon(CONTEXT, 1, async () => {});
    const result = await item.service.handleAnswer(
      CONTEXT, "resposta", async () => {}
    );
    assert.equal(result.status, "correct");
    const session = await item.service.getSession(
      CONTEXT.platform, CONTEXT.groupId
    );
    assert.equal(session.status, "finished");
    assert.equal(session.totalQuestions, 1);
    assert.equal(session.ranking[CONTEXT.userId].points, 15);
  } finally {
    await cleanup(item);
  }
});
