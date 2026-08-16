"use strict";

const defaultRepository = require("../repositories/playerProgressRepository");
const defaultProgressService = require("./playerProgressService");
const identityService = require("./identityService");

const ACHIEVEMENTS = Object.freeze([
  { id: "onboarding_first_step", name: "Primeiro Passo", icon: "🏅", test: (p) => (p.achievements || []).some((item) => (item?.id || item) === "onboarding_first_step") },
  { id: "onboarding_official_trainer", name: "Treinador Oficial", icon: "🎓", test: (p) => (p.achievements || []).some((item) => (item?.id || item) === "onboarding_official_trainer") },
  { id: "onboarding_first_raid", name: "Primeira Raid", icon: "⚔️", test: (p) => (p.achievements || []).some((item) => (item?.id || item) === "onboarding_first_raid") },
  { id: "onboarding_first_event", name: "Primeiro Evento", icon: "📅", test: (p) => (p.achievements || []).some((item) => (item?.id || item) === "onboarding_first_event") },
  { id: "onboarding_first_quiz", name: "Primeiro Quiz", icon: "🧠", test: (p) => (p.achievements || []).some((item) => (item?.id || item) === "onboarding_first_quiz") },
  { id: "onboarding_first_feedback", name: "Primeiro Feedback", icon: "🤝", test: (p) => (p.achievements || []).some((item) => (item?.id || item) === "onboarding_first_feedback") },
  { id: "onboarding_first_marathon", name: "Primeira Maratona", icon: "🏁", test: (p) => (p.achievements || []).some((item) => (item?.id || item) === "onboarding_first_marathon") },
  { id: "correct_10", name: "10 Acertos", icon: "🥉", test: (p) => Number(p.correctAnswers || 0) >= 10 },
  { id: "correct_50", name: "50 Acertos", icon: "🥈", test: (p) => Number(p.correctAnswers || 0) >= 50 },
  { id: "correct_100", name: "100 Acertos", icon: "🥇", test: (p) => Number(p.correctAnswers || 0) >= 100 },
  { id: "correct_500", name: "500 Acertos", icon: "🏆", test: (p) => Number(p.correctAnswers || 0) >= 500 },
  { id: "level_5", name: "Nível 5", icon: "⭐", test: (p) => Number(p.level || 1) >= 5 },
  { id: "level_10", name: "Nível 10", icon: "⭐⭐", test: (p) => Number(p.level || 1) >= 10 },
  { id: "level_20", name: "Nível 20", icon: "⭐⭐⭐", test: (p) => Number(p.level || 1) >= 20 },
  { id: "combo_10", name: "Combo 10", icon: "🔥", test: (p) => Number(p.bestCombo || 0) >= 10 },
  { id: "combo_25", name: "Combo 25", icon: "🔥", test: (p) => Number(p.bestCombo || 0) >= 25 },
  { id: "combo_50", name: "Combo 50", icon: "🔥", test: (p) => Number(p.bestCombo || 0) >= 50 },
  { id: "marathon_first", name: "Primeira Maratona", icon: "🏁", test: (p) => Number(p.marathonsPlayed || 0) >= 1 },
  { id: "win_first", name: "Primeira Vitória", icon: "🥇", test: (p) => Number(p.wins || 0) >= 1 },
  { id: "wins_10", name: "10 Vitórias", icon: "👑", test: (p) => Number(p.wins || 0) >= 10 },
  { id: "mvp_first", name: "Primeiro MVP", icon: "⭐", test: (p) => Number(p.mvpCount || 0) >= 1 },
  { id: "mvp_10", name: "10 MVPs", icon: "🌟", test: (p) => Number(p.mvpCount || 0) >= 10 },
  { id: "accuracy_90_100", name: "Precisão acima de 90%", icon: "🎯", test: (p) => { const total = Number(p.correctAnswers || 0) + Number(p.wrongAnswers || 0); return total >= 100 && Number(p.correctAnswers || 0) / total * 100 > 90; } }
]);

function createPlayerAchievementService(options = {}) {
  const repository = options.repository || defaultRepository;
  const progressService = options.progressService || defaultProgressService;
  const identities = options.identityService || identityService;
  const clock = options.clock || (() => new Date());

  function normalizedUnlocks(progress) {
    return (Array.isArray(progress?.achievements) ? progress.achievements : []).map((entry) => typeof entry === "string" ? { id: entry, unlockedAt: progress.updatedAt || progress.createdAt || null } : entry).filter((entry) => entry?.id);
  }

  function inspect(progress) {
    const unlocked = normalizedUnlocks(progress);
    const ids = new Set(unlocked.map((entry) => entry.id));
    const newlyUnlocked = ACHIEVEMENTS.filter((achievement) => !ids.has(achievement.id) && achievement.test(progress));
    return { unlocked, newlyUnlocked };
  }

  async function evaluateAchievements({ platform = "whatsapp", groupId, playerId, isGroup = true }) {
    const progress = isGroup ? await progressService.getPlayerProgress(platform, groupId, playerId) : await repository.getGlobalProgress(platform, playerId);
    if (!progress) return null;
    const inspected = inspect(progress);
    let saved = progress;
    if (inspected.newlyUnlocked.length) {
      const unlockedAt = clock().toISOString();
      const additions = inspected.newlyUnlocked.map((achievement) => ({ id: achievement.id, unlockedAt }));
      const updater = (current) => ({ achievements: [...normalizedUnlocks(current), ...additions.filter((item) => !normalizedUnlocks(current).some((existing) => existing.id === item.id))] });
      const result = isGroup
        ? await repository.updatePlayerProgress(platform, groupId, playerId, updater)
        : await repository.updateGlobalProgress(platform, playerId, updater);
      saved = result.progress;
    }
    return buildAchievementSummary(saved, inspected.newlyUnlocked.map((item) => item.id));
  }

  function buildAchievementSummary(progress, newlyUnlockedIds = []) {
    const unlocks = normalizedUnlocks(progress); const unlockedIds = new Set(unlocks.map((entry) => entry.id));
    const items = ACHIEVEMENTS.map((achievement) => ({ id: achievement.id, name: achievement.name, icon: achievement.icon, unlocked: unlockedIds.has(achievement.id), unlockedAt: unlocks.find((entry) => entry.id === achievement.id)?.unlockedAt || null }));
    const obtained = items.filter((item) => item.unlocked);
    const last = [...obtained].sort((left, right) => Date.parse(right.unlockedAt || 0) - Date.parse(left.unlockedAt || 0) || items.indexOf(right) - items.indexOf(left))[0] || null;
    return { items, obtained: obtained.length, total: ACHIEVEMENTS.length, lastAchievement: last, newlyUnlocked: items.filter((item) => newlyUnlockedIds.includes(item.id)) };
  }

  async function getPlayerAchievements(query) {
    const summary = await evaluateAchievements(query); if (!summary) return null;
    const progress = query.isGroup === false ? await repository.getGlobalProgress(query.platform, query.playerId) : await progressService.getPlayerProgress(query.platform, query.groupId, query.playerId);
    const name = await identities.resolveDisplayName(query.playerId, { ...(query.displayContext || {}), displayName: progress?.displayName || query.displayContext?.displayName });
    return { ...summary, name };
  }

  function formatAchievements(summary) {
    if (!summary) return "📊 Este jogador ainda não possui progresso no Quiz.";
    return ["━━━━━━━━━━━━━━━━━━━━━━", "🏅 CONQUISTAS", "━━━━━━━━━━━━━━━━━━━━━━", "", `🎮 ${summary.name}`, "", ...summary.items.flatMap((item) => [`${item.unlocked ? "✅" : "⬜"} ${item.icon} ${item.name}`, ""]), "━━━━━━━━━━━━━━", "", "Total:", `${summary.obtained} / ${summary.total}`].join("\n").trim();
  }

  return { evaluateAchievements, getPlayerAchievements, buildAchievementSummary, formatAchievements, getAchievementCatalog: () => ACHIEVEMENTS.map(({ test, ...item }) => ({ ...item })) };
}

const service = createPlayerAchievementService();
module.exports = { ...service, createPlayerAchievementService, ACHIEVEMENTS };
