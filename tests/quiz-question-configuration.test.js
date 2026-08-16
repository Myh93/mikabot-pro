"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createConfigurationRepository } = require("../src/repositories/configurationRepository");
const { createConfigurationService } = require("../src/services/configurationService");
const {
  createQuizQuestionService,
  QUESTION_DISTRIBUTION
} = require("../src/services/quizQuestionService");

const CONTEXT = {
  communityId: "community-1",
  platform: "whatsapp",
  groupId: "group-1"
};

test("defaults preservam distribuição, pontuação e comportamento anterior", () => {
  const service = createQuizQuestionService({
    configurationService: createConfigurationService(),
    random: () => 0
  });
  assert.deepEqual(QUESTION_DISTRIBUTION, {
    multipleChoice4: 0.20, multipleChoice5: 0.20, weaknessChoice: 0.20,
    trueFalse: 0.20, open: 0.20
  });
  assert.equal(service.selectQuestionCategory(), "multipleChoice4");
  assert.equal(service.calculatePoints("easy"), 10);
  assert.equal(service.calculatePoints("normal"), 15);
  assert.equal(service.calculatePoints("hard"), 20);
});

test("override runtime contextual controla distribuição e pontuação", () => {
  const configuration = createConfigurationService();
  configuration.set("quiz.questions.distribution", {
    multipleChoice4: 0, multipleChoice5: 0, weaknessChoice: 0,
    trueFalse: 0, open: 1
  }, CONTEXT);
  configuration.set("quiz.scoring.hardPoints", 33, CONTEXT);
  const service = createQuizQuestionService({
    configurationService: configuration,
    random: () => 0
  });
  assert.equal(service.selectQuestionCategory(CONTEXT), "open");
  assert.equal(service.calculatePoints("hard", CONTEXT), 33);
});

test("overrides persistentes são resolvidos por grupo", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-question-config-"));
  try {
    const repository = createConfigurationRepository({
      databaseDir: path.join(root, "database"),
      backupRoot: path.join(root, "backups")
    });
    const configuration = createConfigurationService();
    configuration.attachRepository(repository);
    await configuration.initialize();
    await configuration.setPersistent("quiz.scoring.normalPoints", 27, CONTEXT);
    await configuration.setPersistent("quiz.questions.recentPokemonWindow", 5, CONTEXT);
    const service = createQuizQuestionService({
      configurationService: configuration,
      random: () => 0
    });
    const question = service.generateQuestionByType("pokemon_type", CONTEXT);
    assert.equal(question.points, 27);
    assert.equal(service.calculatePoints("normal", CONTEXT), 27);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("hierarquia prioriza runtime contextual e mantém fallback da comunidade", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-question-priority-"));
  try {
    const repository = createConfigurationRepository({
      databaseDir: path.join(root, "database"),
      backupRoot: path.join(root, "backups")
    });
    const configuration = createConfigurationService();
    configuration.attachRepository(repository);
    await configuration.initialize();
    await configuration.setPersistent("quiz.scoring.hardPoints", 25, {
      communityId: CONTEXT.communityId
    });
    await configuration.setPersistent("quiz.scoring.hardPoints", 30, CONTEXT);
    configuration.set("quiz.scoring.hardPoints", 40, CONTEXT);
    const service = createQuizQuestionService({ configurationService: configuration });
    assert.equal(service.calculatePoints("hard", CONTEXT), 40);
    assert.equal(service.calculatePoints("hard", {
      ...CONTEXT, groupId: "other"
    }), 25);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("janela recente configurada participa da seleção", () => {
  const eligible = Array.from({ length: 8 }, (_, index) => ({
    numero: index + 1, nome: `Pokemon ${index + 1}`,
    tipo: ["normal"], fraquezas: ["fighting"]
  }));
  const pokemonDataService = {
    getEligiblePokemon: () => eligible,
    isPokemonBlocked: () => false,
    loadDataset: () => ({ generations: [{ generation: 1, min: 1, max: 151 }] })
  };
  const configuration = createConfigurationService();
  configuration.set("quiz.questions.recentPokemonWindow", 2, CONTEXT);
  const service = createQuizQuestionService({
    configurationService: configuration,
    pokemonDataService,
    random: () => 0
  });
  const question = service.generateQuestionByType("pokemon_type", {
    ...CONTEXT,
    recentQuestions: [{ pokemonId: 3 }, { pokemonId: 1 }, { pokemonId: 2 }]
  });
  assert.equal(question.pokemonId, 3);
});

test("opções explícitas legadas mantêm prioridade", () => {
  const configuration = createConfigurationService();
  configuration.set("quiz.scoring.easyPoints", 99);
  const service = createQuizQuestionService({
    configurationService: configuration,
    pointsByDifficulty: { easy: 7 }
  });
  assert.equal(service.calculatePoints("easy"), 7);
  assert.equal(service.calculatePoints("normal"), 15);
});

test("ausência de override usa fallback e getResolved contextual", () => {
  const calls = [];
  const defaults = createConfigurationService();
  const configuration = {
    getResolved(key, context) {
      calls.push({ key, context });
      return defaults.getResolved(key, context);
    }
  };
  const service = createQuizQuestionService({
    configurationService: configuration,
    random: () => 0
  });
  const question = service.generateQuestionByType("pokemon_type", CONTEXT);
  assert.equal(question.points, 15);
  assert.ok(calls.some((call) =>
    call.key === "quiz.questions.recentPokemonWindow" &&
    call.context.groupId === CONTEXT.groupId
  ));
  assert.ok(calls.some((call) => call.key === "quiz.scoring.normalPoints"));
});

test("perguntas, alternativas, seleção e validação permanecem compatíveis", () => {
  const service = createQuizQuestionService({
    configurationService: createConfigurationService(),
    random: () => 0.31
  });
  const question = service.generateQuestionByType(
    "multiple_choice_type",
    { ...CONTEXT, pokemonId: 445 }
  );
  assert.equal(question.options.length, 4);
  assert.equal(service.validateGeneratedQuestion(question).valid, true);
  assert.ok(question.correctOption);
  assert.ok(question.acceptedAnswers.length > 0);
});
