"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPlayerProgressRepository } = require("../src/repositories/playerProgressRepository");
const { createPlayerProgressService } = require("../src/services/playerProgressService");
const { createPlayerAchievementService, ACHIEVEMENTS } = require("../src/services/playerAchievementService");
const { createPlayerAchievementsCommand, mentionedPlayer } = require("../src/commands/playerAchievements");
const { createPlayerProfileService } = require("../src/services/playerProfileService");

async function fixture(stats = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-achievement-"));
  const repository = createPlayerProgressRepository({ databaseDir: path.join(root, "db"), backupRoot: path.join(root, "backups") });
  const progressService = createPlayerProgressService({ repository });
  const identityService = { resolveDisplayName: async (id, options) => /@|\d{8}/.test(String(options.displayName || "")) ? "Treinador" : options.displayName || "Treinador", identitiesMatch: (left, right) => left === right };
  const quizRepository = { getUserProfile: async () => ({ correctAnswers: Number(stats.quizCorrectAnswers || 0), bestStreak: Number(stats.quizBestStreak || 0) }) };
  const service = createPlayerAchievementService({ repository, progressService, quizRepository, identityService, clock: () => new Date("2026-07-17T15:00:00.000Z") });
  await repository.loadDatabase();
  await repository.updatePlayerProgress("whatsapp", "g@g.us", "user@lid", { displayName: "Mychelle", xp: 1000, level: 5, correctAnswers: 100, wrongAnswers: 5, bestCombo: 25, marathonsPlayed: 2, wins: 1, mvpCount: 1, ...stats });
  await repository.updateGlobalProgress("whatsapp", "user@lid", { displayName: "Mychelle", xp: 1000, level: 5, correctAnswers: 100, wrongAnswers: 5, bestCombo: 25, marathonsPlayed: 2, wins: 1, mvpCount: 1, ...stats });
  return { root, repository, progressService, identityService, service };
}
const cleanup = (root) => fsp.rm(root, { recursive: true, force: true });

test("catálogo não duplica visualmente Primeira Maratona", () => {
  assert.equal(ACHIEVEMENTS.length, 22); assert.equal(new Set(ACHIEVEMENTS.map((item) => item.id)).size, 22);
  assert.equal(ACHIEVEMENTS.filter((item) => item.name === "Primeira Maratona").length, 1);
});

test("desbloqueio automático observa estatísticas existentes", async () => {
  const f = await fixture(); try {
    const result = await f.service.evaluateAchievements({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true });
    for (const id of ["correct_10", "correct_50", "correct_100", "level_5", "combo_10", "combo_25", "onboarding_first_marathon", "win_first", "mvp_first", "accuracy_90_100"]) assert.ok(result.items.find((item) => item.id === id)?.unlocked, id);
    assert.equal(result.items.find((item) => item.id === "correct_500").unlocked, false);
  } finally { await cleanup(f.root); }
});

test("desbloqueio é persistente e não duplica", async () => {
  const f = await fixture(); try {
    const first = await f.service.evaluateAchievements({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true });
    const second = await f.service.evaluateAchievements({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true });
    const stored = await f.repository.getPlayerProgress("whatsapp", "g@g.us", "user@lid");
    assert.equal(stored.achievements.length, new Set(stored.achievements.map((item) => item.id)).size);
    assert.equal(first.obtained, second.obtained); assert.equal(second.newlyUnlocked.length, 0);
  } finally { await cleanup(f.root); }
});

test("evidência histórica do Quiz desbloqueia acertos e combos sem fundir os bancos", async () => {
  const f = await fixture({ correctAnswers: 17, bestCombo: 10, quizCorrectAnswers: 57, quizBestStreak: 57 });
  try {
    const first = await f.service.evaluateAchievements({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true });
    const second = await f.service.evaluateAchievements({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true });
    for (const id of ["correct_50", "combo_25", "combo_50"]) assert.equal(first.items.find((item) => item.id === id).unlocked, true);
    const progress = await f.repository.getPlayerProgress("whatsapp", "g@g.us", "user@lid");
    assert.equal(progress.correctAnswers, 17);
    assert.equal(progress.bestCombo, 10);
    assert.equal(second.newlyUnlocked.length, 0);
  } finally { await cleanup(f.root); }
});

test("alias histórico de Primeira Maratona é preservado e exibido uma única vez", async () => {
  const f = await fixture({ marathonsPlayed: 0, achievements: [{ id: "marathon_first", unlockedAt: "2026-01-01T00:00:00.000Z" }] });
  try {
    const result = await f.service.evaluateAchievements({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true });
    assert.equal(result.items.filter((item) => item.name === "Primeira Maratona").length, 1);
    assert.equal(result.items.find((item) => item.id === "onboarding_first_marathon").unlocked, true);
    const stored = await f.repository.getPlayerProgress("whatsapp", "g@g.us", "user@lid");
    assert.ok(stored.achievements.some((item) => item.id === "marathon_first"));
  } finally { await cleanup(f.root); }
});

test("precisão exige mais de 90% e pelo menos 100 respostas", async () => {
  const lowVolume = await fixture({ correctAnswers: 95, wrongAnswers: 4 });
  const exact = await fixture({ correctAnswers: 90, wrongAnswers: 10 });
  try {
    assert.equal((await lowVolume.service.evaluateAchievements({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true })).items.find((item) => item.id === "accuracy_90_100").unlocked, false);
    assert.equal((await exact.service.evaluateAchievements({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true })).items.find((item) => item.id === "accuracy_90_100").unlocked, false);
  } finally { await cleanup(lowVolume.root); await cleanup(exact.root); }
});

test("comando formata obtidas, bloqueadas e total sem IDs", async () => {
  const f = await fixture(); try {
    const summary = await f.service.getPlayerAchievements({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true });
    const text = f.service.formatAchievements(summary);
    assert.match(text, /🏅 CONQUISTAS/); assert.match(text, /✅.*Primeira Vitória/); assert.match(text, /⬜.*500 Acertos/); assert.match(text, new RegExp(`Total:\n${summary.obtained} / 22`));
    assert.doesNotMatch(text, /@lid|@g\.us|@c\.us|playerId|\d{8,}/i);
  } finally { await cleanup(f.root); }
});

test("jogador inexistente e registro antigo são compatíveis", async () => {
  const f = await fixture(); try {
    assert.equal(await f.service.getPlayerAchievements({ platform: "whatsapp", groupId: "g@g.us", playerId: "missing@lid", isGroup: true }), null);
    assert.equal(f.service.formatAchievements(null), "📊 Este jogador ainda não possui progresso no Quiz.");
    await f.repository.updatePlayerProgress("whatsapp", "g@g.us", "legacy@lid", { displayName: "Legado", correctAnswers: 10 });
    const legacy = await f.service.getPlayerAchievements({ platform: "whatsapp", groupId: "g@g.us", playerId: "legacy@lid", isGroup: true });
    assert.equal(legacy.items.find((item) => item.id === "correct_10").unlocked, true);
  } finally { await cleanup(f.root); }
});

test("perfil mostra quantidade e última conquista", async () => {
  const f = await fixture(); try {
    const profileService = createPlayerProfileService({ repository: f.repository, progressService: f.progressService, rankingService: { getRanking: async () => ({ status: "empty", entries: [] }) }, identityService: f.identityService, achievementService: f.service });
    const profile = await profileService.getPlayerProfile({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true });
    const text = profileService.formatProfile(profile);
    assert.match(text, /🏅 Conquistas/); assert.match(text, new RegExp(`Obtidas: ${profile.achievements.obtained} / 22`)); assert.match(text, /Última conquista:\n\S/);
  } finally { await cleanup(f.root); }
});

test("comando funciona em grupo, privado, menção e aliases", async () => {
  const calls = []; const replies = [];
  const achievementService = { getPlayerAchievements: async (query) => { calls.push(query); return { ok: true }; }, formatAchievements: () => "conquistas" };
  const command = createPlayerAchievementsCommand({ achievementService });
  const group = { platform: "whatsapp", groupId: "g@g.us", userId: "self@lid", isGroup: true, replyText: async (text) => replies.push(text) };
  await command.execute({}, { mentionedIds: ["other@lid"] }, ["@other"], { platformContext: group });
  await command.execute({}, {}, [], { platformContext: { ...group, groupId: "self@c.us", isGroup: false } });
  assert.equal(calls[0].playerId, "other@lid"); assert.equal(calls[0].isGroup, true); assert.equal(calls[1].playerId, "self@lid"); assert.equal(calls[1].isGroup, false);
  assert.deepEqual(command.aliases, ["badges", "medalhas", "achievements"]); assert.deepEqual(replies, ["conquistas", "conquistas"]);
  assert.equal(mentionedPlayer({ mentionedIds: ["123:2@lid"] }, []), "123@lid");
});
