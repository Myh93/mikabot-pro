"use strict";

const quizServiceDefault = require("../services/quizService");
const quizRepositoryDefault = require("../repositories/quizRepository");
const quizAnswerDefault = require("../events/quizAnswer");
const identityService = require("../services/identityService");
const registrationServiceDefault = require("../services/registrationService");
const { createPlatformContext } = require("../utils/platformContext");
const { logDetailedError } = require("../../utils/logger");
const menuRegistryDefault = require("../services/menuRegistry");
const localeService = require("../services/pokemonLocaleService");

const HELP = [
  "❓ *AJUDA DO QUIZ*",
  "",
  "• Use !jogar quiz para iniciar uma rodada coletiva.",
  "• Responda sem usar ! ou use !responder como compatibilidade.",
  "• Na coletiva, a primeira resposta correta vence.",
  "• No individual, você possui três tentativas.",
  "🌐 Você pode responder em português ou inglês.",
  "• Exemplos: Sombrio ou Dark; Água ou Water; Dragão ou Dragon; Fogo ou Fire.",
  "• Use !ranking quiz e !perfil quiz para consultar resultados."
].join("\n");

function createQuizCommand(options = {}) {
  const quizService = options.quizService || quizServiceDefault;
  const quizRepository = options.quizRepository || quizRepositoryDefault;
  const quizAnswer = options.quizAnswer || quizAnswerDefault;
  const menuRegistry = options.menuRegistry || menuRegistryDefault;
  const registrationService = options.registrationService || registrationServiceDefault;

  function formatQuestion(question, individual) {
    const lines = ["🎮 *QUIZ POKÉMON*", "", question.prompt];
    if (question.options.length) {
      lines.push("", ...question.options.map((option) => `${option.key}) ${option.value}`));
    }
    lines.push(
      "",
      `🎯 Dificuldade: ${localeService.translateDifficulty(question.difficulty)}`,
      `🏆 Vale: ${question.points} pontos`,
      "⏳ Tempo: 2 minutos",
      "",
      individual ? "Você possui 3 tentativas. Responda sem usar !." : "Responda sem usar !. A primeira resposta correta vence."
    );
    return lines.join("\n");
  }

  async function displayName(userId) {
    const registration = await registrationService.getRegistrationByIdentity(userId);
    const name = identityService.validPublicName(registration?.name) || identityService.validPublicName(registration?.nick);
    return name || `Treinador ${identityService.maskIdentity(userId)}`;
  }

  async function execute(client, msg, args, loaderContext = {}) {
    const context = loaderContext.platformContext || await createPlatformContext(client, msg);
    const commandName = loaderContext.commandName || "quiz";
    try {
      await quizAnswer.expireIfNeeded(context);

      if (commandName === "quiz") return menuRegistry.openMenuFromCommand("quiz", client, msg, { ...loaderContext, platformContext: context });

      if (commandName === "jogar quiz") {
        if (!context.isGroup) return context.replyText("❌ O Quiz coletivo só pode ser iniciado em grupos.");
        const individual = args[0]?.toLowerCase() === "individual";
        const started = individual
          ? await quizService.startIndividualRound(context, { durationMs: 120_000 })
          : await quizService.startCollectiveRound(context, { durationMs: 120_000 });
        return context.replyText(formatQuestion(started.question, individual));
      }

      if (commandName === "ranking quiz") {
        if (!context.isGroup) return context.replyText("❌ O ranking do grupo só pode ser consultado em grupos.");
        const ranking = await quizRepository.getGroupRanking(context.platform, context.groupId, 10);
        if (!ranking.length) return context.replyText("🏆 *RANKING DO QUIZ*\n\nAinda não há participantes no ranking deste grupo.");
        const names = await Promise.all(ranking.map(entry => displayName(entry.userId)));
        const lines = ranking.map((entry, index) => `${index + 1}. ${names[index]} — ${entry.points} pontos`);
        return context.replyText(["🏆 *RANKING DO QUIZ*", "", ...lines].join("\n"));
      }

      if (commandName === "perfil quiz") {
        const profile = await quizRepository.getUserProfile(context.platform, context.groupId, context.userId);
        return context.replyText([
          "📊 *SEU PERFIL NO QUIZ*",
          "",
          `🏆 Pontos: ${profile.points}`,
          `✅ Acertos no Quiz: ${profile.correctAnswers}`,
          `❌ Erros: ${profile.wrongAnswers}`,
          `🎮 Partidas: ${profile.gamesPlayed}`,
          `🥇 Vitórias: ${profile.wins}`,
          `🔥 Sequência atual no Quiz: ${profile.currentStreak}`,
          `⭐ Melhor sequência: ${profile.bestStreak}`
        ].join("\n"));
      }

      if (commandName === "proximo quiz") return context.replyText("⏰ Nenhum Quiz programado neste grupo.");
      if (commandName === "ajuda quiz") return context.replyText(HELP);

      if (commandName === "responder") {
        const answer = args.join(" ").trim();
        if (!answer) return context.replyText("❌ Informe uma resposta. Exemplo: !responder Pikachu");
        return quizAnswer.handleQuizAnswer({ client, msg, context, text: answer });
      }
    } catch (error) {
      logDetailedError(`Erro no comando ${commandName}:`, error);
      if (commandName === "jogar quiz") return context.replyText("❌ Não foi possível iniciar o Quiz agora. Tente novamente.");
      return context.replyText("❌ Não foi possível processar o Quiz agora. Tente novamente.");
    }
  }

  return {
    name: "quiz",
    aliases: ["jogar quiz", "perfil quiz", "proximo quiz", "ajuda quiz", "responder"],
    execute
  };
}

const command = createQuizCommand();
module.exports = { ...command, createQuizCommand, HELP };
