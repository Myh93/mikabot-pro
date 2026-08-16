"use strict";

const { normalizeLocalizedAnswer } = require("./pokemonLocaleService");

function normalizeAnswer(value) {
  return normalizeLocalizedAnswer(value);
}

function buildAcceptedAnswers(primaryAnswers, aliases = []) {
  const values = [
    ...(Array.isArray(primaryAnswers) ? primaryAnswers : [primaryAnswers]),
    ...(Array.isArray(aliases) ? aliases : [aliases])
  ];
  return [...new Set(values.map(normalizeAnswer).filter(Boolean))];
}

function answersMatch(answer, acceptedAnswers, aliases = []) {
  const normalized = normalizeAnswer(answer);
  if (!normalized) return false;
  return buildAcceptedAnswers(acceptedAnswers, aliases).includes(normalized);
}

module.exports = { normalizeAnswer, answersMatch, buildAcceptedAnswers };
