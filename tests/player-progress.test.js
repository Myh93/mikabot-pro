"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPlayerProgressRepository } = require("../src/repositories/playerProgressRepository");
const { createPlayerProgressService } = require("../src/services/playerProgressService");
const { createQuizAnswerHandler } = require("../src/events/quizAnswer");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-progress-"));
  const databaseDir = path.join(root, "database"); const backupRoot = path.join(root, "backups");
  const repository = createPlayerProgressRepository({ databaseDir, backupRoot });
  const service = createPlayerProgressService({ repository });
  await repository.loadDatabase();
  return { root, databaseDir, backupRoot, repository, service };
}
const cleanup = (root) => fsp.rm(root, { recursive: true, force: true });
const context = (overrides = {}) => ({ platform: "whatsapp", groupId: "grupo@g.us", playerId: "jogador@lid", roundId: "round-1", difficulty: "normal", displayName: "Mychelle", ...overrides });

test("cria arquivos versionados com manifesto e checksum válidos", async () => {
  const f = await fixture(); try {
    assert.equal(fs.existsSync(path.join(f.databaseDir, "progress.json")), true);
    assert.equal(fs.existsSync(path.join(f.databaseDir, "manifest.json")), true);
    assert.equal((await f.repository.loadDatabase()).schemaVersion, 1);
  } finally { await cleanup(f.root); }
});

test("curva de níveis e progresso seguem a fórmula oficial", async () => {
  const f = await fixture(); try {
    for (const [level, xp] of [[1, 0], [2, 100], [3, 300], [4, 600], [5, 1000], [10, 4500]]) {
      assert.equal(f.service.getXpForLevel(level), xp); assert.equal(f.service.calculateLevel(xp), level);
    }
    assert.deepEqual(f.service.getNextLevelProgress(650), { level: 4, currentLevelXp: 650, levelStartXp: 600, nextLevelXp: 1000, progressXp: 50, requiredXp: 400 });
    assert.equal(f.service.calculateLevel(4600), 10);
  } finally { await cleanup(f.root); }
});

test("XP usa dificuldade, preserva combo e calcula precisão", async () => {
  const f = await fixture(); try {
    for (const [index, difficulty, xp] of [[1, "easy", 10], [2, "normal", 15], [3, "hard", 20]]) {
      const result = await f.service.registerCorrectAnswer(context({ roundId: `r${index}`, difficulty }));
      assert.equal(result.xpAwarded, xp);
    }
    let progress = await f.service.getPlayerProgress("whatsapp", "grupo@g.us", "jogador@lid");
    assert.equal(progress.xp, 45); assert.equal(progress.currentCombo, 3); assert.equal(progress.bestCombo, 3);
    await f.service.registerWrongAnswer(context({ roundId: "r4" }));
    progress = await f.service.getPlayerProgress("whatsapp", "grupo@g.us", "jogador@lid");
    assert.equal(progress.currentCombo, 0); assert.equal(progress.bestCombo, 3); assert.equal(f.service.getPlayerAccuracy(progress), 75);
  } finally { await cleanup(f.root); }
});

test("acerto e erro são idempotentes inclusive após nova instância", async () => {
  const f = await fixture(); try {
    await f.service.registerCorrectAnswer(context()); await f.service.registerCorrectAnswer(context());
    await f.service.registerWrongAnswer(context({ roundId: "round-2" })); await f.service.registerWrongAnswer(context({ roundId: "round-2" }));
    const restarted = createPlayerProgressService({ repository: createPlayerProgressRepository({ databaseDir: f.databaseDir, backupRoot: f.backupRoot }) });
    await restarted.registerCorrectAnswer(context());
    const progress = await restarted.getPlayerProgress("whatsapp", "grupo@g.us", "jogador@lid");
    assert.equal(progress.xp, 15); assert.equal(progress.correctAnswers, 1); assert.equal(progress.wrongAnswers, 1);
  } finally { await cleanup(f.root); }
});

test("grupo e agregado global permanecem separados", async () => {
  const f = await fixture(); try {
    await f.service.registerCorrectAnswer(context({ groupId: "a", roundId: "a1", difficulty: "easy" }));
    await f.service.registerCorrectAnswer(context({ groupId: "b", roundId: "b1", difficulty: "hard" }));
    assert.equal((await f.repository.getPlayerProgress("whatsapp", "a", "jogador@lid")).xp, 10);
    assert.equal((await f.repository.getPlayerProgress("whatsapp", "b", "jogador@lid")).xp, 20);
    assert.equal((await f.repository.getGlobalProgress("whatsapp", "jogador@lid")).xp, 30);
  } finally { await cleanup(f.root); }
});

test("Maratona registra participação, conclusão, vitória e MVP uma vez", async () => {
  const f = await fixture(); try {
    const base = { platform: "whatsapp", groupId: "grupo@g.us", playerId: "jogador@lid", marathonId: "m1", displayName: "Mychelle" };
    await Promise.all([f.service.registerMarathonParticipation(base), f.service.registerMarathonParticipation(base)]);
    await f.service.registerMarathonCompletion(base); await f.service.registerMarathonCompletion(base);
    await f.service.registerMarathonWin(base); await f.service.registerMvp(base);
    const progress = await f.service.getPlayerProgress(base.platform, base.groupId, base.playerId);
    assert.equal(progress.marathonsPlayed, 1); assert.equal(progress.marathonsFinished, 1); assert.equal(progress.wins, 1); assert.equal(progress.mvpCount, 1);
  } finally { await cleanup(f.root); }
});

test("nome público reutiliza resolvedor central e rejeita IDs", async () => {
  const f = await fixture(); try {
    assert.equal(await f.service.resolvePublicPlayerName("5583999999999@c.us", { displayName: "5583999999999" }), "Treinador");
    assert.equal(await f.service.resolvePublicPlayerName("abc@lid", { displayName: "Mychelle" }), "Mychelle");
  } finally { await cleanup(f.root); }
});

test("concorrência é serializada e não deixa temporários", async () => {
  const f = await fixture(); try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => f.repository.incrementPlayerStats("whatsapp", "g", "u", { wins: 1 }, `op-${index}`)));
    assert.equal((await f.repository.getPlayerProgress("whatsapp", "g", "u")).wins, 20);
    assert.equal((await fsp.readdir(f.databaseDir)).some((name) => name.endsWith(".tmp")), false);
  } finally { await cleanup(f.root); }
});

test("backup é validado, deduplicado e restauração é atômica", async () => {
  const f = await fixture(); try {
    await f.service.registerCorrectAnswer(context());
    const first = await f.repository.createBackup(); const second = await f.repository.createBackup(); assert.equal(second.reused, true);
    await f.service.registerCorrectAnswer(context({ roundId: "round-2" }));
    await f.repository.restoreBackup(first.path, { skipCurrentBackup: true });
    assert.equal((await f.service.getPlayerProgress("whatsapp", "grupo@g.us", "jogador@lid")).xp, 15);
  } finally { await cleanup(f.root); }
});

test("JSON corrompido e checksum incorreto falham com segurança", async () => {
  const f = await fixture(); try {
    const original = await fsp.readFile(path.join(f.databaseDir, "progress.json"), "utf8");
    await fsp.writeFile(path.join(f.databaseDir, "progress.json"), "{");
    await assert.rejects(() => f.repository.loadDatabase(), /corrompido/);
    const validButChanged = JSON.parse(original); validButChanged.updatedAt = "2099-01-01T00:00:00.000Z";
    await fsp.writeFile(path.join(f.databaseDir, "progress.json"), `${JSON.stringify(validButChanged, null, 2)}\n`);
    await assert.rejects(() => f.repository.loadDatabase(), /Checksum incorreto/);
  } finally { await cleanup(f.root); }
});

test("salto de nível informa apenas o nível final", async () => {
  const f = await fixture(); try {
    await f.repository.updatePlayerProgress("whatsapp", "grupo@g.us", "jogador@lid", { xp: 990, level: 4, displayName: "Mychelle" }, "seed-level");
    await f.repository.updateGlobalProgress("whatsapp", "jogador@lid", { xp: 990, level: 4 }, "seed-level");
    const result = await f.service.registerCorrectAnswer(context({ difficulty: "hard" }));
    assert.equal(result.leveledUp, true); assert.equal(result.previousLevel, 4); assert.equal(result.newLevel, 5); assert.equal(result.xpAwarded, 20);
  } finally { await cleanup(f.root); }
});

test("handler envia mensagem segura somente quando há subida de nível", async () => {
  const sent = [];
  const handler = createQuizAnswerHandler({ quizRepository: { getUserProfile: async () => ({ currentStreak: 1 }) } });
  const base = { status: "correct", winnerId: "usuario@lid", pointsAwarded: 20, round: { displayAnswer: "Pikachu" } };
  const contextValue = { platform: "whatsapp", groupId: "grupo@g.us", displayName: "Mychelle", replyText: async (text) => sent.push(text) };
  await handler.announceResult(contextValue, { ...base, progression: { leveledUp: false } });
  assert.equal(sent.length, 1);
  await handler.announceResult(contextValue, { ...base, progression: { leveledUp: true, newLevel: 5 } });
  assert.equal(sent.length, 3); assert.match(sent[2], /Mychelle alcançou o nível 5/); assert.doesNotMatch(sent[2], /@lid|@g\.us|\d{8,}/);
});
