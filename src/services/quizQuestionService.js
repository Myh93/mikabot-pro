"use strict";

const crypto = require("crypto");
const defaultPokemonDataService = require("./pokemonDataService");
const { buildAcceptedAnswers, normalizeAnswer } = require("./quizAnswerNormalizer");
const localeService = require("./pokemonLocaleService");
const configurationServiceDefault = require("./configurationService");

const QUESTION_TYPES = [
  "pokemon_name_by_number",
  "pokemon_number_by_name",
  "pokemon_type",
  "pokemon_weakness",
  "multiple_choice_name_by_number",
  "multiple_choice_number_by_name",
  "multiple_choice_type",
  "multiple_choice_weakness",
  "multiple_choice_5_name_by_number",
  "multiple_choice_5_number_by_name",
  "multiple_choice_5_type",
  "multiple_choice_5_weakness",
  "true_false_type",
  "true_false_generation",
  "true_false_number",
  "true_false_weakness",
  "special_not_type",
  "special_belongs_type",
  "special_generation",
  "special_5_not_type",
  "special_5_belongs_type",
  "special_5_generation",
  "open_generation",
  "open_belongs_type",
  "open_not_type",
  "open_single_type",
  "open_dual_type",
  "special_single_type",
  "special_dual_type",
  "special_weakness",
  "special_not_weakness",
  "special_not_generation",
  "special_earlier_generation",
  "special_later_generation",
  "special_highest_number",
  "special_lowest_number",
  "special_before_pokedex",
  "special_after_pokedex",
  "true_false_dual_type",
  "true_false_single_type",
  "open_pokemon_generation"
];

const QUESTION_DISTRIBUTION = Object.freeze({ multipleChoice4: 0.20, multipleChoice5: 0.20, weaknessChoice: 0.20, trueFalse: 0.20, open: 0.20 });
const CATEGORY_TYPES = Object.freeze({
  multipleChoice4: ["multiple_choice_name_by_number", "multiple_choice_number_by_name", "multiple_choice_type", "special_belongs_type", "special_not_type", "special_generation", "special_single_type", "special_dual_type", "special_not_generation", "special_earlier_generation", "special_later_generation", "special_highest_number", "special_lowest_number", "special_before_pokedex", "special_after_pokedex"],
  multipleChoice5: ["multiple_choice_5_name_by_number", "multiple_choice_5_number_by_name", "multiple_choice_5_type", "special_5_belongs_type", "special_5_not_type", "special_5_generation"],
  weaknessChoice: ["multiple_choice_weakness", "multiple_choice_5_weakness", "special_weakness", "special_not_weakness"],
  trueFalse: ["true_false_type", "true_false_generation", "true_false_number", "true_false_weakness", "true_false_dual_type", "true_false_single_type"],
  open: ["pokemon_name_by_number", "pokemon_number_by_name", "pokemon_type", "pokemon_weakness", "open_generation", "open_belongs_type", "open_not_type", "open_single_type", "open_dual_type", "open_pokemon_generation"]
});

const ELIGIBILITY_TYPE = {
  pokemon_name_by_number: "numero",
  pokemon_number_by_name: "numero",
  pokemon_type: "tipo",
  pokemon_weakness: "fraqueza",
  multiple_choice_name_by_number: "multipla_escolha",
  multiple_choice_number_by_name: "numero",
  multiple_choice_type: "tipo",
  multiple_choice_weakness: "fraqueza",
  multiple_choice_5_name_by_number: "multipla_escolha",
  multiple_choice_5_number_by_name: "numero",
  multiple_choice_5_type: "tipo",
  multiple_choice_5_weakness: "fraqueza",
  true_false_type: "tipo",
  true_false_generation: "numero",
  true_false_number: "numero",
  true_false_weakness: "fraqueza",
  special_not_type: "tipo",
  special_belongs_type: "tipo",
  special_generation: "numero",
  special_5_not_type: "tipo",
  special_5_belongs_type: "tipo",
  special_5_generation: "numero",
  open_generation: "numero",
  open_belongs_type: "tipo",
  open_not_type: "tipo",
  open_single_type: "tipo",
  open_dual_type: "tipo",
  special_single_type: "tipo", special_dual_type: "tipo",
  special_weakness: "fraqueza", special_not_weakness: "fraqueza",
  special_not_generation: "numero", special_earlier_generation: "numero", special_later_generation: "numero",
  special_highest_number: "numero", special_lowest_number: "numero", special_before_pokedex: "numero", special_after_pokedex: "numero",
  true_false_dual_type: "tipo", true_false_single_type: "tipo", open_pokemon_generation: "numero"
};

const DEFAULT_DIFFICULTY = {
  pokemon_name_by_number: "easy",
  pokemon_number_by_name: "easy",
  pokemon_type: "normal",
  pokemon_weakness: "hard",
  multiple_choice_name_by_number: "hard",
  multiple_choice_number_by_name: "hard",
  multiple_choice_type: "hard",
  multiple_choice_weakness: "hard",
  multiple_choice_5_name_by_number: "hard",
  multiple_choice_5_number_by_name: "hard",
  multiple_choice_5_type: "hard",
  multiple_choice_5_weakness: "hard",
  true_false_type: "normal",
  true_false_generation: "normal",
  true_false_number: "normal",
  true_false_weakness: "normal",
  special_not_type: "hard",
  special_belongs_type: "hard",
  special_generation: "hard",
  special_5_not_type: "hard",
  special_5_belongs_type: "hard",
  special_5_generation: "hard",
  open_generation: "normal",
  open_belongs_type: "normal",
  open_not_type: "normal",
  open_single_type: "normal",
  open_dual_type: "normal",
  special_single_type: "hard", special_dual_type: "hard",
  special_weakness: "hard", special_not_weakness: "hard",
  special_not_generation: "hard", special_earlier_generation: "hard", special_later_generation: "hard",
  special_highest_number: "hard", special_lowest_number: "hard", special_before_pokedex: "hard", special_after_pokedex: "hard",
  true_false_dual_type: "normal", true_false_single_type: "normal", open_pokemon_generation: "normal"
};

const DEFAULT_POINTS = { easy: 10, normal: 15, hard: 20 };

function createQuizQuestionService(options = {}) {
  const pokemonDataService = options.pokemonDataService || defaultPokemonDataService;
  const configurationService = options.configurationService || configurationServiceDefault;
  const random = options.random || Math.random;
  const difficultyByType = { ...DEFAULT_DIFFICULTY, ...(options.difficultyByType || {}) };
  const pointsOverrides = { ...(options.pointsByDifficulty || {}) };
  const logInfo = options.logInfo || (() => undefined);
  let availableTypesCache = null;

  function configurationContext(input = {}) {
    const context = input.context || input;
    return {
      communityId: context?.communityId,
      platform: context?.platform,
      groupId: context?.groupId
    };
  }

  function configured(key, input = {}) {
    return configurationService.getResolved(key, configurationContext(input)).value;
  }

  function getAvailableQuestionTypes() {
    if (!availableTypesCache) availableTypesCache = QUESTION_TYPES.filter((type) => pokemonDataService.getEligiblePokemon(ELIGIBILITY_TYPE[type]).length > 0);
    return [...availableTypesCache];
  }

  function calculateDifficulty(questionType) {
    if (!QUESTION_TYPES.includes(questionType)) throw new Error(`Tipo de pergunta não suportado: ${questionType}.`);
    return difficultyByType[questionType];
  }

  function calculatePoints(difficultyOrType, context = {}) {
    const difficulty = QUESTION_TYPES.includes(difficultyOrType) ? calculateDifficulty(difficultyOrType) : difficultyOrType;
    const points = Object.prototype.hasOwnProperty.call(pointsOverrides, difficulty)
      ? pointsOverrides[difficulty]
      : configured(`quiz.scoring.${difficulty}Points`, context);
    if (!Number.isFinite(points)) throw new Error(`Pontuação não configurada para dificuldade ${difficulty}.`);
    return points;
  }

  function generationFor(number) {
    const dataset = pokemonDataService.loadDataset();
    return dataset.generations.find((entry) => number >= entry.min && number <= entry.max)?.generation || null;
  }

  function choose(items) {
    if (!items.length) return null;
    const value = Number(random());
    const index = Math.min(items.length - 1, Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * items.length)));
    return items[index];
  }

  function shuffled(items) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const target = Math.min(index, Math.max(0, Math.floor(Number(random()) * (index + 1))));
      [result[index], result[target]] = [result[target], result[index]];
    }
    return result;
  }

  function selectQuestionCategory(context = {}) {
    const distribution = {
      ...QUESTION_DISTRIBUTION,
      ...(configured("quiz.questions.distribution", context) || {})
    };
    const categories = Object.keys(QUESTION_DISTRIBUTION);
    const total = categories.reduce(
      (sum, category) => sum + Math.max(0, Number(distribution[category]) || 0),
      0
    ) || 1;
    const value = Number(random());
    const roll = (Number.isFinite(value) ? Math.min(0.999999, Math.max(0, value)) : 0) * total;
    let cumulative = 0;
    for (const category of categories) {
      cumulative += Math.max(0, Number(distribution[category]) || 0);
      if (roll < cumulative) return category;
    }
    return categories[categories.length - 1];
  }

  function selectQuestionType(recentQuestions = [], selectedCategory = null, context = {}) {
    const category = selectedCategory || selectQuestionCategory(context);
    const available = new Set(getAvailableQuestionTypes());
    let candidates = CATEGORY_TYPES[category].filter((type) => available.has(type));
    const recentModels = recentQuestions.slice(-2).map((entry) => entry.questionType).filter(Boolean);
    if (recentModels.length === 2 && recentModels[0] === recentModels[1]) {
      const alternatives = candidates.filter((type) => type !== recentModels[0]);
      if (alternatives.length) candidates = alternatives;
    }
    return choose(candidates.length ? shuffled(candidates) : shuffled([...available]));
  }

  function typeLabel(pokemon) {
    return pokemon.tipo.join(" / ");
  }

  function typeSimilarity(left, right) {
    const expected = new Set(left.tipo.map(normalizeAnswer));
    return right.tipo.reduce((score, type) => score + (expected.has(normalizeAnswer(type)) ? 1 : 0), 0);
  }

  function intelligentNameCandidates(pokemon, eligible) {
    const generation = generationFor(pokemon.numero);
    return eligible.filter((entry) => entry.numero !== pokemon.numero).sort((left, right) => {
      const leftGeneration = generationFor(left.numero) === generation ? 0 : 1;
      const rightGeneration = generationFor(right.numero) === generation ? 0 : 1;
      return leftGeneration - rightGeneration || Math.abs(left.numero - pokemon.numero) - Math.abs(right.numero - pokemon.numero);
    }).map((entry) => entry.nome);
  }

  function intelligentTypeCandidates(pokemon) {
    return pokemonDataService.getEligiblePokemon("tipo")
      .filter((entry) => entry.numero !== pokemon.numero && !pokemonDataService.isPokemonBlocked(entry.numero))
      .sort((left, right) => typeSimilarity(pokemon, right) - typeSimilarity(pokemon, left) || Math.abs(left.numero - pokemon.numero) - Math.abs(right.numero - pokemon.numero))
      .map((entry) => localeService.formatDualType(entry.tipo));
  }

  function buildMultipleChoiceOptions(correctValue, candidates, count = 4) {
    const correctKey = normalizeAnswer(correctValue);
    const unique = new Map();
    for (const candidate of candidates) {
      const value = String(candidate).trim();
      const key = normalizeAnswer(value);
      if (key && key !== correctKey && !unique.has(key)) unique.set(key, value);
    }
    if (unique.size < count - 1) throw new Error("Dados insuficientes para gerar alternativas únicas.");
    const distractors = shuffled([...unique.values()]).slice(0, count - 1);
    const values = shuffled([String(correctValue), ...distractors]);
    const letters = ["A", "B", "C", "D", "E", "F"];
    return {
      options: values.map((value, index) => ({ key: letters[index], value })),
      correctOption: letters[values.findIndex((value) => normalizeAnswer(value) === correctKey)]
    };
  }

  function buildPokemonChoice(correctPokemon, distractors, count = 4) {
    const choice = buildMultipleChoiceOptions(correctPokemon.nome, distractors.map((entry) => entry.nome), count);
    return {
      ...choice,
      acceptedAnswers: buildAcceptedAnswers([correctPokemon.nome, choice.correctOption], correctPokemon.aliases || [])
    };
  }

  function allEligible(kind) {
    return pokemonDataService.getEligiblePokemon(kind).filter((entry) => !pokemonDataService.isPokemonBlocked(entry.numero));
  }

  function eligibleFor(type, recentQuestions = [], pokemonWindow = 50) {
    const blockedRecent = pokemonWindow > 0 ? recentQuestions.slice(-pokemonWindow) : [];
    const recentIds = new Set(blockedRecent.map((entry) => Number(typeof entry === "object" ? entry.pokemonId : entry)));
    return pokemonDataService.getEligiblePokemon(ELIGIBILITY_TYPE[type])
      .filter((pokemon) => !pokemonDataService.isPokemonBlocked(pokemon.numero) && !recentIds.has(pokemon.numero));
  }

  function generateQuestionByType(type, configuration = {}) {
    if (!QUESTION_TYPES.includes(type)) throw new Error(`Tipo de pergunta não suportado: ${type}.`);
    const eligible = eligibleFor(
      type,
      configuration.recentQuestions || [],
      configuration.pokemonWindow === undefined
        ? configured("quiz.questions.recentPokemonWindow", configuration)
        : configuration.pokemonWindow
    );
    const pokemon = configuration.pokemonId === undefined
      ? eligible.length ? eligible[(Math.min(eligible.length - 1, Math.max(0, Math.floor(Number(random()) * eligible.length))) + Number(configuration.selectionOffset || 0)) % eligible.length] : null
      : eligible.find((entry) => entry.numero === Number(configuration.pokemonId));
    if (!pokemon) throw new Error(`Nenhum Pokémon elegível disponível para ${type}.`);

    let prompt;
    let acceptedAnswers;
    let optionsList = [];
    let correctOption = null;
    let displayAnswer;

    switch (type) {
      case "pokemon_name_by_number":
        prompt = `Qual Pokémon possui o número ${pokemon.numero} na Pokédex?`;
        acceptedAnswers = buildAcceptedAnswers(pokemon.nome, pokemon.aliases || []);
        displayAnswer = pokemon.nome;
        break;
      case "pokemon_number_by_name":
        prompt = `Qual é o número da Pokédex do ${pokemon.nome}?`;
        acceptedAnswers = buildAcceptedAnswers([String(pokemon.numero), `#${pokemon.numero}`]);
        displayAnswer = String(pokemon.numero);
        break;
      case "pokemon_type": {
        prompt = `Qual é o tipo do ${pokemon.nome}?`;
        acceptedAnswers = localeService.buildAcceptedLocalizedAnswers(pokemon.tipo, { combine: true, allowIndividual: true });
        displayAnswer = localeService.formatDualType(pokemon.tipo);
        break;
      }
      case "pokemon_weakness":
        prompt = `Cite uma fraqueza do ${pokemon.nome}.`;
        acceptedAnswers = localeService.buildAcceptedLocalizedAnswers(pokemon.fraquezas);
        displayAnswer = localeService.translateWeakness(pokemon.fraquezas[0]);
        break;
      case "multiple_choice_name_by_number":
      case "multiple_choice_5_name_by_number": {
        prompt = `Qual Pokémon possui o número ${pokemon.numero}?`;
        const count = type === "multiple_choice_5_name_by_number" ? 5 : 4;
        const choice = buildMultipleChoiceOptions(pokemon.nome, intelligentNameCandidates(pokemon, eligible), count);
        optionsList = choice.options;
        correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers([pokemon.nome, correctOption], pokemon.aliases || []);
        displayAnswer = pokemon.nome;
        break;
      }
      case "multiple_choice_number_by_name":
      case "multiple_choice_5_number_by_name": {
        const count = type === "multiple_choice_5_number_by_name" ? 5 : 4;
        const generation = generationFor(pokemon.numero);
        const nearbyNumbers = pokemonDataService.getEligiblePokemon("numero")
          .filter((entry) => entry.numero !== pokemon.numero && !pokemonDataService.isPokemonBlocked(entry.numero))
          .sort((left, right) => (generationFor(left.numero) === generation ? 0 : 1) - (generationFor(right.numero) === generation ? 0 : 1) || Math.abs(left.numero - pokemon.numero) - Math.abs(right.numero - pokemon.numero))
          .map((entry) => String(entry.numero));
        const choice = buildMultipleChoiceOptions(String(pokemon.numero), nearbyNumbers, count);
        prompt = `Qual é o número da Pokédex do ${pokemon.nome}?`;
        optionsList = choice.options;
        correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers([String(pokemon.numero), `#${pokemon.numero}`, correctOption]);
        displayAnswer = String(pokemon.numero);
        break;
      }
      case "multiple_choice_type":
      case "multiple_choice_5_type": {
        prompt = `Qual é o tipo do ${pokemon.nome}?`;
        const correctType = localeService.formatDualType(pokemon.tipo);
        const count = type === "multiple_choice_5_type" ? 5 : 4;
        const choice = buildMultipleChoiceOptions(correctType, intelligentTypeCandidates(pokemon), count);
        optionsList = choice.options;
        correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers([correctType, correctOption]);
        displayAnswer = correctType;
        break;
      }
      case "multiple_choice_weakness":
      case "multiple_choice_5_weakness": {
        const correctWeakness = localeService.translateWeakness(choose(pokemon.fraquezas));
        const count = type === "multiple_choice_5_weakness" ? 5 : 4;
        const allWeaknesses = pokemonDataService.getEligiblePokemon("fraqueza").flatMap((entry) => entry.fraquezas).map((weakness) => localeService.translateWeakness(weakness));
        const choice = buildMultipleChoiceOptions(correctWeakness, allWeaknesses.filter((value) => !pokemon.fraquezas.some((weakness) => normalizeAnswer(localeService.translateWeakness(weakness)) === normalizeAnswer(value))), count);
        prompt = `Qual destas é uma fraqueza do ${pokemon.nome}?`;
        optionsList = choice.options;
        correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers([correctWeakness, correctOption]);
        displayAnswer = correctWeakness;
        break;
      }
      case "true_false_type": {
        const truthful = Number(random()) < 0.5;
        const correctType = localeService.formatDualType(pokemon.tipo);
        const falseType = truthful ? null : intelligentTypeCandidates(pokemon).find((candidate) => normalizeAnswer(candidate) !== normalizeAnswer(correctType));
        const statedType = truthful ? correctType : falseType;
        prompt = `Verdadeiro ou falso: ${pokemon.nome} é do tipo ${statedType}.`;
        const choice = buildMultipleChoiceOptions(truthful ? "Verdadeiro" : "Falso", [truthful ? "Falso" : "Verdadeiro"], 2);
        optionsList = choice.options;
        correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers(truthful ? ["Verdadeiro", "True", correctOption] : ["Falso", "False", correctOption]);
        displayAnswer = truthful ? "Verdadeiro" : "Falso";
        break;
      }
      case "true_false_generation": {
        const actual = generationFor(pokemon.numero);
        const truthful = Number(random()) < 0.5;
        const stated = truthful ? actual : Math.min(9, actual === 9 ? 8 : actual + 1);
        prompt = `Verdadeiro ou falso: ${pokemon.nome} pertence à Geração ${stated}.`;
        const choice = buildMultipleChoiceOptions(truthful ? "Verdadeiro" : "Falso", [truthful ? "Falso" : "Verdadeiro"], 2);
        optionsList = choice.options; correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers(truthful ? ["Verdadeiro", "True", correctOption] : ["Falso", "False", correctOption]);
        displayAnswer = truthful ? "Verdadeiro" : "Falso";
        break;
      }
      case "true_false_number": {
        const truthful = Number(random()) < 0.5;
        const nearby = pokemonDataService.getEligiblePokemon("numero").filter((entry) => entry.numero !== pokemon.numero).sort((left, right) => Math.abs(left.numero - pokemon.numero) - Math.abs(right.numero - pokemon.numero));
        const stated = truthful ? pokemon.numero : choose(nearby).numero;
        prompt = `Verdadeiro ou falso: ${pokemon.nome} possui o número ${stated} na Pokédex.`;
        const choice = buildMultipleChoiceOptions(truthful ? "Verdadeiro" : "Falso", [truthful ? "Falso" : "Verdadeiro"], 2);
        optionsList = choice.options; correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers(truthful ? ["Verdadeiro", "True", correctOption] : ["Falso", "False", correctOption]);
        displayAnswer = truthful ? "Verdadeiro" : "Falso";
        break;
      }
      case "true_false_weakness": {
        const truthful = Number(random()) < 0.5;
        const valid = pokemon.fraquezas.map((value) => localeService.translateWeakness(value));
        const all = pokemonDataService.getEligiblePokemon("fraqueza").flatMap((entry) => entry.fraquezas).map((value) => localeService.translateWeakness(value));
        const stated = truthful ? choose(valid) : choose(all.filter((value) => !valid.some((weakness) => normalizeAnswer(weakness) === normalizeAnswer(value))));
        prompt = `Verdadeiro ou falso: ${stated} é uma fraqueza do ${pokemon.nome}.`;
        const choice = buildMultipleChoiceOptions(truthful ? "Verdadeiro" : "Falso", [truthful ? "Falso" : "Verdadeiro"], 2);
        optionsList = choice.options; correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers(truthful ? ["Verdadeiro", "True", correctOption] : ["Falso", "False", correctOption]);
        displayAnswer = truthful ? "Verdadeiro" : "Falso";
        break;
      }
      case "true_false_dual_type":
      case "true_false_single_type": {
        const isDual = pokemon.tipo.length === 2;
        const statementIsDual = type === "true_false_dual_type";
        const truthful = statementIsDual === isDual;
        prompt = `Verdadeiro ou falso: ${pokemon.nome} possui ${statementIsDual ? "dupla tipagem" : "apenas um tipo"}.`;
        const correct = truthful ? "Verdadeiro" : "Falso";
        const choice = buildMultipleChoiceOptions(correct, [truthful ? "Falso" : "Verdadeiro"], 2);
        optionsList = choice.options; correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers(truthful ? ["Verdadeiro", "True", correctOption] : ["Falso", "False", correctOption]);
        displayAnswer = correct;
        break;
      }
      case "special_not_type":
      case "special_5_not_type": {
        const all = pokemonDataService.getEligiblePokemon("tipo").filter((entry) => !pokemonDataService.isPokemonBlocked(entry.numero));
        const targetType = choose(pokemon.tipo);
        const belonging = all.filter((entry) => entry.numero !== pokemon.numero && entry.tipo.some((value) => normalizeAnswer(value) === normalizeAnswer(targetType)));
        const outsider = choose(all.filter((entry) => entry.tipo.every((value) => normalizeAnswer(value) !== normalizeAnswer(targetType))));
        const count = type === "special_5_not_type" ? 5 : 4;
        if (belonging.length < count - 1 || !outsider) throw new Error("Dados insuficientes para pergunta especial de tipo.");
        prompt = `Qual destes Pokémon NÃO é do tipo ${localeService.translateType(targetType)}?`;
        const choice = buildMultipleChoiceOptions(outsider.nome, shuffled(belonging).slice(0, count - 1).map((entry) => entry.nome), count);
        optionsList = choice.options;
        correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers([outsider.nome, correctOption], outsider.aliases || []);
        displayAnswer = outsider.nome;
        break;
      }
      case "special_belongs_type":
      case "special_5_belongs_type": {
        const all = pokemonDataService.getEligiblePokemon("tipo").filter((entry) => !pokemonDataService.isPokemonBlocked(entry.numero));
        const targetType = choose(pokemon.tipo);
        const outsiders = all.filter((entry) => entry.tipo.every((value) => normalizeAnswer(value) !== normalizeAnswer(targetType)));
        const count = type === "special_5_belongs_type" ? 5 : 4;
        prompt = `Qual destes Pokémon pertence ao tipo ${localeService.translateType(targetType)}?`;
        const choice = buildMultipleChoiceOptions(pokemon.nome, intelligentNameCandidates(pokemon, outsiders), count);
        optionsList = choice.options;
        correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers([pokemon.nome, correctOption], pokemon.aliases || []);
        displayAnswer = pokemon.nome;
        break;
      }
      case "special_generation":
      case "special_5_generation": {
        const generation = generationFor(pokemon.numero);
        const all = pokemonDataService.getEligiblePokemon("numero").filter((entry) => !pokemonDataService.isPokemonBlocked(entry.numero));
        const outsiders = all.filter((entry) => generationFor(entry.numero) !== generation);
        prompt = `Qual destes Pokémon pertence à Geração ${generation}?`;
        const choice = buildMultipleChoiceOptions(pokemon.nome, intelligentNameCandidates(pokemon, outsiders), type === "special_5_generation" ? 5 : 4);
        optionsList = choice.options;
        correctOption = choice.correctOption;
        acceptedAnswers = buildAcceptedAnswers([pokemon.nome, correctOption], pokemon.aliases || []);
        displayAnswer = pokemon.nome;
        break;
      }
      case "special_single_type":
      case "special_dual_type": {
        const all = allEligible("tipo");
        const wantsDual = type === "special_dual_type";
        const matches = all.filter((entry) => (entry.tipo.length === 2) === wantsDual);
        const outsiders = all.filter((entry) => (entry.tipo.length === 2) !== wantsDual);
        const answerPokemon = matches.find((entry) => entry.numero === pokemon.numero) || choose(matches);
        const choice = buildPokemonChoice(answerPokemon, outsiders, 4);
        prompt = wantsDual ? "Qual destes Pokémon possui dupla tipagem?" : "Qual destes Pokémon possui apenas um tipo?";
        optionsList = choice.options; correctOption = choice.correctOption; acceptedAnswers = choice.acceptedAnswers; displayAnswer = answerPokemon.nome;
        break;
      }
      case "special_weakness":
      case "special_not_weakness": {
        const all = allEligible("fraqueza");
        const targetWeakness = choose(pokemon.fraquezas);
        const hasWeakness = (entry) => entry.fraquezas.some((value) => normalizeAnswer(value) === normalizeAnswer(targetWeakness));
        const matches = all.filter(hasWeakness);
        const outsiders = all.filter((entry) => !hasWeakness(entry));
        const negative = type === "special_not_weakness";
        const answerPokemon = negative ? choose(outsiders) : (matches.find((entry) => entry.numero === pokemon.numero) || choose(matches));
        const distractors = negative ? matches : outsiders;
        const nearby = distractors.sort((left, right) => Math.abs(left.numero - answerPokemon.numero) - Math.abs(right.numero - answerPokemon.numero));
        const choice = buildPokemonChoice(answerPokemon, nearby, 4);
        const weakness = localeService.translateWeakness(targetWeakness);
        prompt = negative ? `Qual destes Pokémon NÃO possui fraqueza para ${weakness}?` : `Qual destes Pokémon recebe dano super efetivo de ${weakness}?`;
        optionsList = choice.options; correctOption = choice.correctOption; acceptedAnswers = choice.acceptedAnswers; displayAnswer = answerPokemon.nome;
        break;
      }
      case "special_not_generation": {
        const generation = generationFor(pokemon.numero);
        const all = allEligible("numero");
        const same = all.filter((entry) => entry.numero !== pokemon.numero && generationFor(entry.numero) === generation);
        const outsider = choose(all.filter((entry) => generationFor(entry.numero) !== generation));
        const choice = buildPokemonChoice(outsider, same, 4);
        prompt = `Qual destes Pokémon NÃO pertence à Geração ${generation}?`;
        optionsList = choice.options; correctOption = choice.correctOption; acceptedAnswers = choice.acceptedAnswers; displayAnswer = outsider.nome;
        break;
      }
      case "special_earlier_generation":
      case "special_later_generation":
      case "special_highest_number":
      case "special_lowest_number":
      case "special_before_pokedex":
      case "special_after_pokedex": {
        const all = allEligible("numero");
        const candidates = shuffled(all.filter((entry) => entry.numero !== pokemon.numero && generationFor(entry.numero) !== generationFor(pokemon.numero))).slice(0, 3);
        const set = [pokemon, ...candidates];
        const wantsHighest = ["special_later_generation", "special_highest_number", "special_after_pokedex"].includes(type);
        const sorted = [...set].sort((left, right) => left.numero - right.numero);
        const answerPokemon = wantsHighest ? sorted[sorted.length - 1] : sorted[0];
        const choice = buildPokemonChoice(answerPokemon, set.filter((entry) => entry.numero !== answerPokemon.numero), 4);
        const prompts = {
          special_earlier_generation: "Qual destes Pokémon foi introduzido antes?",
          special_later_generation: "Qual destes Pokémon foi introduzido depois?",
          special_highest_number: "Qual destes possui o maior número na Pokédex?",
          special_lowest_number: "Qual destes possui o menor número na Pokédex?",
          special_before_pokedex: "Qual destes vem antes na Pokédex?",
          special_after_pokedex: "Qual destes vem depois na Pokédex?"
        };
        prompt = prompts[type]; optionsList = choice.options; correctOption = choice.correctOption; acceptedAnswers = choice.acceptedAnswers; displayAnswer = answerPokemon.nome;
        break;
      }
      case "open_generation": {
        const generation = generationFor(pokemon.numero);
        prompt = `A qual geração pertence ${pokemon.nome}?`;
        acceptedAnswers = buildAcceptedAnswers([String(generation), `Geração ${generation}`, `Gen ${generation}`]);
        displayAnswer = String(generation);
        break;
      }
      case "open_belongs_type":
      case "open_not_type": {
        const targetType = choose(pokemon.tipo);
        const all = pokemonDataService.getEligiblePokemon("tipo").filter((entry) => !pokemonDataService.isPokemonBlocked(entry.numero));
        const matches = type === "open_belongs_type"
          ? all.filter((entry) => entry.tipo.some((value) => normalizeAnswer(value) === normalizeAnswer(targetType)))
          : all.filter((entry) => entry.tipo.every((value) => normalizeAnswer(value) !== normalizeAnswer(targetType)));
        const answerPokemon = choose(matches);
        prompt = type === "open_belongs_type" ? `Cite um Pokémon do tipo ${localeService.translateType(targetType)}.` : `Cite um Pokémon que NÃO seja do tipo ${localeService.translateType(targetType)}.`;
        acceptedAnswers = buildAcceptedAnswers(matches.flatMap((entry) => [entry.nome, ...(entry.aliases || [])]));
        displayAnswer = answerPokemon.nome;
        break;
      }
      case "open_single_type":
      case "open_dual_type": {
        const all = pokemonDataService.getEligiblePokemon("tipo").filter((entry) => !pokemonDataService.isPokemonBlocked(entry.numero));
        const matches = all.filter((entry) => type === "open_single_type" ? entry.tipo.length === 1 : entry.tipo.length === 2);
        const answerPokemon = choose(matches);
        prompt = type === "open_single_type" ? "Cite um Pokémon que possua apenas um tipo." : "Cite um Pokémon que possua dupla tipagem.";
        acceptedAnswers = buildAcceptedAnswers(matches.flatMap((entry) => [entry.nome, ...(entry.aliases || [])]));
        displayAnswer = answerPokemon.nome;
        break;
      }
      case "open_pokemon_generation": {
        const generation = generationFor(pokemon.numero);
        const matches = allEligible("numero").filter((entry) => generationFor(entry.numero) === generation);
        const answerPokemon = choose(matches);
        prompt = `Cite um Pokémon da Geração ${generation}.`;
        acceptedAnswers = buildAcceptedAnswers(matches.flatMap((entry) => [entry.nome, ...(entry.aliases || [])]));
        displayAnswer = answerPokemon.nome;
        break;
      }
      default:
        throw new Error(`Tipo de pergunta não implementado: ${type}.`);
    }

    const difficulty = calculateDifficulty(type);
    const question = {
      id: `Q${crypto.randomUUID().replace(/-/g, "").toUpperCase()}`,
      type,
      pokemonId: pokemon.numero,
      prompt,
      acceptedAnswers,
      options: optionsList,
      correctOption,
      displayAnswer,
      difficulty,
      points: calculatePoints(difficulty, configuration),
      metadata: { generation: generationFor(pokemon.numero) }
    };
    const validation = validateGeneratedQuestion(question);
    if (!validation.valid) throw new Error(`Pergunta gerada inválida: ${validation.errors.join(" ")}`);
    return localeService.translateQuestion(question);
  }

  function generateQuestion(configuration = {}) {
    const recentQuestions = configuration.recentQuestions || [];
    const configuredPokemonWindow = configured(
      "quiz.questions.recentPokemonWindow",
      configuration
    );
    let lastError = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const relaxationStep = Math.max(1, Math.ceil(configuredPokemonWindow / 5));
      const pokemonWindow = Math.max(
        0,
        configuredPokemonWindow - Math.floor(attempt / 10) * relaxationStep
      );
      const answerWindow = Math.max(0, 20 - Math.floor(attempt / 10) * 4);
      const type = configuration.questionType ||
        selectQuestionType(recentQuestions, null, configuration);
      if (!type) throw new Error("Nenhum tipo de pergunta possui dados suficientes.");
      try {
        const question = generateQuestionByType(type, { ...configuration, recentQuestions, pokemonWindow, selectionOffset: attempt });
        const recentAnswerEntries = answerWindow > 0 ? recentQuestions.slice(-answerWindow) : [];
        const recentAnswers = new Set(recentAnswerEntries.map((entry) => normalizeAnswer(entry.correctAnswer)).filter(Boolean));
        if (answerWindow && recentAnswers.has(normalizeAnswer(question.displayAnswer))) continue;
        if (attempt >= 10) logInfo(`[Quiz] Histórico recente relaxado: pokemon=${pokemonWindow}, resposta=${answerWindow}.`);
        return question;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Não foi possível gerar pergunta com os dados disponíveis.");
  }

  function validateGeneratedQuestion(question) {
    const errors = [];
    if (!question || !QUESTION_TYPES.includes(question.type)) errors.push("Tipo inválido.");
    if (!question?.id?.startsWith("Q")) errors.push("ID inválido.");
    if (!Number.isInteger(question?.pokemonId)) errors.push("pokemonId inválido.");
    if (question && pokemonDataService.isPokemonBlocked(question.pokemonId)) errors.push("Pokémon bloqueado.");
    if (!question?.prompt || !Array.isArray(question.acceptedAnswers) || !question.acceptedAnswers.length) errors.push("Prompt ou respostas ausentes.");
    if (!Number.isFinite(question?.points) || !question?.difficulty) errors.push("Dificuldade ou pontos inválidos.");
    if (question?.correctOption !== null) {
      const keys = question.options.map((option) => option.key);
      const values = question.options.map((option) => normalizeAnswer(option.value));
      if (new Set(keys).size !== keys.length || new Set(values).size !== values.length) errors.push("Alternativas duplicadas.");
      if (keys.filter((key) => key === question.correctOption).length !== 1) errors.push("Alternativa correta ambígua.");
    } else if (question?.options?.length) errors.push("Opções presentes sem alternativa correta.");
    return { valid: errors.length === 0, errors };
  }

  return { getAvailableQuestionTypes, generateQuestion, generateQuestionByType, buildMultipleChoiceOptions, selectQuestionCategory, selectQuestionType, calculateDifficulty, calculatePoints, validateGeneratedQuestion };
}

const service = createQuizQuestionService();
module.exports = { ...service, createQuizQuestionService, QUESTION_TYPES, QUESTION_DISTRIBUTION, CATEGORY_TYPES };
