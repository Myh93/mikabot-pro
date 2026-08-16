"use strict";

const assert = require("assert");
const test = require("node:test");
const { normalizeAnswer, answersMatch, buildAcceptedAnswers } = require("../src/services/quizAnswerNormalizer");

test("normaliza maiúsculas, acentos, espaços e pontuação simples", () => {
  assert.strictEqual(normalizeAnswer("  PIKÁCHU!!!  "), "pikachu");
  assert.strictEqual(normalizeAnswer("Mr.   Mime"), "mr mime");
  assert.strictEqual(normalizeAnswer("Ho-Oh"), "ho-oh");
  assert.strictEqual(normalizeAnswer("Nº 025"), "nº 025");
});

test("não usa aproximação nem aceita respostas parciais", () => {
  const accepted = buildAcceptedAnswers("Pikachu");
  assert.strictEqual(answersMatch("pikáCHU", accepted), true);
  assert.strictEqual(answersMatch("Pika", accepted), false);
  assert.strictEqual(answersMatch("Pikach", accepted), false);
  assert.strictEqual(answersMatch("Raichu", accepted), false);
});

test("aceita somente aliases explicitamente declarados e remove duplicidades", () => {
  const accepted = buildAcceptedAnswers("Mr. Mime", ["Mime", "MR MIME"]);
  assert.deepStrictEqual(accepted, ["mr mime", "mime"]);
  assert.strictEqual(answersMatch("Mime", accepted), true);
  assert.strictEqual(answersMatch("Mim", accepted), false);
});
