"use strict";

const quizServiceDefault = require("../services/quizService");
const quizRepositoryDefault = require("../repositories/quizRepository");
const { logDetailedError } = require("../../utils/logger");
const { createPlatformContext } = require("../utils/platformContext");
const localeService = require("../services/pokemonLocaleService");
const quizMarathonServiceDefault = require("../services/quizMarathonService");
const identityService = require("../services/identityService");

function createQuizAnswerHandler(options = {}) {
  const quizService = options.quizService || quizServiceDefault;
  const quizRepository = options.quizRepository || quizRepositoryDefault;
  const quizMarathonService = options.quizMarathonService || quizMarathonServiceDefault;

  function safeName(context) {
    return context.displayName || "Participante";
  }

  async function announceResult(context, result) {
    switch (result?.status) {
      case "correct": {
        const profile = await quizRepository.getUserProfile(context.platform, context.groupId, result.winnerId);
        const correctAnswer = localeService.translateAnswer(result.round?.displayAnswer || result.round?.question?.displayAnswer || result.round?.acceptedAnswers?.[0] || "resposta correta");
        await context.replyText([
          "🎉 *RESPOSTA CORRETA!*",
          "",
          `👤 Vencedor: ${safeName(context)}`,
          `✅ Resposta: ${correctAnswer}`,
          `🏆 Pontos: +${result.pointsAwarded}`,
          `🔥 Sequência: ${profile.currentStreak}`
        ].join("\n"));
        if (result.progression?.leveledUp) {
          const name = await identityService.resolveDisplayName(result.winnerId, { msg: context.msg, contact: context.contact, displayName: context.displayName });
          await context.replyText(["━━━━━━━━━━━━━━━━━━━━━━", "🎉 *SUBIU DE NÍVEL!*", "━━━━━━━━━━━━━━━━━━━━━━", "", `⭐ *${name} alcançou o nível ${result.progression.newLevel}!*`, "", "Continue participando dos Quizzes e Maratonas para evoluir.", "━━━━━━━━━━━━━━━━━━━━━━"].join("\n"));
        }
        return true;
      }
      case "wrong":
        await context.replyText(`❌ Resposta incorreta. Você ainda tem ${result.attemptsRemaining} tentativa${result.attemptsRemaining === 1 ? "" : "s"}.`);
        return true;
      case "finished":
        if (result.reason === "attempts_exhausted") {
        await context.replyText(`❌ Suas tentativas acabaram.\n✅ Resposta correta: ${localeService.translateAnswer(result.correctAnswer)}`);
          return true;
        }
        return false;
      case "expired":
        await context.replyText(`⏳ O tempo acabou!\n✅ Resposta correta: ${localeService.translateAnswer(result.correctAnswer)}`);
        return true;
      case "ignored":
      case "not_participant":
      case "already_finished":
      case "no_active_round":
      default:
        return false;
    }
  }

  async function expireIfNeeded(context) {
    const status = await quizService.getRoundStatus(context);
    if (status.status !== "expired") return { expired: false, status };
    const result = await quizService.expireRound({ ...context, roundId: status.round.roundId });
    await announceResult(context, result);
    return { expired: true, result };
  }

  async function hasActiveRound(context) {
    const status = await quizService.getRoundStatus(context);
    return status.status === "active" || status.status === "expired";
  }

  async function handleQuizAnswer({ client, msg, context: providedContext, text }) {
    try {
      const context = providedContext || await createPlatformContext(client, msg);
      if (!context.groupId || !context.userId) return { status: "ignored" };
      const marathon = await quizMarathonService.getActiveMarathon(context);
      if (marathon) {
        const answer = text === undefined ? msg?.body : text;
        if (typeof answer !== "string" || !answer.trim()) return { status: "ignored" };
        return quizMarathonService.handleAnswer({ ...context, msg }, answer.trim(), context.replyText);
      }
      const expiration = await expireIfNeeded(context);
      if (expiration.expired) return expiration.result;
      const answer = text === undefined ? msg?.body : text;
      if (typeof answer !== "string" || !answer.trim()) return { status: "ignored" };
      const result = await quizService.submitAnswer(context, answer.trim());
      await announceResult(context, result);
      return result;
    } catch (error) {
      logDetailedError("Erro ao processar resposta do Quiz:", error);
      return { status: "error", error };
    }
  }

  return { handleQuizAnswer, announceResult, expireIfNeeded, hasActiveRound };
}

const handler = createQuizAnswerHandler();
module.exports = { ...handler, createQuizAnswerHandler };
