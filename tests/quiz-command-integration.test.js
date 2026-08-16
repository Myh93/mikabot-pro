"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createQuizRepository } = require("../src/repositories/quizRepository");
const { createQuizQuestionService } = require("../src/services/quizQuestionService");
const { createQuizService } = require("../src/services/quizService");
const { createQuizAnswerHandler } = require("../src/events/quizAnswer");
const { createQuizCommand } = require("../src/commands/quiz");
const { createPlatformContext } = require("../src/utils/platformContext");
const { createMenuSessionService } = require("../src/services/menuSessionService");
const { createMenuRegistry, DEFINITIONS } = require("../src/services/menuRegistry");

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-quiz-command-"));
  const repository = createQuizRepository({ databaseDir: path.join(root, "quiz"), backupRoot: path.join(root, "backups") });
  const questionService = createQuizQuestionService({ random: () => 0 });
  const service = createQuizService({ repository, questionService, roundDurationMs: 120_000, clock: options.clock });
  const answer = createQuizAnswerHandler({ quizService: service, quizRepository: repository });
  const menuSession = createMenuSessionService({ filePath: path.join(root, "menu-sessions.json") });
  const menuRegistry = createMenuRegistry({
    sessionService: menuSession,
    definitions: DEFINITIONS,
    permissionService: { hasPermission: () => true, resolveRole: async () => ({ name: "member", rank: 0 }) }
  });
  const cadastrosPath = path.join(root, "cadastros.json");
  fs.writeFileSync(cadastrosPath, "{}\n", "utf8");
  const command = createQuizCommand({ quizService: service, quizRepository: repository, quizAnswer: answer, menuRegistry, cadastrosPath });
  return { repository, service, answer, command };
}

function context(overrides = {}) {
  const replies = [];
  return {
    platform: "whatsapp", groupId: "group-a@g.us", conversationId: "group-a@g.us",
    userId: "user-1", messageId: "msg-1", isGroup: true,
    replyText: async (text) => { replies.push(text); return text; },
    sendText: async (text) => { replies.push(text); return text; },
    replies,
    ...overrides
  };
}

async function execute(command, commandName, args, ctx) {
  return command.execute({}, { body: `!${commandName}`, reply: ctx.replyText }, args, { commandName, platformContext: ctx });
}

test("!quiz abre o menu numérico novo", async () => {
  const { command } = fixture();
  const ctx = context();
  await execute(command, "quiz", [], ctx);
  assert.strictEqual(ctx.replies.length, 1);
  assert.match(ctx.replies[0], /MENU DO QUIZ/);
  assert.match(ctx.replies[0], /1️⃣ Jogar Quiz/);
  assert.match(ctx.replies[0], /12️⃣ Ajuda/);
});

test("!jogar quiz inicia coletiva e formata pergunta persistida", async () => {
  const { command, repository } = fixture();
  const ctx = context();
  await execute(command, "jogar quiz", [], ctx);
  const active = await repository.getActiveSession(ctx.platform, ctx.groupId);
  assert.strictEqual(active.mode, "collective");
  assert.match(ctx.replies[0], /QUIZ POKÉMON/);
  assert.match(ctx.replies[0], /Tempo: 2 minutos/);
  assert.match(ctx.replies[0], /Responda sem usar !/);
});

test("!jogar quiz individual vincula iniciador e informa três tentativas", async () => {
  const { command, repository } = fixture();
  const ctx = context();
  await execute(command, "jogar quiz", ["individual"], ctx);
  const active = await repository.getActiveSession(ctx.platform, ctx.groupId);
  assert.strictEqual(active.mode, "individual");
  assert.strictEqual(active.initiatorId, ctx.userId);
  assert.match(ctx.replies[0], /3 tentativas/);
});

test("resposta correta sem prefixo anuncia uma vez e erro coletivo é silencioso", async () => {
  const { service, answer } = fixture();
  const ctx = context();
  await service.startCollectiveRound(ctx, { questionType: "pokemon_name_by_number", pokemonId: 1 });
  assert.strictEqual((await answer.handleQuizAnswer({ context: ctx, text: "errado" })).status, "ignored");
  assert.strictEqual(ctx.replies.length, 0);
  const correct = await answer.handleQuizAnswer({ context: ctx, text: "BULBÁSAUR" });
  assert.strictEqual(correct.status, "correct");
  assert.strictEqual(ctx.replies.length, 1);
  assert.match(ctx.replies[0], /RESPOSTA CORRETA/);
  assert.match(ctx.replies[0], /Sequência: 1/);
});

test("individual informa tentativas restantes e ignora outro participante", async () => {
  const { service, answer } = fixture();
  const owner = context();
  await service.startIndividualRound(owner, { questionType: "pokemon_name_by_number", pokemonId: 1 });
  const outsider = context({ userId: "other", replies: [] });
  outsider.replyText = async (text) => outsider.replies.push(text);
  assert.strictEqual((await answer.handleQuizAnswer({ context: outsider, text: "Bulbasaur" })).status, "not_participant");
  assert.strictEqual(outsider.replies.length, 0);
  assert.strictEqual((await answer.handleQuizAnswer({ context: owner, text: "Ivysaur" })).status, "wrong");
  assert.match(owner.replies[0], /2 tentativas/);
});

test("!responder encaminha ao mesmo handler sem lógica paralela", async () => {
  const { service, command } = fixture();
  const ctx = context();
  await service.startCollectiveRound(ctx, { questionType: "pokemon_name_by_number", pokemonId: 1 });
  const result = await execute(command, "responder", ["Bulbasaur"], ctx);
  assert.strictEqual(result.status, "correct");
  assert.match(ctx.replies[0], /RESPOSTA CORRETA/);
});

test("mensagem comum sem sessão é ignorada antes do submit", async () => {
  let submitted = 0;
  const handler = createQuizAnswerHandler({
    quizService: {
      getRoundStatus: async () => ({ status: "none", round: null }),
      submitAnswer: async () => { submitted += 1; }
    },
    quizRepository: {}
  });
  assert.strictEqual(await handler.hasActiveRound(context()), false);
  assert.strictEqual(submitted, 0);
});

test("ranking e perfil usam dados do grupo sem revelar telefone completo", async () => {
  const { repository, command } = fixture();
  const ctx = context({ userId: "5511999991234" });
  await repository.incrementUserStats(ctx.platform, ctx.groupId, ctx.userId, { points: 20, correctAnswers: 1, gamesPlayed: 1, wins: 1, streakDelta: 1 });
  await execute(command, "ranking quiz", [], ctx);
  assert.match(ctx.replies[0], /RANKING DO QUIZ/);
  assert.doesNotMatch(ctx.replies[0], /5511999991234/);
  ctx.replies.length = 0;
  await execute(command, "perfil quiz", [], ctx);
  assert.match(ctx.replies[0], /Pontos: 20/);
  assert.match(ctx.replies[0], /Vitórias: 1/);
});

test("expiração revela resposta uma única vez ao receber interação", async () => {
  let current = new Date("2026-07-15T20:00:00.000Z");
  const { service, answer } = fixture({ clock: () => new Date(current) });
  const ctx = context();
  await service.startCollectiveRound(ctx, { questionType: "pokemon_name_by_number", pokemonId: 1, durationMs: 1000 });
  current = new Date("2026-07-15T20:00:02.000Z");
  assert.strictEqual((await answer.handleQuizAnswer({ context: ctx, text: "qualquer" })).status, "expired");
  assert.strictEqual(ctx.replies.length, 1);
  assert.strictEqual((await answer.hasActiveRound(ctx)), false);
});

test("grupos permanecem isolados", async () => {
  const { service, answer } = fixture();
  const groupA = context();
  const groupB = context({ groupId: "group-b@g.us", replies: [] });
  groupB.replyText = async (text) => groupB.replies.push(text);
  await service.startCollectiveRound(groupA, { questionType: "pokemon_name_by_number", pokemonId: 1 });
  assert.strictEqual(await answer.hasActiveRound(groupB), false);
  assert.strictEqual(await answer.hasActiveRound(groupA), true);
});

test("contexto de plataforma resolve grupo, privado e LID sem acoplamento adicional", async () => {
  const client = { sendMessage: async () => undefined };
  const group = await createPlatformContext(client, { from: "group@g.us", author: "12345@lid", body: "texto", id: { _serialized: "m1" }, reply: async () => undefined }, { resolveContact: false });
  assert.strictEqual(group.groupId, "group@g.us");
  assert.strictEqual(group.userId, "12345@lid");
  assert.strictEqual(group.isGroup, true);
  const privateContext = await createPlatformContext(client, { from: "5511999999999@c.us", body: "texto", reply: async () => undefined }, { resolveContact: false });
  assert.strictEqual(privateContext.userId, "5511999999999");
  assert.strictEqual(privateContext.isGroup, false);
});

test("Pokébola permanece registrada e attach não duplica listener", () => {
  const loader = require("../src/loader");
  const commands = Object.values(loader);
  const game = commands.find((command) => command.name === "game");
  const quiz = commands.find((command) => command.name === "quiz");
  assert.ok(game.aliases.includes("pokebola"));
  assert.deepStrictEqual(game.aliases.filter((alias) => ["quiz", "responder"].includes(alias)), []);
  assert.ok(quiz.aliases.includes("responder"));
  assert.strictEqual(commands.filter((command) => command.name === "quiz").length, 1);
  const client = { listeners: [], on(event, listener) { this.listeners.push({ event, listener }); } };
  loader.attach(client);
  loader.attach(client);
  assert.strictEqual(client.listeners.filter((entry) => entry.event === "message").length, 1);
});

test("loader nunca encaminha comando prefixado como resposta automática", async () => {
  const loader = require("../src/loader");
  const quizAnswer = require("../src/events/quizAnswer");
  const originalHasActiveRound = quizAnswer.hasActiveRound;
  const originalHandle = quizAnswer.handleQuizAnswer;
  let checked = 0;
  let handled = 0;
  quizAnswer.hasActiveRound = async () => { checked += 1; return false; };
  quizAnswer.handleQuizAnswer = async () => { handled += 1; };
  try {
    const client = { listener: null, on(event, listener) { if (event === "message") this.listener = listener; }, sendMessage: async () => undefined };
    loader.attach(client);
    await client.listener({ fromMe: false, from: "group@g.us", author: "123@c.us", body: "!comando inexistente" });
    assert.strictEqual(checked, 0);
    assert.strictEqual(handled, 0);
    await client.listener({ fromMe: false, from: "group@g.us", author: "123@c.us", body: "conversa normal" });
    assert.strictEqual(checked, 1);
    assert.strictEqual(handled, 0);
  } finally {
    quizAnswer.hasActiveRound = originalHasActiveRound;
    quizAnswer.handleQuizAnswer = originalHandle;
  }
});
