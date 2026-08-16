"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createPlayerProgressRepository } = require("../src/repositories/playerProgressRepository");
const { createPlayerProgressService } = require("../src/services/playerProgressService");
const { createPlayerRankingService, PAGE_SIZE } = require("../src/services/playerRankingService");
const configurationService = require("../src/services/configurationService");
const { createPlayerRankingCommand, ALIASES } = require("../src/commands/playerRanking");
const { DEFINITIONS } = require("../src/services/menuRegistry");

const safeIdentity = { resolveDisplayName: async (id, options) => /^\+?\d|@/.test(String(options.displayName || "")) ? "Treinador" : options.displayName || "Treinador" };
function memoryRepository(groups = [], global = []) {
  return { listGroupProgress: async (platform, groupId) => groups.filter((entry) => entry.platform === platform && entry.groupId === groupId), listGlobalProgress: async (platform) => global.filter((entry) => entry.platform === platform), listWeeklyProgress: async (platform, groupId) => (groupId ? groups : global).filter((entry) => entry.platform === platform && (!groupId || entry.groupId === groupId)), listMonthlyProgress: async (platform, groupId) => (groupId ? groups : global).filter((entry) => entry.platform === platform && (!groupId || entry.groupId === groupId)) };
}
const entry = (name, values = {}) => ({ platform: "whatsapp", groupId: "g@g.us", playerId: `${name}@lid`, displayName: name, xp: 100, level: 2, correctAnswers: 5, wins: 1, mvpCount: 0, bestCombo: 2, weeklyXp: 10, weeklyCorrectAnswers: 1, weeklyWins: 0, weeklyMvpCount: 0, monthlyXp: 20, monthlyCorrectAnswers: 2, monthlyWins: 0, monthlyMvpCount: 0, ...values });

test("tamanho da página é obtido pela fachada de configuração", () => {
  assert.equal(PAGE_SIZE, configurationService.get("quiz.ranking.pageSize"));
  assert.equal(PAGE_SIZE, 10);
});

test("ranking de grupo ordena por todos os critérios permanentes", async () => {
  const players = [entry("Zeta"), entry("Alfa"), entry("Xp", { xp: 200 }), entry("Nivel", { level: 3 }), entry("Acertos", { correctAnswers: 6 }), entry("Vitorias", { wins: 2 }), entry("Mvp", { mvpCount: 2 }), entry("Combo", { bestCombo: 4 })];
  const service = createPlayerRankingService({ repository: memoryRepository(players), identityService: safeIdentity });
  const result = await service.getRanking({ type: "group", platform: "whatsapp", groupId: "g@g.us" });
  assert.deepEqual(result.entries.map((item) => item.publicName), ["Xp", "Nivel", "Acertos", "Vitorias", "Mvp", "Combo", "Alfa", "Zeta"]);
});

test("ranking global não duplica jogador entre grupos e isola plataforma", async () => {
  const globals = [entry("Um", { groupId: null }), entry("Dois", { groupId: null }), entry("Telegram", { platform: "telegram", groupId: null })];
  const service = createPlayerRankingService({ repository: memoryRepository([], globals), identityService: safeIdentity });
  const result = await service.getRanking({ type: "global", platform: "whatsapp" });
  assert.deepEqual(result.entries.map((item) => item.publicName).sort(), ["Dois", "Um"]);
});

test("rankings semanal e mensal usam somente contadores do período", async () => {
  const players = [entry("Total", { xp: 9999, weeklyXp: 1, monthlyXp: 2 }), entry("Periodo", { xp: 1, weeklyXp: 100, monthlyXp: 200 })];
  const service = createPlayerRankingService({ repository: memoryRepository(players), identityService: safeIdentity });
  assert.equal((await service.getRanking({ type: "weekly", platform: "whatsapp", groupId: "g@g.us" })).entries[0].publicName, "Periodo");
  assert.equal((await service.getRanking({ type: "monthly", platform: "whatsapp", groupId: "g@g.us" })).entries[0].publicName, "Periodo");
});

test("paginação limita dez, suporta página dois e rejeita inválida", async () => {
  const players = Array.from({ length: 23 }, (_, index) => entry(`Jogador ${index + 1}`, { xp: 1000 - index }));
  const service = createPlayerRankingService({ repository: memoryRepository(players), identityService: safeIdentity });
  assert.equal((await service.getRanking({ type: "group", platform: "whatsapp", groupId: "g@g.us", page: 1 })).entries.length, 10);
  assert.equal((await service.getRanking({ type: "group", platform: "whatsapp", groupId: "g@g.us", page: 2 })).entries.length, 10);
  assert.equal(await service.renderRanking({ type: "group", platform: "whatsapp", groupId: "g@g.us", page: 4 }), "❌ Esta página não possui jogadores.");
  assert.equal(await service.renderRanking({ type: "group", platform: "whatsapp", groupId: "g@g.us", page: 0 }), "❌ Esta página não possui jogadores.");
});

test("ranking vazio usa mensagens definidas", async () => {
  const service = createPlayerRankingService({ repository: memoryRepository(), identityService: safeIdentity });
  assert.equal(await service.renderRanking({ type: "group", platform: "whatsapp", groupId: "g@g.us" }), "📊 Ainda não há jogadores no ranking deste grupo.");
});

test("nomes inseguros são ocultos e treinadores recebem diferenciação neutra", async () => {
  const players = [entry("5511999999999@lid", { playerId: "1@lid" }), entry("5511888888888@c.us", { playerId: "2@lid" })];
  const service = createPlayerRankingService({ repository: memoryRepository(players), identityService: safeIdentity });
  const text = await service.renderRanking({ type: "group", platform: "whatsapp", groupId: "g@g.us" });
  assert.match(text, /Treinador 1/); assert.match(text, /Treinador 2/); assert.doesNotMatch(text, /@lid|@c\.us|5511/);
});

test("migração compatível inicializa períodos sem perder XP", async () => {
  let now = new Date("2026-07-15T15:00:00Z");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ranking-period-"));
  const repository = createPlayerProgressRepository({ databaseDir: path.join(root, "db"), backupRoot: path.join(root, "backup"), clock: () => now });
  try {
    const migrated = repository.normalizePeriodCounters({ xp: 680, level: 4 });
    assert.equal(migrated.xp, 680); assert.equal(migrated.weeklyXp, 0); assert.equal(migrated.monthlyXp, 0); assert.equal(migrated.weeklyPeriodKey, "2026-W29"); assert.equal(migrated.monthlyPeriodKey, "2026-07");
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test("atualizações periódicas são idempotentes e viram semana e mês preservando total", async () => {
  let now = new Date("2026-07-31T20:00:00Z");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "ranking-rollover-"));
  const repository = createPlayerProgressRepository({ databaseDir: path.join(root, "db"), backupRoot: path.join(root, "backup"), clock: () => now });
  const progress = createPlayerProgressService({ repository });
  try {
    const base = { platform: "whatsapp", groupId: "g", playerId: "u", roundId: "r1", difficulty: "hard" };
    await progress.registerCorrectAnswer(base); await progress.registerCorrectAnswer(base);
    let current = await progress.getPlayerProgress("whatsapp", "g", "u");
    assert.equal(current.xp, 20); assert.equal(current.weeklyXp, 20); assert.equal(current.monthlyXp, 20);
    now = new Date("2026-08-03T15:00:00Z");
    await progress.registerCorrectAnswer({ ...base, roundId: "r2" });
    current = await progress.getPlayerProgress("whatsapp", "g", "u");
    assert.equal(current.xp, 40); assert.equal(current.weeklyXp, 20); assert.equal(current.monthlyXp, 20);
    assert.ok(Object.keys(current.periodHistory).length >= 1);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test("comandos, aliases e menu usam o novo serviço", async () => {
  const calls = []; const replies = [];
  const command = createPlayerRankingCommand({ rankingService: { renderRanking: async (query) => { calls.push(query); return "ranking"; } } });
  const context = { platform: "whatsapp", groupId: "g@g.us", isGroup: true, replyText: async (text) => replies.push(text) };
  await command.execute({}, {}, ["2"], { commandName: "ranking global", platformContext: context });
  assert.equal(calls[0].type, "global"); assert.equal(calls[0].page, 2); assert.equal(replies[0], "ranking");
  for (const alias of ["top", "ranking quiz", "ranking quiz grupo", "ranking quiz global", "ranking quiz semanal", "ranking quiz mensal"]) assert.ok(ALIASES.includes(alias));
  assert.deepEqual(DEFINITIONS.quiz.options.filter((option) => /Ranking/.test(option.label)).map((option) => option.command), ["ranking grupo", "ranking global", "ranking semanal", "ranking mensal"]);
});
