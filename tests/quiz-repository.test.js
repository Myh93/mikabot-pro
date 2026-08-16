"use strict";

const assert = require("assert");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const test = require("node:test");

const { createQuizRepository } = require("../src/repositories/quizRepository");
const DATA_FILES = ["settings.json", "sessions.json", "rankings.json", "profiles.json", "history.json", "schedules.json", "recentQuestions.json"];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-quiz-repository-"));
  const databaseDir = path.join(root, "quiz");
  const backupRoot = path.join(root, "backups");
  return { root, databaseDir, backupRoot, repository: createQuizRepository({ databaseDir, backupRoot }) };
}

function session(overrides = {}) {
  return {
    platform: "whatsapp", groupId: "group-a", roundId: "round-1", mode: "collective",
    status: "active", questionType: "type", pokemonId: 25, acceptedAnswers: ["pikachu"],
    attemptsByUser: {}, participants: {}, difficulty: "normal", points: 10,
    startedAt: "2026-07-15T20:00:00.000Z", expiresAt: "2099-07-15T20:01:00.000Z",
    winnerId: null, finishedAt: null, ...overrides
  };
}

test("criação inicial gera todos os arquivos e manifesto válido", async () => {
  const { repository, databaseDir } = fixture();
  const database = await repository.loadQuizDatabase();
  assert.strictEqual(database.manifest.status, "valid");
  assert.deepStrictEqual([...database.manifest.files].sort(), [...DATA_FILES].sort());
  for (const file of ["manifest.json", ...DATA_FILES]) assert.strictEqual(fs.existsSync(path.join(databaseDir, file)), true);
  assert.strictEqual((await repository.validateQuizDatabase()).valid, true);
});

test("escritas concorrentes são serializadas, atômicas e não deixam temporários", async () => {
  const { repository, databaseDir } = fixture();
  await repository.loadQuizDatabase();
  await Promise.all(Array.from({ length: 12 }, (_, index) => repository.updateGroupSettings("whatsapp", `group-${index}`, { cooldownSeconds: index })));
  const database = await repository.loadQuizDatabase();
  assert.strictEqual(Object.keys(database.settings.groups).length, 12);
  assert.deepStrictEqual((await fsp.readdir(databaseDir)).filter((file) => file.endsWith(".tmp")), []);
});

test("recusa segunda sessão ativa no grupo, mas separa grupos e plataformas", async () => {
  const { repository } = fixture();
  await repository.createSession(session());
  await assert.rejects(repository.createSession(session({ roundId: "round-2" })), /Já existe uma sessão ativa/);
  await repository.createSession(session({ groupId: "group-b", roundId: "round-2" }));
  await repository.createSession(session({ platform: "telegram", roundId: "round-3" }));
  assert.strictEqual((await repository.getActiveSession("whatsapp", "group-a")).roundId, "round-1");
  assert.strictEqual((await repository.getActiveSession("whatsapp", "group-b")).roundId, "round-2");
  assert.strictEqual((await repository.getActiveSession("telegram", "group-a")).roundId, "round-3");
});

test("sessão expirada é detectável e finalização é idempotente com histórico preservado", async () => {
  const { repository } = fixture();
  await repository.createSession(session({ expiresAt: "2020-01-01T00:00:00.000Z" }));
  assert.strictEqual((await repository.getActiveSession("whatsapp", "group-a")).isExpired, true);
  const first = await repository.finishSession("whatsapp", "group-a", "round-1", { winnerId: "user-1", finishedAt: "2026-07-15T20:00:30.000Z" });
  const second = await repository.finishSession("whatsapp", "group-a", "round-1", { winnerId: "user-2" });
  assert.deepStrictEqual(second, first);
  const history = await repository.listHistory("whatsapp", "group-a", { type: "session_finished" });
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].session.winnerId, "user-1");
});

test("ranking de grupo e perfil global permanecem separados", async () => {
  const { repository } = fixture();
  await repository.incrementUserStats("whatsapp", "group-a", "user-1", { points: 10, correctAnswers: 1, gamesPlayed: 1, wins: 1, streakDelta: 1, questionType: "type", difficulty: "normal" });
  await repository.incrementUserStats("whatsapp", "group-b", "user-1", { points: 4, wrongAnswers: 1, gamesPlayed: 1, streakDelta: -1, questionType: "weakness", difficulty: "hard" });
  await repository.incrementUserStats("whatsapp", "group-a", "user-2", { points: 5, correctAnswers: 1, gamesPlayed: 1 });
  const ranking = await repository.getGroupRanking("whatsapp", "group-a");
  assert.deepStrictEqual(ranking.map((entry) => entry.userId), ["user-1", "user-2"]);
  assert.strictEqual((await repository.getUserProfile("whatsapp", "group-a", "user-1")).points, 10);
  assert.strictEqual((await repository.getUserProfile("whatsapp", "group-b", "user-1")).points, 4);
  const global = await repository.getUserProfile("whatsapp", null, "user-1", { global: true });
  assert.strictEqual(global.points, 14);
  assert.strictEqual(global.gamesPlayed, 2);
});

test("histórico manual é isolado por grupo", async () => {
  const { repository } = fixture();
  await repository.addHistoryEntry({ platform: "whatsapp", groupId: "group-a", type: "round", value: 1 });
  await repository.addHistoryEntry({ platform: "whatsapp", groupId: "group-b", type: "round", value: 2 });
  assert.deepStrictEqual((await repository.listHistory("whatsapp", "group-a")).map((entry) => entry.value), [1]);
});

test("perguntas recentes expiram e permanecem isoladas por plataforma e grupo", async () => {
  const { repository } = fixture();
  await repository.addRecentQuestion("whatsapp", "group-a", { pokemonId: 25, questionType: "type", expiresAt: "2020-01-01T00:00:00.000Z" });
  await repository.addRecentQuestion("whatsapp", "group-a", { pokemonId: 1, questionType: "weakness", correctAnswer: "fire", expiresAt: "2099-01-01T00:00:00.000Z" });
  await repository.addRecentQuestion("telegram", "group-a", { pokemonId: 4, questionType: "type", expiresAt: "2099-01-01T00:00:00.000Z" });
  assert.deepStrictEqual((await repository.getRecentQuestions("whatsapp", "group-a")).map((entry) => entry.pokemonId), [1]);
  assert.strictEqual(await repository.clearExpiredRecentQuestions("2026-01-01T00:00:00.000Z"), 1);
  assert.deepStrictEqual((await repository.getRecentQuestions("telegram", "group-a")).map((entry) => entry.pokemonId), [4]);
  assert.deepStrictEqual(await repository.getRecentPokemon("whatsapp", "group-a", 50), [1]);
  assert.deepStrictEqual(await repository.getRecentQuestionModels("whatsapp", "group-a", 2), ["weakness"]);
  assert.deepStrictEqual(await repository.getRecentCorrectAnswers("whatsapp", "group-a", 20), ["fire"]);
  assert.deepStrictEqual(await repository.getRecentPokemon("telegram", "group-a", 50), [4]);
  assert.deepStrictEqual(await repository.getRecentPokemon("whatsapp", "group-b", 50), []);
  const stored = (await repository.getRecentQuestions("whatsapp", "group-a"))[0];
  assert.equal(stored.platform, "whatsapp");
  assert.equal(stored.groupId, "group-a");
});

test("agendamento armazena fuso, regras e recibos e pode ser cancelado", async () => {
  const { repository } = fixture();
  const saved = await repository.saveSchedule({ platform: "whatsapp", groupId: "group-a", scheduleId: "t-1", timezone: "America/Sao_Paulo", rules: { rounds: 10 }, startsAt: "2099-01-01T00:00:00.000Z" });
  assert.deepStrictEqual(saved.receipts, { notice30m: null, notice10m: null, started: null, ended: null });
  await repository.updateSchedule("whatsapp", "group-a", "t-1", { receipts: { ...saved.receipts, notice30m: "receipt-1" } });
  await repository.cancelSchedule("whatsapp", "group-a", "t-1");
  const schedules = await repository.getSchedules("whatsapp", "group-a");
  assert.strictEqual(schedules[0].status, "cancelled");
  assert.strictEqual(schedules[0].timezone, "America/Sao_Paulo");
});

test("backup é deduplicado e restauração recupera o conjunto completo", async () => {
  const { repository } = fixture();
  await repository.updateGroupSettings("whatsapp", "group-a", { timezone: "America/Sao_Paulo" });
  const first = await repository.createBackup();
  const second = await repository.createBackup();
  assert.strictEqual(first.reused, false);
  assert.strictEqual(second.reused, true);
  assert.strictEqual(second.directory, first.directory);
  await repository.updateGroupSettings("whatsapp", "group-a", { timezone: "UTC" });
  await repository.restoreBackup(first.directory);
  assert.strictEqual((await repository.getGroupSettings("whatsapp", "group-a")).timezone, "America/Sao_Paulo");
  assert.strictEqual((await repository.validateQuizDatabase()).valid, true);
});

test("checksum incorreto e JSON corrompido falham de modo seguro", async () => {
  const checksumFixture = fixture();
  await checksumFixture.repository.loadQuizDatabase();
  await fsp.appendFile(path.join(checksumFixture.databaseDir, "settings.json"), " ");
  const checksumValidation = await checksumFixture.repository.validateQuizDatabase();
  assert.strictEqual(checksumValidation.valid, false);
  assert.ok(checksumValidation.errors.some((error) => error.includes("Checksum inválido")));

  const corruptFixture = fixture();
  await corruptFixture.repository.loadQuizDatabase();
  await fsp.writeFile(path.join(corruptFixture.databaseDir, "sessions.json"), "{não-json", "utf8");
  await assert.rejects(corruptFixture.repository.loadQuizDatabase(), /Base do Quiz inválida/);
});

test("dados persistem após criação de uma nova instância", async () => {
  const { databaseDir, backupRoot, repository } = fixture();
  await repository.updateGroupSettings("telegram", "group-z", { timezone: "Europe/Lisbon" });
  const secondInstance = createQuizRepository({ databaseDir, backupRoot });
  assert.strictEqual((await secondInstance.getGroupSettings("telegram", "group-z")).timezone, "Europe/Lisbon");
  assert.strictEqual((await secondInstance.validateQuizDatabase()).valid, true);
});
