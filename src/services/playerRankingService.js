"use strict";

const defaultRepository = require("../repositories/playerProgressRepository");
const identityService = require("./identityService");
const configurationService = require("./configurationService");

const PAGE_SIZE = configurationService.get("quiz.ranking.pageSize");
const medal = (position) => ["🥇", "🥈", "🥉"][position] || `${position + 1}.`;
const number = (value) => new Intl.NumberFormat("pt-BR").format(Number(value || 0));

function createPlayerRankingService(options = {}) {
  const repository = options.repository || defaultRepository;
  const identities = options.identityService || identityService;

  async function safeNames(entries) {
    const names = await Promise.all(entries.map((entry) => identities.resolveDisplayName(entry.playerId, { displayName: entry.displayName })));
    const trainerTotal = names.filter((name) => name === "Treinador").length;
    let trainerIndex = 0;
    return entries.map((entry, index) => ({ ...entry, publicName: names[index] === "Treinador" && trainerTotal > 1 ? `Treinador ${++trainerIndex}` : names[index] }));
  }

  const permanentSort = (left, right) => Number(right.xp || 0) - Number(left.xp || 0) || Number(right.level || 1) - Number(left.level || 1) || Number(right.correctAnswers || 0) - Number(left.correctAnswers || 0) || Number(right.wins || 0) - Number(left.wins || 0) || Number(right.mvpCount || 0) - Number(left.mvpCount || 0) || Number(right.bestCombo || 0) - Number(left.bestCombo || 0) || left.publicName.localeCompare(right.publicName, "pt-BR");
  const periodSort = (period) => (left, right) => Number(right[`${period}Xp`] || 0) - Number(left[`${period}Xp`] || 0) || Number(right[`${period}CorrectAnswers`] || 0) - Number(left[`${period}CorrectAnswers`] || 0) || Number(right[`${period}Wins`] || 0) - Number(left[`${period}Wins`] || 0) || Number(right[`${period}MvpCount`] || 0) - Number(left[`${period}MvpCount`] || 0) || left.publicName.localeCompare(right.publicName, "pt-BR");

  async function getRanking({ type = "group", platform = "whatsapp", groupId = null, page = 1 } = {}) {
    const pageNumber = Number(page);
    if (!Number.isInteger(pageNumber) || pageNumber < 1) return { status: "invalid_page", entries: [] };
    let source;
    if (type === "group") {
      if (!groupId) return { status: "group_required", entries: [] };
      source = await repository.listGroupProgress(platform, groupId);
    } else if (type === "global") source = await repository.listGlobalProgress(platform);
    else if (type === "weekly") source = await repository.listWeeklyProgress(platform, groupId);
    else if (type === "monthly") source = await repository.listMonthlyProgress(platform, groupId);
    else throw new Error(`Tipo de ranking inválido: ${type}.`);
    const named = await safeNames(source);
    const sorted = named.sort(type === "weekly" ? periodSort("weekly") : type === "monthly" ? periodSort("monthly") : permanentSort);
    const start = (pageNumber - 1) * PAGE_SIZE;
    return { status: start >= sorted.length && sorted.length ? "page_empty" : sorted.length ? "ok" : "empty", type, page: pageNumber, total: sorted.length, entries: sorted.slice(start, start + PAGE_SIZE), start };
  }

  function formatRanking(result) {
    if (result.status === "invalid_page" || result.status === "page_empty") return "❌ Esta página não possui jogadores.";
    const titles = { group: "🏆 *RANKING DO GRUPO*", global: "🌎 *RANKING GLOBAL*", weekly: "📅 *RANKING SEMANAL*", monthly: "🗓️ *RANKING MENSAL*" };
    if (result.status === "empty") return result.type === "group" ? "📊 Ainda não há jogadores no ranking deste grupo." : "📊 Ainda não há jogadores neste ranking.";
    const lines = [titles[result.type], ""];
    result.entries.forEach((entry, index) => {
      const position = result.start + index;
      lines.push(`${medal(position)} *${entry.publicName}*`);
      if (result.type === "weekly" || result.type === "monthly") {
        const field = result.type === "weekly" ? "weeklyXp" : "monthlyXp";
        lines.push(`${result.type === "weekly" ? "📅" : "🗓️"} ${number(entry[field])} XP ${result.type === "weekly" ? "nesta semana" : "neste mês"}`, `✅ ${number(entry[`${result.type}CorrectAnswers`])} acertos`);
      } else lines.push(`⭐ Nível ${entry.level}`, `✨ ${number(entry.xp)} XP`, `✅ ${number(entry.correctAnswers)} acertos`, `🏆 ${number(entry.wins)} vitórias`);
      lines.push("");
    });
    if (result.total > PAGE_SIZE) lines.push(`📊 Mostrando os ${result.entries.length} melhores de ${result.total} jogadores. Página ${result.page}.`);
    return lines.join("\n").trim();
  }

  async function renderRanking(query) { return formatRanking(await getRanking(query)); }
  return { getRanking, renderRanking, formatRanking, permanentSort, periodSort, PAGE_SIZE };
}

const service = createPlayerRankingService();
module.exports = { ...service, createPlayerRankingService, PAGE_SIZE };
