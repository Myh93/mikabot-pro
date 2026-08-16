"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createQuizRepository } = require("../src/repositories/quizRepository");
const { createQuizQuestionService } = require("../src/services/quizQuestionService");
const { createQuizService } = require("../src/services/quizService");

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-quiz-engine-"));
  const databaseDir = path.join(root, "quiz");
  const backupRoot = path.join(root, "backups");
  const repository = createQuizRepository({ databaseDir, backupRoot });
  const questionService = createQuizQuestionService({ random: () => 0 });
  const service = createQuizService({ repository, questionService, roundDurationMs: options.roundDurationMs || 60_000, clock: options.clock });
  return { root, databaseDir, backupRoot, repository, questionService, service };
}

const collective = { platform: "whatsapp", groupId: "group-a", userId: "user-1" };

test("rodada coletiva persiste antes do retorno e primeiro acerto vence", async () => {
  const { repository, service } = fixture();
  const started = await service.startCollectiveRound(collective, { questionType: "pokemon_name_by_number", pokemonId: 1 });
  assert.strictEqual((await repository.getActiveSession("whatsapp", "group-a")).roundId, started.round.roundId);
  assert.deepStrictEqual(await service.submitAnswer({ ...collective, userId: "other" }, "errado"), { status: "ignored" });
  const result = await service.submitAnswer(collective, "BULBÁSAUR");
  assert.strictEqual(result.status, "correct");
  assert.strictEqual(result.winnerId, "user-1");
  assert.strictEqual(result.pointsAwarded, 10);
  assert.strictEqual((await repository.getUserProfile("whatsapp", "group-a", "user-1")).points, 10);
  assert.strictEqual((await repository.getGroupRanking("whatsapp", "group-a"))[0].userId, "user-1");
  assert.strictEqual((await repository.listHistory("whatsapp", "group-a", { type: "session_finished" })).length, 1);
  assert.strictEqual((await repository.getRecentQuestions("whatsapp", "group-a")).length, 1);
});

test("dois acertos simultâneos produzem somente um vencedor e uma pontuação", async () => {
  const { repository, service } = fixture();
  await service.startCollectiveRound(collective, { questionType: "pokemon_name_by_number", pokemonId: 1 });
  const results = await Promise.all([
    service.submitAnswer({ ...collective, userId: "user-a" }, "Bulbasaur"),
    service.submitAnswer({ ...collective, userId: "user-b" }, "Bulbasaur")
  ]);
  assert.strictEqual(results.filter((result) => result.status === "correct").length, 1);
  const pointsA = (await repository.getUserProfile("whatsapp", "group-a", "user-a")).points;
  const pointsB = (await repository.getUserProfile("whatsapp", "group-a", "user-b")).points;
  assert.strictEqual(pointsA + pointsB, 10);
});

test("rodada individual aceita apenas iniciador e reduz pontos após erro", async () => {
  const { repository, service } = fixture();
  const started = await service.startIndividualRound(collective, { questionType: "pokemon_name_by_number", pokemonId: 1 });
  assert.strictEqual((await service.submitAnswer({ ...collective, userId: "outsider" }, "Bulbasaur")).status, "not_participant");
  assert.deepStrictEqual((await service.submitAnswer(collective, "Ivysaur")).attemptsRemaining, 2);
  const result = await service.submitAnswer(collective, "Bulbasaur");
  assert.strictEqual(result.pointsAwarded, 7.5);
  assert.strictEqual((await repository.getUserProfile("whatsapp", "group-a", "user-1")).wrongAnswers, 1);
  assert.strictEqual((await service.getRoundStatus({ ...collective, roundId: started.round.roundId })).status, "finished");
});

test("rodada individual termina após três erros e zera sequência", async () => {
  const { repository, service } = fixture();
  await repository.incrementUserStats("whatsapp", "group-a", "user-1", { currentStreak: 4 });
  await service.startIndividualRound(collective, { questionType: "pokemon_name_by_number", pokemonId: 1 });
  assert.strictEqual((await service.submitAnswer(collective, "erro 1")).status, "wrong");
  assert.strictEqual((await service.submitAnswer(collective, "erro 2")).status, "wrong");
  const third = await service.submitAnswer(collective, "erro 3");
  assert.strictEqual(third.reason, "attempts_exhausted");
  const profile = await repository.getUserProfile("whatsapp", "group-a", "user-1");
  assert.strictEqual(profile.wrongAnswers, 3);
  assert.strictEqual(profile.gamesPlayed, 1);
  assert.strictEqual(profile.currentStreak, 0);
});

test("expiração e finalização manual são idempotentes", async () => {
  let current = new Date("2026-07-15T20:00:00.000Z");
  const { service } = fixture({ clock: () => new Date(current), roundDurationMs: 1000 });
  const started = await service.startCollectiveRound(collective, { questionType: "pokemon_name_by_number", pokemonId: 1 });
  current = new Date("2026-07-15T20:00:02.000Z");
  assert.strictEqual((await service.getRoundStatus(collective)).status, "expired");
  const first = await service.expireRound({ ...collective, roundId: started.round.roundId });
  const second = await service.expireRound({ ...collective, roundId: started.round.roundId });
  assert.strictEqual(first.status, "expired");
  assert.strictEqual(second.status, "expired");

  const secondFixture = fixture();
  const manual = await secondFixture.service.startCollectiveRound(collective, { questionType: "pokemon_name_by_number", pokemonId: 1 });
  const finish1 = await secondFixture.service.finishRound(collective, { roundId: manual.round.roundId });
  const finish2 = await secondFixture.service.finishRound(collective, { roundId: manual.round.roundId });
  assert.strictEqual(finish1.round.finishedAt, finish2.round.finishedAt);
});

test("grupos e plataformas ficam isolados e dados sobrevivem a nova instância", async () => {
  const { databaseDir, backupRoot, repository, questionService, service } = fixture();
  await Promise.all([
    service.startCollectiveRound(collective, { questionType: "pokemon_name_by_number", pokemonId: 1 }),
    service.startCollectiveRound({ platform: "whatsapp", groupId: "group-b", userId: "user-1" }, { questionType: "pokemon_name_by_number", pokemonId: 2 }),
    service.startCollectiveRound({ platform: "telegram", groupId: "group-a", userId: "user-1" }, { questionType: "pokemon_name_by_number", pokemonId: 3 })
  ]);
  assert.ok(await repository.getActiveSession("whatsapp", "group-a"));
  assert.ok(await repository.getActiveSession("whatsapp", "group-b"));
  assert.ok(await repository.getActiveSession("telegram", "group-a"));
  const newRepository = createQuizRepository({ databaseDir, backupRoot });
  const newService = createQuizService({ repository: newRepository, questionService });
  assert.strictEqual((await newService.getRoundStatus(collective)).status, "active");
});
