"use strict";

const assert = require("assert");
const test = require("node:test");
const pokemonDataService = require("../src/services/pokemonDataService");
const { createQuizQuestionService, QUESTION_TYPES } = require("../src/services/quizQuestionService");
const { answersMatch, normalizeAnswer } = require("../src/services/quizAnswerNormalizer");

const TYPES = [
  "pokemon_name_by_number", "pokemon_number_by_name", "pokemon_type",
  "pokemon_weakness", "multiple_choice_name_by_number", "multiple_choice_number_by_name", "multiple_choice_type", "multiple_choice_weakness",
  "multiple_choice_5_name_by_number", "multiple_choice_5_number_by_name", "multiple_choice_5_type", "multiple_choice_5_weakness",
  "true_false_type", "true_false_generation", "true_false_number", "true_false_weakness",
  "special_not_type", "special_belongs_type", "special_generation", "special_5_not_type", "special_5_belongs_type", "special_5_generation",
  "open_generation", "open_belongs_type", "open_not_type", "open_single_type", "open_dual_type",
  "special_single_type", "special_dual_type", "special_weakness", "special_not_weakness", "special_not_generation",
  "special_earlier_generation", "special_later_generation", "special_highest_number", "special_lowest_number", "special_before_pokedex", "special_after_pokedex",
  "true_false_dual_type", "true_false_single_type", "open_pokemon_generation"
];

test("declara tipos antigos e novos sem remover compatibilidade", () => {
  const service = createQuizQuestionService({ random: () => 0 });
  assert.deepStrictEqual(service.getAvailableQuestionTypes(), TYPES);
  assert.deepStrictEqual(QUESTION_TYPES, TYPES);
});

test("gera e valida cada tipo de pergunta usando dados elegíveis", () => {
  const service = createQuizQuestionService({ random: () => 0 });
  for (const type of TYPES) {
    const question = service.generateQuestionByType(type);
    assert.strictEqual(question.type, type);
    assert.strictEqual(question.id.startsWith("Q"), true);
    assert.strictEqual(pokemonDataService.isPokemonBlocked(question.pokemonId), false);
    assert.strictEqual(service.validateGeneratedQuestion(question).valid, true);
    if (question.options.length) {
      const expected = type.startsWith("multiple_choice_5") || type.startsWith("special_5") ? 5 : type.startsWith("true_false") ? 2 : 4;
      assert.strictEqual(question.options.length, expected);
      assert.strictEqual(new Set(question.options.map((option) => option.value.toLowerCase())).size, expected);
      assert.strictEqual(question.options.filter((option) => option.key === question.correctOption).length, 1);
    }
  }
});

test("cinco categorias convergem igualmente para 20%", () => {
  let seed = 123456789;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const service = createQuizQuestionService({ random });
  const counts = { multipleChoice4: 0, multipleChoice5: 0, weaknessChoice: 0, trueFalse: 0, open: 0 };
  for (let index = 0; index < 20_000; index += 1) counts[service.selectQuestionCategory()] += 1;
  const ratios = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value / 20_000]));
  assert.ok(Math.abs(ratios.multipleChoice4 - 0.20) < 0.02, ratios.multipleChoice4);
  assert.ok(Math.abs(ratios.multipleChoice5 - 0.20) < 0.02, ratios.multipleChoice5);
  assert.ok(Math.abs(ratios.weaknessChoice - 0.20) < 0.02, ratios.weaknessChoice);
  assert.ok(Math.abs(ratios.trueFalse - 0.20) < 0.02, ratios.trueFalse);
  assert.ok(Math.abs(ratios.open - 0.20) < 0.02, ratios.open);
});

test("embaralhamento muda a posição correta e aceita letra ou conteúdo", () => {
  const first = createQuizQuestionService({ random: () => 0 }).buildMultipleChoiceOptions("Dialga", ["Palkia", "Giratina", "Arceus"], 4);
  const second = createQuizQuestionService({ random: () => 0.999999 }).buildMultipleChoiceOptions("Dialga", ["Palkia", "Giratina", "Arceus"], 4);
  assert.notStrictEqual(first.correctOption, second.correctOption);
  for (const choice of [first, second]) {
    const accepted = [choice.correctOption, "Dialga"];
    assert.equal(answersMatch(choice.correctOption.toLowerCase(), accepted), true);
    assert.equal(answersMatch("dialga", accepted), true);
  }
});

test("resposta correta varia entre A, B, C, D e E", () => {
  let seed = 246813579;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const service = createQuizQuestionService({ random });
  const positions = new Set();
  for (let index = 0; index < 300; index += 1) positions.add(service.buildMultipleChoiceOptions("Correta", ["Um", "Dois", "Três", "Quatro", "Cinco"], 5).correctOption);
  assert.deepStrictEqual([...positions].sort(), ["A", "B", "C", "D", "E"]);
});

test("alternativas de tipo são próximas e evitam opções absurdas", () => {
  const service = createQuizQuestionService({ random: () => 0.31 });
  const question = service.generateQuestionByType("multiple_choice_type", { pokemonId: 445 });
  assert.equal(question.options.length, 4);
  const distractors = question.options.filter((option) => option.key !== question.correctOption).map((option) => option.value);
  assert.ok(distractors.some((value) => /Dragão|Terrestre/i.test(value)), distractors.join(", "));
  assert.equal(answersMatch(question.correctOption.toLowerCase(), question.acceptedAnswers), true);
  assert.equal(answersMatch(question.displayAnswer.toLowerCase(), question.acceptedAnswers), true);
});

test("fraqueza possui exatamente uma alternativa correta", () => {
  const service = createQuizQuestionService({ random: () => 0.42 });
  const question = service.generateQuestionByType("multiple_choice_5_weakness", { pokemonId: 1 });
  const validWeaknesses = new Set(["Fogo", "Gelo", "Voador", "Psíquico"].map(normalizeAnswer));
  const correct = question.options.filter((option) => validWeaknesses.has(normalizeAnswer(option.value)));
  assert.equal(correct.length, 1);
  assert.equal(correct[0].key, question.correctOption);
});

test("verdadeiro/falso e especiais usam apenas dados existentes", () => {
  const service = createQuizQuestionService({ random: () => 0.2 });
  for (const type of ["true_false_type", "true_false_generation", "true_false_number", "true_false_weakness", "special_not_type", "special_belongs_type", "special_generation", "special_5_not_type", "special_5_belongs_type", "special_5_generation"]) {
    const question = service.generateQuestionByType(type);
    assert.equal(service.validateGeneratedQuestion(question).valid, true);
    assert.equal(question.options.some((option) => option.key === question.correctOption), true);
    assert.equal(answersMatch(question.correctOption.toLowerCase(), question.acceptedAnswers), true);
    const correctValue = question.options.find((option) => option.key === question.correctOption).value;
    assert.equal(answersMatch(correctValue.toLowerCase(), question.acceptedAnswers), true);
  }
});

test("verdadeiro e falso permanecem equilibrados", () => {
  let seed = 987654321;
  const random = () => { seed = (1103515245 * seed + 12345) >>> 0; return seed / 0x100000000; };
  const service = createQuizQuestionService({ random });
  const counts = { verdadeiro: 0, falso: 0 };
  for (let index = 0; index < 400; index += 1) {
    const question = service.generateQuestionByType("true_false_type");
    counts[question.displayAnswer.toLowerCase()] += 1;
  }
  assert.ok(Math.abs(counts.verdadeiro / 400 - 0.5) < 0.10, counts);
  assert.ok(Math.abs(counts.falso / 400 - 0.5) < 0.10, counts);
});

test("anti-repetição bloqueia Pokémon 50, resposta 20 e modelo após duas sequências", () => {
  const service = createQuizQuestionService({ random: () => 0 });
  const recentPokemon = Array.from({ length: 50 }, (_, index) => ({ pokemonId: pokemonDataService.getEligiblePokemon("tipo")[index].numero, questionType: index % 2 ? "pokemon_type" : "pokemon_weakness", correctAnswer: `answer-${index}` }));
  const question = service.generateQuestion({ questionType: "pokemon_type", recentQuestions: recentPokemon });
  assert.equal(recentPokemon.some((entry) => entry.pokemonId === question.pokemonId), false);

  const recentAnswers = Array.from({ length: 20 }, (_, index) => ({ pokemonId: 900 - index, questionType: "pokemon_weakness", correctAnswer: index === 19 ? "grass/poison" : `answer-${index}` }));
  const answerQuestion = service.generateQuestion({ questionType: "pokemon_type", recentQuestions: recentAnswers });
  assert.notEqual(normalizeAnswer(answerQuestion.displayAnswer), normalizeAnswer("grass/poison"));

  const selected = service.selectQuestionType([{ questionType: "multiple_choice_type" }, { questionType: "multiple_choice_type" }], "multipleChoice4");
  assert.notEqual(selected, "multiple_choice_type");
});

test("relaxamento gradual evita travamento em conjunto pequeno", () => {
  const tinyPokemon = [
    { numero: 1, nome: "A", tipo: ["Fire"], fraquezas: ["Water"] },
    { numero: 2, nome: "B", tipo: ["Water"], fraquezas: ["Grass"] },
    { numero: 3, nome: "C", tipo: ["Grass"], fraquezas: ["Fire"] },
    { numero: 4, nome: "D", tipo: ["Electric"], fraquezas: ["Ground"] },
    { numero: 5, nome: "E", tipo: ["Ground"], fraquezas: ["Water"] }
  ];
  const data = {
    getEligiblePokemon: () => tinyPokemon,
    isPokemonBlocked: () => false,
    loadDataset: () => ({ generations: [{ generation: 1, min: 1, max: 151 }] })
  };
  const relaxations = [];
  const service = createQuizQuestionService({ pokemonDataService: data, random: () => 0, logInfo: (message) => relaxations.push(message) });
  const recent = tinyPokemon.map((pokemon) => ({ pokemonId: pokemon.numero, questionType: "pokemon_type", correctAnswer: "fire" }));
  const question = service.generateQuestion({ questionType: "pokemon_type", recentQuestions: recent });
  assert.ok(question);
  assert.ok(relaxations.length > 0);
});

test("perguntas abertas cobrem apenas temas estruturados", () => {
  const service = createQuizQuestionService({ random: () => 0.37 });
  for (const type of ["pokemon_name_by_number", "pokemon_number_by_name", "pokemon_type", "pokemon_weakness", "open_generation", "open_belongs_type", "open_not_type", "open_single_type", "open_dual_type"]) {
    const question = service.generateQuestionByType(type);
    assert.equal(service.validateGeneratedQuestion(question).valid, true);
  }
  for (const unsupported of ["evolution", "ability", "move", "mega", "gigantamax", "regional_form", "legendary", "mythical", "fossil", "ultra_beast", "paradox"]) assert.throws(() => service.generateQuestionByType(unsupported), /não suportado/);
});

test("modelos abertos ficam equilibrados internamente", () => {
  let seed = 13579;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x100000000; };
  const service = createQuizQuestionService({ random });
  const counts = Object.fromEntries(["pokemon_name_by_number", "pokemon_number_by_name", "pokemon_type", "pokemon_weakness", "open_generation", "open_belongs_type", "open_not_type", "open_single_type", "open_dual_type", "open_pokemon_generation"].map((type) => [type, 0]));
  for (let index = 0; index < 20_000; index += 1) counts[service.selectQuestionType([], "open")] += 1;
  for (const count of Object.values(counts)) assert.ok(Math.abs(count / 20_000 - 1 / 10) < 0.02, counts);
});

test("pergunta de tipo aceita os dois tipos e fraqueza aceita qualquer valor cadastrado", () => {
  const service = createQuizQuestionService({ random: () => 0 });
  const typeQuestion = service.generateQuestionByType("pokemon_type", { pokemonId: 1 });
  assert.ok(typeQuestion.acceptedAnswers.includes("grass"));
  assert.ok(typeQuestion.acceptedAnswers.includes("poison"));
  const weakness = service.generateQuestionByType("pokemon_weakness", { pokemonId: 1 });
  assert.ok(["fire", "ice", "flying", "psychic"].every((answer) => weakness.acceptedAnswers.includes(answer)));
});

test("recusa Pokémon bloqueado e evita pergunta recente", () => {
  const service = createQuizQuestionService({ random: () => 0 });
  const blocked = pokemonDataService.loadDataset().manifest.blockedPokemonNumbers[0];
  assert.throws(() => service.generateQuestionByType("pokemon_name_by_number", { pokemonId: blocked }), /Nenhum Pokémon elegível/);
  const first = service.generateQuestionByType("pokemon_name_by_number");
  const second = service.generateQuestionByType("pokemon_name_by_number", { recentQuestions: [{ pokemonId: first.pokemonId }] });
  assert.notStrictEqual(second.pokemonId, first.pokemonId);
});

test("dificuldade e pontos são configuráveis e conteúdo ausente falha sem invenção", () => {
  const service = createQuizQuestionService({ random: () => 0, difficultyByType: { pokemon_type: "hard" }, pointsByDifficulty: { hard: 30 } });
  assert.strictEqual(service.calculateDifficulty("pokemon_type"), "hard");
  assert.strictEqual(service.calculatePoints("pokemon_type"), 30);
  assert.throws(() => service.generateQuestionByType("silhouette"), /não suportado/);
  assert.throws(() => service.buildMultipleChoiceOptions("Electric", ["Water", "Water"]), /Dados insuficientes/);
});

test("novos modelos estruturais mantem uma alternativa correta e sem repeticao", () => {
  const service = createQuizQuestionService({ random: () => 0.37 });
  const models = [
    "special_single_type", "special_dual_type", "special_weakness", "special_not_weakness", "special_not_generation",
    "special_earlier_generation", "special_later_generation", "special_highest_number", "special_lowest_number",
    "special_before_pokedex", "special_after_pokedex", "true_false_dual_type", "true_false_single_type"
  ];
  for (const model of models) {
    const question = service.generateQuestionByType(model);
    assert.equal(service.validateGeneratedQuestion(question).valid, true, model);
    assert.equal(question.options.filter((option) => option.key === question.correctOption).length, 1, model);
    assert.equal(new Set(question.options.map((option) => normalizeAnswer(option.value))).size, question.options.length, model);
    const correctText = question.options.find((option) => option.key === question.correctOption).value;
    assert.equal(answersMatch(question.correctOption.toLowerCase(), question.acceptedAnswers), true, model);
    assert.equal(answersMatch(correctText.toLowerCase(), question.acceptedAnswers), true, model);
  }
});

test("comparacoes de Pokedex apontam para o menor ou maior numero", () => {
  const service = createQuizQuestionService({ random: () => 0.43 });
  const numberByName = new Map(pokemonDataService.getEligiblePokemon("numero").map((entry) => [normalizeAnswer(entry.nome), entry.numero]));
  for (const model of ["special_highest_number", "special_after_pokedex", "special_later_generation", "special_lowest_number", "special_before_pokedex", "special_earlier_generation"]) {
    const question = service.generateQuestionByType(model);
    const values = question.options.map((option) => numberByName.get(normalizeAnswer(option.value)));
    const correct = numberByName.get(normalizeAnswer(question.displayAnswer));
    const wantsHighest = /highest|after|later/.test(model);
    assert.equal(correct, wantsHighest ? Math.max(...values) : Math.min(...values), model);
  }
});

test("modelo aberto por geracao aceita Pokemon compativel", () => {
  const service = createQuizQuestionService({ random: () => 0.51 });
  const question = service.generateQuestionByType("open_pokemon_generation");
  assert.match(question.prompt, /Cite um Pokémon da Geração [1-9]/);
  assert.equal(service.validateGeneratedQuestion(question).valid, true);
  assert.equal(answersMatch(question.displayAnswer, question.acceptedAnswers), true);
});
