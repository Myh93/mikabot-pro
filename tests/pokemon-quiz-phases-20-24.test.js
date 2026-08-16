"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const pokemonDataService = require("../src/services/pokemonDataService");
const { createPokemonCommand } = require("../src/commands/pokemon");
const { createGameCommand, DEFAULT_CAPTURE_RATE, DEFAULT_SUSPENSE_MS } = require("../src/commands/game");
const { createQuizAnswerHandler } = require("../src/events/quizAnswer");
const { normalizeAnswer, answersMatch } = require("../src/services/quizAnswerNormalizer");

function message(body = "") {
  const replies = [];
  return { body, replies, reply: async text => { replies.push(String(text)); return text; } };
}

test("Pokédex usa o dataset oficial por nome, caixa e número sem inventar entrada", async () => {
  const command = createPokemonCommand();
  for (const search of ["Pikachu", "pikachu", "PIKACHU", "25"]) {
    const msg = message();
    await command.execute({}, msg, [search], { commandName: "pokedex" });
    assert.match(msg.replies.at(-1), /#25.*PIKACHU/s);
  }
  const missing = message();
  await command.execute({}, missing, ["PokemonInexistenteXYZ"], { commandName: "pokedex" });
  assert.match(missing.replies.at(-1), /não encontrado na Pokédex local/i);
  assert.equal(pokemonDataService.resolvePokemon("PokemonInexistenteXYZ"), null);
});

test("COUNTER e COUNTERS convergem e ausência de cobertura é informada claramente", async () => {
  const command = createPokemonCommand();
  const outputs = [];
  for (const alias of ["counter", "counters"]) {
    const msg = message();
    await command.execute({}, msg, ["Mewtwo"], { commandName: alias });
    outputs.push(msg.replies.at(-1));
  }
  assert.equal(outputs[0], outputs[1]);
  assert.match(outputs[0], /COUNTERS PARA MEWTWO/);
  const unavailable = message();
  await command.execute({}, unavailable, ["Pikachu"], { commandName: "counters" });
  assert.match(unavailable.replies.at(-1), /ainda não estão disponíveis/i);
  assert.ok(command.aliases.includes("counters"));
});

test("Pokébola usa suspense configurável e taxa determinística de 65%", async () => {
  assert.equal(DEFAULT_CAPTURE_RATE, 0.65);
  assert.equal(DEFAULT_SUSPENSE_MS, 2500);
  for (const [captureRoll, expected] of [[0.64, /foi capturado/], [0.65, /escapou da Pokébola/]]) {
    const waits = [];
    const rolls = [0, captureRoll];
    const command = createGameCommand({ random: () => rolls.shift(), wait: async ms => waits.push(ms) });
    const msg = message("POKEBOLA");
    await command.execute({}, msg, [], { commandName: "pokebola" });
    assert.equal(msg.replies.length, 2);
    assert.match(msg.replies[0], /Pokébola, vai/);
    assert.match(msg.replies[1], expected);
    assert.deepEqual(waits, [2500]);
  }
});

test("Quiz coletivo resolve vencedor pela identidade canônica e usa fallback neutro", async () => {
  const replies = [];
  const handler = createQuizAnswerHandler({
    quizRepository: { getUserProfile: async () => ({ currentStreak: 2 }) },
    quizService: {}, quizMarathonService: {},
  });
  const result = { status: "correct", winnerId: "winner@lid", pointsAwarded: 20, round: { acceptedAnswers: ["Pikachu"] } };
  await handler.announceResult({ platform: "whatsapp", groupId: "g", replyText: async text => replies.push(text), displayName: "Mychelle" }, result);
  assert.match(replies[0], /Vencedor: Mychelle/);
  assert.doesNotMatch(replies[0], /@lid|winner/);

  replies.length = 0;
  await handler.announceResult({ platform: "whatsapp", groupId: "g", replyText: async text => replies.push(text) }, result);
  assert.match(replies[0], /Vencedor: Treinador/);
  assert.doesNotMatch(replies[0], /@lid|winner/);
});

test("Quiz individual mostra ajuste real e próximo valor sem alterar três tentativas", async () => {
  const replies = [];
  const handler = createQuizAnswerHandler({ quizRepository: { getUserProfile: async () => ({ currentStreak: 1 }) }, quizService: {}, quizMarathonService: {} });
  await handler.announceResult({ platform: "whatsapp", groupId: "g", replyText: async text => replies.push(text), displayName: "Treinador" }, {
    status: "correct", winnerId: "u@lid", basePoints: 20, pointsPenalty: 5, pointsAwarded: 15,
    round: { acceptedAnswers: ["D"] }
  });
  assert.match(replies[0], /Pontos: \+15/);
  assert.match(replies[0], /Ajuste pela tentativa: -5/);
  replies.length = 0;
  await handler.announceResult({ replyText: async text => replies.push(text) }, { status: "wrong", attemptsRemaining: 2, nextAttemptPoints: 15 });
  assert.match(replies[0], /2 tentativas/);
  assert.match(replies[0], /Próxima tentativa vale: 15 pontos/);
});

test("alternativas isoladas aceitam caixa e pontuação, mas não texto comum", () => {
  for (const value of ["D", "d", "D,", "D.", " A. ", "b,", "C!"]) {
    assert.equal(answersMatch(value, [normalizeAnswer(value)[0]]), true, value);
  }
  for (const value of ["a resposta é D", "D talvez", "dia legal", "alternativa D agora"]) {
    assert.equal(answersMatch(value, ["d"]), false, value);
  }
});
