"use strict";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

const DEFAULTS = {
  "system.commandPrefix": "!",
  "system.applicationName": "MikaBot PRO",
  "system.applicationVersion": "2.0.0",
  "system.defaultTimezone": "America/Fortaleza",
  "joinRequest.enabled": true,
  "joinRequest.pollIntervalMilliseconds": 30000,
  "joinRequest.autoApproveAfterRegistration": true,
  "joinRequest.orientationCooldownMinutes": 0,
  "joinRequest.privateFailureNotifyAdministrators": true,
  "moderation.enabled": false,
  "moderation.warnings.enabled": false,
  "moderation.warnings.limit": 3,
  "moderation.antiLink.enabled": false,
  "moderation.antiLink.deleteMessage": true,
  "moderation.antiLink.warnUser": true,
  "moderation.antiLink.requireApproval": true,
  "moderation.linkApproval.enabled": false,
  "moderation.linkApproval.requestExpiresDays": 7,
  "moderation.linkApproval.notifyAdminsPrivately": true,
  "moderation.antiFlood.enabled": false,
  "moderation.antiSpam.enabled": false,
  "discipline.notifyAdministratorsOnCommunityBan": true,
  "events.timezone": "America/Fortaleza",
  "events.scheduler.enabled": true,
  "events.scheduler.intervalMilliseconds": 30000,
  "events.notifications.reminder24Hours.enabled": true,
  "events.notifications.reminder1Hour.enabled": true,
  "events.notifications.reminder30Minutes.enabled": true,
  "events.notifications.reminder10Minutes.enabled": true,
  "events.notifications.criticalDestination": "group",
  "events.notifications.importantDestination": "group",
  "events.notifications.normalDestination": "group",
  "events.notifications.administrativeDestination": "owner",
  "events.notifications.debugDestination": "owner",
  "quiz.enabled": true,
  "quiz.timezone": "UTC",
  "quiz.cooldownSeconds": 0,
  "quiz.roundDurationMilliseconds": 60000,
  "quiz.recentQuestionRetentionDays": 7,
  "quiz.language.display": "pt-BR",
  "quiz.language.accepted": ["pt-BR", "en"],
  "quiz.questions.distribution": {
    multipleChoice4: 0.20,
    multipleChoice5: 0.20,
    weaknessChoice: 0.20,
    trueFalse: 0.20,
    open: 0.20
  },
  "quiz.questions.recentPokemonWindow": 50,
  "quiz.scoring.easyPoints": 10,
  "quiz.scoring.normalPoints": 15,
  "quiz.scoring.hardPoints": 20,
  "quiz.progression.easyExperience": 10,
  "quiz.progression.normalExperience": 15,
  "quiz.progression.hardExperience": 20,
  "quiz.ranking.pageSize": 10,
  "quiz.marathon.questionDurationMilliseconds": 120000,
  "quiz.marathon.nextQuestionDelayMilliseconds": 3000,
  "registration.guidedFlowExpirationMinutes": 15,
  "registration.defaultNotificationPreferences": {
    raidNotifications: true,
    eventNotifications: true,
    quizNotifications: true,
    newsNotifications: true
  },
  "menus.sessionDurationMilliseconds": 120000,
  "raids.guidedFlowExpirationMinutes": 15,
  "backup.retentionCount": null
};

module.exports = { DEFAULTS: deepFreeze(DEFAULTS), deepFreeze };
