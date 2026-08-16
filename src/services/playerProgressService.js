"use strict";

const defaultRepository = require("../repositories/playerProgressRepository");
const identityService = require("./identityService");

const XP_BY_DIFFICULTY = Object.freeze({ easy: 10, normal: 15, hard: 20 });

function createPlayerProgressService(options = {}) {
  const repository = options.repository || defaultRepository;
  const identities = options.identityService || identityService;

  function getXpForLevel(level) {
    const normalized = Math.max(1, Math.floor(Number(level) || 1));
    return 50 * (normalized - 1) * normalized;
  }

  function calculateLevel(totalXp) {
    const xp = Math.max(0, Number(totalXp) || 0);
    return Math.max(1, Math.floor((1 + Math.sqrt(1 + (2 * xp) / 25)) / 2));
  }

  function getNextLevelProgress(totalXp) {
    const currentLevelXp = Math.max(0, Number(totalXp) || 0);
    const level = calculateLevel(currentLevelXp);
    const levelStartXp = getXpForLevel(level);
    const nextLevelXp = getXpForLevel(level + 1);
    return { level, currentLevelXp, levelStartXp, nextLevelXp, progressXp: currentLevelXp - levelStartXp, requiredXp: nextLevelXp - levelStartXp };
  }

  async function resolvePublicPlayerName(identity, context = {}) {
    return identities.resolveDisplayName(identity, context);
  }

  function operationId(context, action) {
    const roundId = context.roundId || context.marathonId;
    if (!context.platform || !context.groupId || !roundId || !context.playerId) throw new Error("Identificadores de progressão incompletos.");
    return `${context.platform}:${context.groupId}:${roundId}:${context.playerId}:${action}`;
  }

  function applyChanges(current, changes) {
    const next = { ...current };
    for (const field of ["xp", "correctAnswers", "wrongAnswers", "wins", "mvpCount", "marathonsPlayed", "marathonsFinished"]) next[field] = Math.max(0, Number(next[field] || 0) + Number(changes[field] || 0));
    if (changes.correct) {
      next.currentCombo = Number(next.currentCombo || 0) + 1;
      next.bestCombo = Math.max(Number(next.bestCombo || 0), next.currentCombo);
      next.firstCorrectAt ||= changes.at;
      next.lastCorrectAt = changes.at;
    }
    if (changes.wrong) next.currentCombo = 0;
    next.lastAnsweredAt = changes.answered ? changes.at : next.lastAnsweredAt;
    next.level = calculateLevel(next.xp);
    if (changes.displayName) next.displayName = changes.displayName;
    return next;
  }

  async function applyToScopes(context, action, changes) {
    const id = operationId(context, action);
    const previous = await repository.getOrCreatePlayerProgress(context.platform, context.groupId, context.playerId, context.displayName);
    const group = await repository.updatePlayerProgress(context.platform, context.groupId, context.playerId, (current) => applyChanges(current, changes), id);
    await repository.updateGlobalProgress(context.platform, context.playerId, (current) => applyChanges(current, changes), id);
    return { progress: group.progress, applied: group.applied, previousLevel: previous.level, newLevel: group.progress.level, leveledUp: group.applied && previous.level < group.progress.level };
  }

  async function registerCorrectAnswer(context) {
    const difficulty = String(context.difficulty || "normal").toLowerCase();
    const xp = XP_BY_DIFFICULTY[difficulty];
    if (!xp) throw new Error(`Dificuldade inválida para XP: ${difficulty}.`);
    const at = context.at || new Date().toISOString();
    return { ...(await applyToScopes(context, "correct", { xp, correctAnswers: 1, correct: true, answered: true, at, displayName: context.displayName })), xpAwarded: xp };
  }
  async function registerWrongAnswer(context) { return applyToScopes(context, "wrong", { wrongAnswers: 1, wrong: true, answered: true, at: context.at || new Date().toISOString(), displayName: context.displayName }); }
  async function awardQuizResult(context) { return context.correct ? registerCorrectAnswer(context) : registerWrongAnswer(context); }
  async function registerMarathonParticipation(context) { return applyToScopes(context, "played", { marathonsPlayed: 1, at: context.at || new Date().toISOString(), displayName: context.displayName }); }
  async function registerMarathonCompletion(context) { return applyToScopes(context, "finished", { marathonsFinished: 1, at: context.at || new Date().toISOString(), displayName: context.displayName }); }
  async function registerMarathonWin(context) { return applyToScopes(context, "win", { wins: 1, at: context.at || new Date().toISOString(), displayName: context.displayName }); }
  async function registerMvp(context) { return applyToScopes(context, "mvp", { mvpCount: 1, at: context.at || new Date().toISOString(), displayName: context.displayName }); }
  const getPlayerProgress = (platform, groupId, playerId) => repository.getPlayerProgress(platform, groupId, playerId);
  function getPlayerAccuracy(progress) { const total = Number(progress?.correctAnswers || 0) + Number(progress?.wrongAnswers || 0); return total ? Number(progress.correctAnswers || 0) / total * 100 : 0; }

  return { awardQuizResult, registerCorrectAnswer, registerWrongAnswer, registerMarathonParticipation, registerMarathonCompletion, registerMarathonWin, registerMvp, getPlayerProgress, getPlayerAccuracy, calculateLevel, getXpForLevel, getNextLevelProgress, resolvePublicPlayerName };
}

const service = createPlayerProgressService();
module.exports = { ...service, createPlayerProgressService, XP_BY_DIFFICULTY };
