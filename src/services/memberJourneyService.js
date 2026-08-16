"use strict";

const experienceDefault = require("../repositories/memberExperienceRepository");
const progressDefault = require("../repositories/playerProgressRepository");

const REWARDS = Object.freeze({
  registration_completion: { xp: 100, achievementId: "onboarding_first_step", achievementName: "Primeiro Passo", mission: "registration_completion" },
  official_trainer: { xp: 50, achievementId: "onboarding_official_trainer", achievementName: "Treinador Oficial", mission: "official_trainer" },
  first_raid: { xp: 50, achievementId: "onboarding_first_raid", achievementName: "Primeira Raid", mission: "first_raid" },
  first_event: { xp: 50, achievementId: "onboarding_first_event", achievementName: "Primeiro Evento", mission: "first_event" },
  first_quiz: { xp: 30, achievementId: "onboarding_first_quiz", achievementName: "Primeiro Quiz", mission: "first_quiz" },
  first_feedback: { xp: 20, achievementId: "onboarding_first_feedback", achievementName: "Primeiro Feedback", mission: "first_feedback" },
  first_marathon: { xp: 50, achievementId: "onboarding_first_marathon", achievementName: "Primeira Maratona", mission: "first_marathon" }
});

const MISSION_KEYS = ["registration_completion", "first_raid", "first_quiz", "first_event", "first_feedback", "first_marathon"];

function createMemberJourneyService(options = {}) {
  const experience = options.experienceRepository || experienceDefault;
  const progress = options.playerProgressRepository || progressDefault;
  const clock = options.clock || (() => new Date());
  const log = options.log || (value => console.log(`[MEMBER_EXPERIENCE] ${value}`));

  function addReward(current, reward) {
    const achievements = Array.isArray(current.achievements) ? current.achievements : [];
    const addition = achievements.some(item => (typeof item === "string" ? item : item.id) === reward.achievementId)
      ? [] : [{ id: reward.achievementId, name: reward.achievementName, unlockedAt: clock().toISOString(), source: reward.source }];
    return { xp: Number(current.xp || 0) + reward.xp, achievements: [...achievements, ...addition] };
  }

  async function grant(memberId, key, context = {}) {
    const definition = REWARDS[key];
    if (!memberId || !definition) return { granted: false, reason: "invalid_reward" };
    const claimed = await experience.claimGrant(memberId, key, { xp: definition.xp, source: key });
    if (!claimed.granted) { log("rewardAlreadyGranted=true"); return { granted: false, reason: "already_granted", grant: claimed.grant }; }
    try {
      const reward = { ...definition, source: key };
      const operationId = `member_journey:${key}:${memberId}`;
      if (context.groupId) await progress.updatePlayerProgress(context.platform || "whatsapp", context.groupId, memberId, current => addReward(current, reward), operationId);
      await progress.updateGlobalProgress(context.platform || "whatsapp", memberId, current => addReward(current, reward), operationId);
      const completed = await experience.completeGrant(memberId, key, { xp: definition.xp, achievementId: definition.achievementId, source: key });
      log("rewardGranted=true");
      return { granted: true, reward: definition, grant: completed };
    } catch (_) {
      await experience.abandonGrant?.(memberId, key).catch(() => undefined);
      log("rewardGranted=false");
      return { granted: false, reason: "temporary_failure" };
    }
  }

  async function getMissions(memberId) {
    const grants = await experience.listCompletedGrants(memberId);
    const completed = new Set(grants.map(item => item.key));
    const missions = MISSION_KEYS.map(key => ({ key, completed: completed.has(key) }));
    return { missions, completed: missions.filter(item => item.completed).length, total: missions.length };
  }

  function formatMissions(value) {
    const labels = { registration_completion: "Concluir cadastro", first_raid: "Participar da primeira Raid", first_quiz: "Jogar o primeiro Quiz", first_event: "Participar de um Evento", first_feedback: "Enviar um Feedback", first_marathon: "Participar de uma Maratona" };
    return ["🎯 MISSÕES DO TREINADOR", "", ...value.missions.map(item => `${item.completed ? "✅" : "⬜"} ${labels[item.key]}`), "", `Progresso: ${value.completed}/${value.total}`].join("\n");
  }

  return { grant, getMissions, formatMissions, getRewardCatalog: () => ({ ...REWARDS }), getMissionKeys: () => [...MISSION_KEYS] };
}

const service = createMemberJourneyService();
module.exports = { ...service, createMemberJourneyService, REWARDS, MISSION_KEYS };
