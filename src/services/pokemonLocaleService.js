"use strict";

const configurationService = require("./configurationService");

const TYPE_LOCALES = {
  normal: "Normal", fire: "Fogo", water: "Água", electric: "Elétrico", grass: "Planta",
  ice: "Gelo", fighting: "Lutador", poison: "Veneno", ground: "Terrestre", flying: "Voador",
  psychic: "Psíquico", bug: "Inseto", rock: "Pedra", ghost: "Fantasma", dragon: "Dragão",
  dark: "Sombrio", steel: "Aço", fairy: "Fada"
};

const DIFFICULTY_LOCALES = { easy: "Fácil", normal: "Normal", hard: "Difícil" };
const DEFAULT_LOCALE_CONFIGURATION = Object.freeze({
  quizLanguage: configurationService.get("quiz.language.display"),
  acceptedLanguages: configurationService.get("quiz.language.accepted")
});

function stripAccents(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function basicNormalize(value) {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[“”„]/g, "\"")
    .replace(/[‘’´`]/g, "'")
    .replace(/[.!?;:()[\]{}"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const TYPE_ALIASES = (() => {
  const aliases = {};
  for (const [english, portuguese] of Object.entries(TYPE_LOCALES)) {
    aliases[basicNormalize(english)] = english;
    aliases[basicNormalize(portuguese)] = english;
  }
  return Object.freeze(aliases);
})();

function canonicalType(value) {
  return TYPE_ALIASES[basicNormalize(value)] || null;
}

function splitLocalizedTypes(value) {
  const normalized = basicNormalize(value);
  const parts = normalized
    .replace(/\s+(?:e|and)\s+/g, "/")
    .replace(/\s*[,/]\s*/g, "/")
    .replace(/\s*-\s*/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return null;
  const canonical = parts.map(canonicalType);
  return canonical.every(Boolean) ? canonical : null;
}

function normalizeLocalizedAnswer(value) {
  const types = splitLocalizedTypes(value);
  if (types) return [...types].sort().join("/");
  return basicNormalize(value)
    .replace(/\s*-\s*/g, "-")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

function translateType(type, language = DEFAULT_LOCALE_CONFIGURATION.quizLanguage) {
  const canonical = canonicalType(type);
  if (!canonical) return String(type || "");
  return language.toLowerCase().startsWith("en") ? canonical[0].toUpperCase() + canonical.slice(1) : TYPE_LOCALES[canonical];
}

function translateWeakness(weakness, language) {
  return translateType(weakness, language);
}

function translateDifficulty(difficulty, language = DEFAULT_LOCALE_CONFIGURATION.quizLanguage) {
  const key = basicNormalize(difficulty);
  if (language.toLowerCase().startsWith("en")) return key ? key[0].toUpperCase() + key.slice(1) : "";
  return DIFFICULTY_LOCALES[key] || String(difficulty || "");
}

function formatDualType(types, language = DEFAULT_LOCALE_CONFIGURATION.quizLanguage, separator = "/") {
  const values = Array.isArray(types) ? types : splitLocalizedTypes(types) || [types];
  return values.map((type) => translateType(type, language)).join(separator);
}

function translateAnswer(answer, options = {}) {
  const language = typeof options === "string" ? options : options.language || DEFAULT_LOCALE_CONFIGURATION.quizLanguage;
  const types = splitLocalizedTypes(answer);
  if (types) return formatDualType(types, language);
  return String(answer ?? "");
}

function buildAcceptedLocalizedAnswers(values, options = {}) {
  const source = Array.isArray(values) ? values : [values];
  const canonical = source.map(canonicalType).filter(Boolean);
  const answers = [];
  if (options.allowIndividual !== false) answers.push(...canonical);
  if (options.combine && canonical.length === 2) {
    answers.push(canonical.join("/"), [...canonical].reverse().join("/"));
  }
  for (const alias of options.aliases || []) answers.push(alias);
  return [...new Set(answers.map(normalizeLocalizedAnswer).filter(Boolean))];
}

function translateQuestion(question, options = {}) {
  if (!question || typeof question !== "object") return question;
  const translated = { ...question, difficultyLabel: translateDifficulty(question.difficulty, options.language) };
  if (question.type === "multiple_choice_type") {
    translated.options = question.options.map((option) => ({ ...option, value: translateAnswer(option.value, options) }));
  }
  if (question.displayAnswer !== undefined) translated.displayAnswer = translateAnswer(question.displayAnswer, options);
  return translated;
}

module.exports = {
  translateType,
  translateWeakness,
  translateDifficulty,
  translateQuestion,
  translateAnswer,
  formatDualType,
  buildAcceptedLocalizedAnswers,
  normalizeLocalizedAnswer,
  DEFAULT_LOCALE_CONFIGURATION
};
