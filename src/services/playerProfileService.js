"use strict";

const defaultRepository = require("../repositories/playerProgressRepository");
const defaultProgressService = require("./playerProgressService");
const defaultRankingService = require("./playerRankingService");
const identityService = require("./identityService");
const defaultAchievementService = require("./playerAchievementService");
const defaultJourneyService = require("./memberJourneyService");

function createPlayerProfileService(options = {}) {
  const repository = options.repository || defaultRepository;
  const progressService = options.progressService || defaultProgressService;
  const rankingService = options.rankingService || defaultRankingService;
  const identities = options.identityService || identityService;
  const achievementService = options.achievementService || (options.repository || options.progressService ? null : defaultAchievementService);
  const journeyService = options.memberJourneyService || (options.repository || options.progressService ? null : defaultJourneyService);

  function buildProgressBar(progressXp, requiredXp, size = 10) {
    const total = Math.max(1, Number(requiredXp) || 1);
    const current = Math.min(total, Math.max(0, Number(progressXp) || 0));
    const filled = Math.min(size, Math.max(0, Math.floor((current / total) * size)));
    return `${"🟩".repeat(filled)}${"⬜".repeat(size - filled)}`;
  }

  async function findPosition(type, platform, groupId, playerId) {
    const first = await rankingService.getRanking({ type, platform, groupId, page: 1 });
    if (first.status === "empty" || first.status === "group_required") return null;
    const pages = Math.max(1, Math.ceil(Number(first.total || 0) / 10));
    for (let page = 1; page <= pages; page += 1) {
      const result = page === 1 ? first : await rankingService.getRanking({ type, platform, groupId, page });
      const index = result.entries.findIndex((entry) => identities.identitiesMatch(entry.playerId, playerId));
      if (index >= 0) return result.start + index + 1;
    }
    return null;
  }

  async function calculateRankingPositions(platform, groupId, playerId, isGroup = true) {
    const [group, global] = await Promise.all([
      isGroup ? findPosition("group", platform, groupId, playerId) : Promise.resolve(null),
      findPosition("global", platform, null, playerId)
    ]);
    return { group, global };
  }

  async function getPlayerProfile({ platform = "whatsapp", groupId, playerId, isGroup = true, displayContext = {} }) {
    const progress = isGroup
      ? await progressService.getPlayerProgress(platform, groupId, playerId)
      : await repository.getGlobalProgress(platform, playerId);
    if (!progress) return null;
    const name = await identities.resolveDisplayName(playerId, { ...displayContext, displayName: progress.displayName || displayContext.displayName });
    const nextLevel = progressService.getNextLevelProgress(progress.xp);
    const accuracy = progressService.getPlayerAccuracy(progress);
    const rankings = await calculateRankingPositions(platform, groupId, playerId, isGroup);
    const achievements = achievementService ? await achievementService.evaluateAchievements({ platform, groupId, playerId, isGroup }) : { obtained: 0, total: 23, lastAchievement: null };
    const journey = journeyService ? await journeyService.getMissions(playerId) : null;
    return { ...progress, name, level: nextLevel.level, nextLevel, accuracy, rankings, achievements, journey };
  }

  function formatPercent(value) { return `${Number(value || 0).toFixed(1).replace(".", ",")}%`; }
  function formatProfile(profile) {
    if (!profile) return "📊 Este jogador ainda não possui progresso no Quiz.";
    const next = profile.nextLevel;
    const groupRank = profile.rankings.group ? `#${profile.rankings.group}` : "Não classificado";
    const globalRank = profile.rankings.global ? `#${profile.rankings.global}` : "Não classificado";
    return [
      "━━━━━━━━━━━━━━━━━━━━━━", "👤 PERFIL DO TREINADOR", "━━━━━━━━━━━━━━━━━━━━━━", "",
      `🎮 ${profile.name}`, "", `⭐ Nível ${profile.level}`, "", "✨ XP", `${next.currentLevelXp} / ${next.nextLevelXp}`, "", buildProgressBar(next.progressXp, next.requiredXp), "",
      "━━━━━━━━━━━━━━", "", "🏆 Estatísticas", "", "✅ Acertos", String(profile.correctAnswers || 0), "", "❌ Erros", String(profile.wrongAnswers || 0), "", "🎯 Precisão", formatPercent(profile.accuracy), "", "🔥 Combo Atual", String(profile.currentCombo || 0), "", "⚡ Melhor Combo", String(profile.bestCombo || 0), "",
      "━━━━━━━━━━━━━━", "", "🏁 Maratonas", "", "🎮 Participações", String(profile.marathonsPlayed || 0), "", "🥇 Vitórias", String(profile.wins || 0), "", "⭐ MVPs", String(profile.mvpCount || 0), "",
      "━━━━━━━━━━━━━━", "", "🏅 Conquistas", "", `Obtidas: ${profile.achievements?.obtained || 0} / ${profile.achievements?.total || 23}`, "", "Última conquista:", profile.achievements?.lastAchievement?.name || "Nenhuma", "",
      ...(profile.journey ? ["━━━━━━━━━━━━━━", "", "🎯 Jornada inicial", `${profile.journey.completed}/${profile.journey.total} missões concluídas`, ""] : []),
      "━━━━━━━━━━━━━━", "", "🏆 Ranking do Grupo", "", groupRank, "", "🌎 Ranking Global", "", globalRank, "", "━━━━━━━━━━━━━━", "", "Continue participando dos Quizzes e Maratonas para evoluir."
    ].join("\n");
  }

  return { getPlayerProfile, formatProfile, buildProgressBar, calculateRankingPositions };
}

const service = createPlayerProfileService();
module.exports = { ...service, createPlayerProfileService };
