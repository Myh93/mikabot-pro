"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const locale = require("../src/services/pokemonLocaleService");
const { answersMatch, buildAcceptedAnswers } = require("../src/services/quizAnswerNormalizer");
const { createQuizQuestionService } = require("../src/services/quizQuestionService");
const { createQuizRepository } = require("../src/repositories/quizRepository");
const { createQuizService } = require("../src/services/quizService");
const { createQuizAnswerHandler } = require("../src/events/quizAnswer");
const { HELP } = require("../src/commands/quiz");

const TYPES = {
  normal: "Normal", fire: "Fogo", water: "Água", electric: "Elétrico", grass: "Planta",
  ice: "Gelo", fighting: "Lutador", poison: "Veneno", ground: "Terrestre", flying: "Voador",
  psychic: "Psíquico", bug: "Inseto", rock: "Pedra", ghost: "Fantasma", dragon: "Dragão",
  dark: "Sombrio", steel: "Aço", fairy: "Fada"
};

test("traduz os 18 tipos sem duplicar mapas nos consumidores", () => {
  for (const [english, portuguese] of Object.entries(TYPES)) {
    assert.strictEqual(locale.translateType(english), portuguese);
    assert.strictEqual(locale.translateWeakness(english), portuguese);
    assert.strictEqual(locale.normalizeLocalizedAnswer(english), english);
    assert.strictEqual(locale.normalizeLocalizedAnswer(portuguese), english);
  }
});

test("aceita português, inglês e português sem acento", () => {
  for (const [input, canonical] of [
    ["Elétrico", "electric"], ["eletrico", "electric"], ["Electric", "electric"],
    ["Dragão", "dragon"], ["dragao", "dragon"], ["Psychic", "psychic"],
    ["psiquico", "psychic"], ["AÇO", "steel"], ["aco", "steel"]
  ]) assert.strictEqual(locale.normalizeLocalizedAnswer(input), canonical);
});

test("tipos duplos aceitam qualquer ordem e todos os separadores", () => {
  const accepted = locale.buildAcceptedLocalizedAnswers(["Dark", "Dragon"], { combine: true });
  for (const answer of [
    "Sombrio/Dragão", "Dragão/Sombrio", "Dark/Dragon", "Dragon/Dark",
    "Sombrio - Dragão", "Dark-Dragon", "Sombrio, Dragão", "Sombrio e Dragão", "Dragon and Dark"
  ]) assert.strictEqual(answersMatch(answer, accepted), true, answer);
  for (const answer of ["Sombrio", "Dark", "Dragão", "Dragon"]) assert.strictEqual(answersMatch(answer, accepted), true, answer);
  assert.strictEqual(locale.formatDualType(["Dark", "Dragon"]), "Sombrio/Dragão");
});

test("fraquezas aceitam os dois idiomas sem aproximação", () => {
  const accepted = locale.buildAcceptedLocalizedAnswers(["Water", "Ground", "Psychic", "Steel"]);
  for (const answer of ["Água", "Water", "Terrestre", "Ground", "Psíquico", "Psychic", "AÇO", "Steel"]) {
    assert.strictEqual(answersMatch(answer, accepted), true);
  }
  assert.strictEqual(answersMatch("Agu", accepted), false);
  assert.strictEqual(answersMatch("Psych", accepted), false);
});

test("dificuldades são exibidas em português", () => {
  assert.strictEqual(locale.translateDifficulty("easy"), "Fácil");
  assert.strictEqual(locale.translateDifficulty("normal"), "Normal");
  assert.strictEqual(locale.translateDifficulty("hard"), "Difícil");
});

test("nomes de Pokémon e aliases declarados são preservados", () => {
  for (const name of ["Bulbasaur", "Mr. Mime", "Type: Null", "Ho-Oh"]) assert.strictEqual(locale.translateAnswer(name), name);
  const accepted = buildAcceptedAnswers("Mr. Mime", ["Mime"]);
  assert.strictEqual(answersMatch("Mr Mime", accepted), true);
  assert.strictEqual(answersMatch("Mime", accepted), true);
  assert.strictEqual(answersMatch("Mim", accepted), false);
});

test("question service exibe tipos, alternativas e dificuldades localizados", () => {
  const questions = createQuizQuestionService({ random: () => 0 });
  const direct = questions.generateQuestionByType("pokemon_type", { pokemonId: 1 });
  assert.strictEqual(direct.displayAnswer, "Planta/Veneno");
  assert.strictEqual(direct.difficultyLabel, "Normal");
  assert.strictEqual(answersMatch("Grass", direct.acceptedAnswers), true);
  assert.strictEqual(answersMatch("Planta", direct.acceptedAnswers), true);
  assert.strictEqual(answersMatch("Veneno e Planta", direct.acceptedAnswers), true);

  const weakness = questions.generateQuestionByType("pokemon_weakness", { pokemonId: 4 });
  assert.strictEqual(weakness.displayAnswer, "Água");
  assert.strictEqual(answersMatch("Water", weakness.acceptedAnswers), true);
  assert.strictEqual(answersMatch("Água", weakness.acceptedAnswers), true);

  const multiple = questions.generateQuestionByType("multiple_choice_type", { pokemonId: 1 });
  assert.ok(multiple.options.every((option) => !/^(Water|Fire|Dark|Dragon)$/i.test(option.value)));
  assert.strictEqual(multiple.difficultyLabel, "Difícil");
});

test("integração completa aceita PT/EN e revela resposta final em PT-BR", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-locale-integration-"));
  const repository = createQuizRepository({ databaseDir: path.join(root, "quiz"), backupRoot: path.join(root, "backups") });
  const questionService = createQuizQuestionService({ random: () => 0 });
  let current = new Date();
  const service = createQuizService({ repository, questionService, clock: () => new Date(current), roundDurationMs: 60_000 });
  const handler = createQuizAnswerHandler({ quizService: service, quizRepository: repository });
  const replies = [];
  const context = { platform: "whatsapp", groupId: "group@g.us", userId: "user", replyText: async (text) => replies.push(text) };

  await service.startCollectiveRound(context, { questionType: "pokemon_type", pokemonId: 1 });
  assert.strictEqual((await handler.handleQuizAnswer({ context, text: "Poison" })).status, "correct");
  assert.match(replies[0], /Resposta: Planta\/Veneno/);

  await service.startCollectiveRound(context, { questionType: "pokemon_weakness", pokemonId: 4, roundId: "second", durationMs: -1 });
  const expired = await handler.handleQuizAnswer({ context, text: "qualquer" });
  assert.strictEqual(expired.status, "expired");
  assert.match(replies[1], /Resposta correta: Água/);
  assert.doesNotMatch(replies[1], /water/i);
});

test("ajuda informa suporte simultâneo a português e inglês", () => {
  assert.match(HELP, /Você pode responder em português ou inglês/);
  assert.match(HELP, /Sombrio ou Dark/);
  assert.match(HELP, /Água ou Water/);
  assert.match(HELP, /Dragão ou Dragon/);
  assert.match(HELP, /Fogo ou Fire/);
});
