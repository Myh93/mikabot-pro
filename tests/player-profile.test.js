"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createPlayerProfileService } = require("../src/services/playerProfileService");
const { createPlayerProfileCommand, mentionedPlayer } = require("../src/commands/playerProfile");
const { DEFINITIONS } = require("../src/services/menuRegistry");

const baseProgress = { platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", displayName: "Mychelle", xp: 120, level: 2, correctAnswers: 6, wrongAnswers: 1, currentCombo: 5, bestCombo: 41, wins: 1, mvpCount: 1, marathonsPlayed: 2, marathonsFinished: 2 };
function fixture(overrides = {}) {
  const progress = overrides.progress === undefined ? baseProgress : overrides.progress;
  const progressService = {
    getPlayerProgress: async () => progress,
    getNextLevelProgress: (xp) => ({ level: 2, currentLevelXp: xp, levelStartXp: 100, nextLevelXp: 300, progressXp: xp - 100, requiredXp: 200 }),
    getPlayerAccuracy: (record) => record ? record.correctAnswers / (record.correctAnswers + record.wrongAnswers) * 100 : 0
  };
  const repository = { getGlobalProgress: async () => progress && { ...progress, groupId: null } };
  const rankingService = { getRanking: async ({ type, page }) => {
    const position = type === "group" ? 1 : 14;
    const targetPage = Math.ceil(position / 10);
    const entries = page === targetPage ? (type === "group" ? [{ playerId: "user@lid" }] : [{ playerId: "a" }, { playerId: "b" }, { playerId: "c" }, { playerId: "user@lid" }]) : [];
    return { status: "ok", total: type === "group" ? 3 : 20, start: (page - 1) * 10, entries };
  } };
  const identityService = { resolveDisplayName: async () => overrides.name || "Mychelle", identitiesMatch: (left, right) => left === right };
  return createPlayerProfileService({ repository, progressService, rankingService, identityService });
}

test("perfil próprio reúne progressão, precisão, maratona e rankings", async () => {
  const service = fixture();
  const profile = await service.getPlayerProfile({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true });
  assert.equal(profile.name, "Mychelle"); assert.equal(profile.level, 2); assert.equal(profile.xp, 120);
  assert.equal(profile.accuracy.toFixed(1), "85.7"); assert.deepEqual(profile.rankings, { group: 1, global: 14 });
  assert.equal(profile.currentCombo, 5); assert.equal(profile.bestCombo, 41); assert.equal(profile.marathonsPlayed, 2); assert.equal(profile.wins, 1); assert.equal(profile.mvpCount, 1);
});

test("barra de XP usa dez posições sem arredondar para cima", () => {
  const service = fixture();
  assert.equal(service.buildProgressBar(0, 200), "⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜");
  assert.equal(service.buildProgressBar(99, 200), "🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜");
  assert.equal(service.buildProgressBar(200, 200), "🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩");
});

test("formatação preserva privacidade e apresenta todos os campos", async () => {
  const service = fixture(); const profile = await service.getPlayerProfile({ platform: "whatsapp", groupId: "g@g.us", playerId: "user@lid", isGroup: true });
  const text = service.formatProfile(profile);
  for (const expected of ["PERFIL DO TREINADOR", "Mychelle", "Nível 2", "120 / 300", "85,7%", "Combo Atual", "Melhor Combo", "Participações", "Vitórias", "MVPs", "#1", "#14"]) assert.match(text, new RegExp(expected));
  assert.doesNotMatch(text, /@lid|@g\.us|@c\.us|playerId|user@|\d{8,}/i);
});

test("jogador inexistente e registro antigo têm fallback compatível", async () => {
  const missing = fixture({ progress: null });
  assert.equal(await missing.getPlayerProfile({ platform: "whatsapp", groupId: "g", playerId: "u", isGroup: true }), null);
  assert.equal(missing.formatProfile(null), "📊 Este jogador ainda não possui progresso no Quiz.");
  const legacy = fixture({ progress: { ...baseProgress, wrongAnswers: undefined, currentCombo: undefined, bestCombo: undefined, marathonsPlayed: undefined, wins: undefined, mvpCount: undefined } });
  const text = legacy.formatProfile(await legacy.getPlayerProfile({ platform: "whatsapp", groupId: "g", playerId: "user@lid", isGroup: true }));
  assert.match(text, /❌ Erros\n0/); assert.match(text, /🎮 Participações\n0/);
});

test("perfil privado usa agregação global e omite ranking de grupo", async () => {
  const service = fixture();
  const profile = await service.getPlayerProfile({ platform: "whatsapp", groupId: "private@c.us", playerId: "user@lid", isGroup: false });
  assert.equal(profile.rankings.group, null); assert.equal(profile.rankings.global, 14);
  assert.match(service.formatProfile(profile), /Ranking do Grupo\n\nNão classificado/);
});

test("comando funciona no grupo, privado e para usuário mencionado", async () => {
  const calls = []; const replies = [];
  const profileService = { getPlayerProfile: async (query) => { calls.push(query); return { ok: true }; }, formatProfile: () => "perfil" };
  const command = createPlayerProfileCommand({ profileService });
  const groupContext = { platform: "whatsapp", groupId: "g@g.us", userId: "self@lid", isGroup: true, replyText: async (text) => replies.push(text) };
  await command.execute({}, { mentionedIds: ["other@lid"] }, ["@other"], { platformContext: groupContext });
  assert.equal(calls[0].playerId, "other@lid"); assert.equal(calls[0].isGroup, true);
  const privateContext = { ...groupContext, groupId: "self@c.us", isGroup: false };
  await command.execute({}, {}, [], { platformContext: privateContext });
  assert.equal(calls[1].playerId, "self@lid"); assert.equal(calls[1].isGroup, false); assert.deepEqual(replies, ["perfil", "perfil"]);
});

test("menção é normalizada sem consulta adicional ao WhatsApp", () => {
  assert.equal(mentionedPlayer({ mentionedIds: ["12345:2@lid"] }, []), "12345@lid");
  assert.equal(mentionedPlayer({}, ["@5511999999999"]), "5511999999999");
  assert.equal(mentionedPlayer({}, []), null);
});

test("aliases e Menu do Quiz apontam para o comando novo", () => {
  const command = createPlayerProfileCommand({ profileService: {} });
  assert.deepEqual(command.aliases, ["me", "player", "trainer"]);
  assert.equal(DEFINITIONS.quiz.options.find((option) => option.label === "Estatísticas").command, "perfil");
  const loader = require("../src/loader");
  assert.equal(loader.perfil.name, "perfil");
});
