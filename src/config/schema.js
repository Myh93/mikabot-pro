"use strict";

const { DEFAULTS, deepFreeze } = require("./defaults");

const NAMESPACES = [
  "backup", "discipline", "events", "joinRequest", "logging",
  "memberLifecycle", "menus", "moderation", "permissions", "pokemon",
  "quiz", "raids", "registration", "system", "telegram", "whatsapp"
];
const TYPES = ["boolean", "integer", "number", "string", "enum", "duration", "array", "object", "nullable"];
const SCOPES = ["runtime", "group", "platform", "community", "global", "default", "invariant"];
const SENSITIVITIES = ["public", "operational", "restricted", "secret"];
const STATUSES = ["legacy", "new", "reserved"];

const KEYS = `
system.commandPrefix
system.applicationName
system.applicationVersion
system.defaultTimezone
system.runtimeEnvironment
permissions.protectedOwnerNumber
permissions.ownerNumbers
permissions.trustedGroupCreatorNumber
permissions.adminNumbers
permissions.roleHierarchy
permissions.connectedBotIsHumanRole
joinRequest.enabled
joinRequest.pollIntervalMilliseconds
joinRequest.autoApproveAfterRegistration
joinRequest.requireCompletedRegistration
joinRequest.blockDisciplinaryRestrictions
joinRequest.orientationCooldownMinutes
joinRequest.privateFailureNotifyAdministrators
moderation.enabled
moderation.warnings.enabled
moderation.warnings.limit
moderation.warnings.finalAction
moderation.antiLink.enabled
moderation.antiLink.deleteMessage
moderation.antiLink.warnUser
moderation.antiLink.adminsBypass
moderation.antiLink.requireApproval
moderation.bans.enabled
moderation.bans.blockReentry
moderation.linkApproval.enabled
moderation.linkApproval.allowModeratorReview
moderation.linkApproval.requestExpiresDays
moderation.linkApproval.notifyAdminsPrivately
moderation.linkApproval.publishByBotOnly
moderation.antiFlood.enabled
moderation.antiSpam.enabled
discipline.communityBanThreshold
discipline.supportedPlatforms
discipline.supportedScopes
discipline.preserveRegistrationOnBan
discipline.notifyAdministratorsOnCommunityBan
memberLifecycle.removalPolicy
memberLifecycle.removalGraceDays
memberLifecycle.preserveWhileJoinRequestPending
memberLifecycle.preserveAcrossActivePlatforms
events.timezone
events.scheduler.enabled
events.scheduler.intervalMilliseconds
events.notifications.reminder24Hours.enabled
events.notifications.reminder1Hour.enabled
events.notifications.reminder30Minutes.enabled
events.notifications.reminder10Minutes.enabled
events.notifications.criticalDestination
events.notifications.importantDestination
events.notifications.normalDestination
events.notifications.administrativeDestination
events.notifications.debugDestination
quiz.enabled
quiz.timezone
quiz.cooldownSeconds
quiz.roundDurationMilliseconds
quiz.recentQuestionRetentionDays
quiz.language.display
quiz.language.accepted
quiz.questions.distribution
quiz.questions.recentPokemonWindow
quiz.scoring.easyPoints
quiz.scoring.normalPoints
quiz.scoring.hardPoints
quiz.progression.easyExperience
quiz.progression.normalExperience
quiz.progression.hardExperience
quiz.ranking.pageSize
quiz.marathon.questionDurationMilliseconds
quiz.marathon.nextQuestionDelayMilliseconds
registration.guidedFlowExpirationMinutes
registration.defaultNotificationPreferences
registration.defaultPrivacy
registration.preserveLegacyTelegramFields
telegram.officialGroupInvite
telegram.botToken
telegram.integrationEnabled
whatsapp.authenticationStrategy
whatsapp.puppeteer.noSandbox
whatsapp.puppeteer.disableSetuidSandbox
whatsapp.groupChatCacheMilliseconds
whatsapp.warningSuppressionWindowMilliseconds
whatsapp.sessionData
menus.sessionDurationMilliseconds
menus.directCommandsRemainAvailable
raids.firstPersistentNumber
raids.activeStatuses
raids.guidedFlowExpirationMinutes
raids.allowRegisteredMemberCreation
pokemon.datasetManifestPath
pokemon.datasetSchemaVersion
pokemon.blockConflictingRecords
logging.level
logging.sanitizeSensitiveData
logging.includeStackTraceForInternalErrors
logging.debugGroupIdentifiers
backup.checksumAlgorithm
backup.avoidIdenticalDuplicates
backup.retentionCount
backup.automaticBeforeMigration
`.trim().split(/\s+/);

const OWNER_MODULES = {
  system: "initialization", permissions: "permissionService", joinRequest: "joinRequestService",
  moderation: "moderationService", discipline: "disciplineService",
  memberLifecycle: "memberLeaveService", events: "eventService", quiz: "quizService",
  registration: "registrationService", telegram: "registrationGuidedFlowService",
  whatsapp: "whatsappClient", menus: "menuSessionService", raids: "raidService",
  pokemon: "pokemonDataService", logging: "logger", backup: "repositories"
};

const CURRENT_SOURCES = {
  system: "config.json/package.json", permissions: "config.json/permissionService",
  joinRequest: "joinRequestService", moderation: "moderationRepository",
  discipline: "disciplineService", memberLifecycle: "memberLifecycleRepository",
  events: "eventRepository/eventSchedulerService", quiz: "quizRepository/quiz services",
  registration: "registrationService/guidedFlowService",
  telegram: "registrationGuidedFlowService", whatsapp: "index.js/WhatsApp utilities",
  menus: "menuSessionService", raids: "raidRepository/raid services",
  pokemon: "pokemon manifest/pokemonDataService", logging: "logger utilities",
  backup: "repositories/migration scripts"
};

const INVARIANTS = new Set([
  "permissions.roleHierarchy", "permissions.connectedBotIsHumanRole",
  "joinRequest.requireCompletedRegistration", "joinRequest.blockDisciplinaryRestrictions",
  "discipline.supportedPlatforms", "discipline.supportedScopes",
  "discipline.preserveRegistrationOnBan",
  "memberLifecycle.preserveWhileJoinRequestPending",
  "memberLifecycle.preserveAcrossActivePlatforms",
  "registration.preserveLegacyTelegramFields", "whatsapp.authenticationStrategy",
  "whatsapp.sessionData", "menus.directCommandsRemainAvailable",
  "raids.firstPersistentNumber", "raids.activeStatuses",
  "raids.allowRegisteredMemberCreation", "pokemon.datasetManifestPath",
  "pokemon.datasetSchemaVersion", "pokemon.blockConflictingRecords",
  "logging.sanitizeSensitiveData", "logging.debugGroupIdentifiers",
  "backup.checksumAlgorithm", "backup.avoidIdenticalDuplicates",
  "backup.automaticBeforeMigration"
]);
const SECRETS = new Set(["telegram.botToken", "whatsapp.sessionData"]);
const RESTRICTED = new Set([
  "permissions.protectedOwnerNumber", "permissions.ownerNumbers",
  "permissions.trustedGroupCreatorNumber", "permissions.adminNumbers",
  "joinRequest.requireCompletedRegistration", "joinRequest.blockDisciplinaryRestrictions",
  "moderation.warnings.finalAction", "moderation.antiLink.adminsBypass",
  "moderation.bans.enabled", "moderation.bans.blockReentry",
  "moderation.linkApproval.allowModeratorReview",
  "moderation.linkApproval.publishByBotOnly",
  "discipline.communityBanThreshold", "discipline.preserveRegistrationOnBan",
  "memberLifecycle.removalPolicy", "memberLifecycle.removalGraceDays",
  "memberLifecycle.preserveWhileJoinRequestPending",
  "memberLifecycle.preserveAcrossActivePlatforms",
  "registration.defaultPrivacy", "registration.preserveLegacyTelegramFields",
  "telegram.officialGroupInvite", "whatsapp.authenticationStrategy",
  "logging.sanitizeSensitiveData", "logging.includeStackTraceForInternalErrors",
  "logging.debugGroupIdentifiers"
]);
const PUBLIC = new Set([
  "system.applicationName", "system.applicationVersion", "quiz.language.display",
  "quiz.language.accepted", "quiz.ranking.pageSize"
]);
const RESERVED = new Set([
  "system.applicationName", "system.applicationVersion", "system.runtimeEnvironment",
  "joinRequest.orientationCooldownMinutes",
  "joinRequest.privateFailureNotifyAdministrators",
  "discipline.notifyAdministratorsOnCommunityBan",
  "telegram.botToken", "telegram.integrationEnabled",
  "logging.level", "backup.retentionCount"
]);
const NEW = new Set([
  "system.defaultTimezone", "joinRequest.enabled", "events.scheduler.enabled",
  "logging.debugGroupIdentifiers"
]);

const ENUMS = {
  "moderation.warnings.finalAction": ["notify_admins", "remove_member", "ban_and_remove"],
  "memberLifecycle.removalPolicy": ["never", "immediate", "delayed"],
  "events.notifications.criticalDestination": ["group", "owner"],
  "events.notifications.importantDestination": ["group", "owner"],
  "events.notifications.normalDestination": ["group", "owner"],
  "events.notifications.administrativeDestination": ["group", "owner"],
  "events.notifications.debugDestination": ["owner", "logs"],
  "whatsapp.authenticationStrategy": ["LocalAuth"],
  "logging.level": ["critical", "important", "normal", "administrative", "debug"],
  "backup.checksumAlgorithm": ["sha256"]
};

const EXPLICIT_TYPES = {
  "system.commandPrefix": "string", "system.applicationName": "string",
  "system.applicationVersion": "string", "system.defaultTimezone": "string",
  "system.runtimeEnvironment": "string", "permissions.protectedOwnerNumber": "string",
  "permissions.trustedGroupCreatorNumber": "string",
  "quiz.timezone": "string", "events.timezone": "string",
  "quiz.language.display": "string", "telegram.officialGroupInvite": "string",
  "telegram.botToken": "string", "pokemon.datasetManifestPath": "string",
  "backup.retentionCount": "nullable",
  "joinRequest.autoApproveAfterRegistration": "boolean",
  "joinRequest.privateFailureNotifyAdministrators": "boolean",
  "moderation.warnings.limit": "integer",
  "moderation.linkApproval.allowModeratorReview": "boolean",
  "moderation.linkApproval.notifyAdminsPrivately": "boolean",
  "moderation.linkApproval.publishByBotOnly": "boolean",
  "discipline.notifyAdministratorsOnCommunityBan": "boolean",
  "logging.includeStackTraceForInternalErrors": "boolean",
  "quiz.questions.distribution": "object",
  "registration.defaultNotificationPreferences": "object",
  "registration.defaultPrivacy": "object"
};

function inferType(key) {
  if (EXPLICIT_TYPES[key]) return EXPLICIT_TYPES[key];
  if (ENUMS[key]) return "enum";
  if (/Milliseconds$|Minutes$/.test(key)) return "duration";
  if (/Numbers$|Platforms$|Scopes$|Statuses$|accepted$|roleHierarchy$/.test(key)) return "array";
  if (/enabled$|Enabled$|Allowed$|preserve|block|Bypass$|requireApproval$|warnUser$|deleteMessage$|noSandbox$|disableSetuidSandbox$|IsHumanRole$|Duplicates$|BeforeMigration$|Data$/.test(key)) return "boolean";
  if (/Days$|Seconds$|Threshold$|Window$|Points$|Experience$|pageSize$|SchemaVersion$|Number$/.test(key)) return "integer";
  return "string";
}

function scopesFor(key, namespace) {
  if (INVARIANTS.has(key)) return ["invariant"];
  if (key === "system.runtimeEnvironment" || key === "telegram.botToken") return ["runtime"];
  if (namespace === "moderation") return ["group"];
  if (namespace === "events") return key.includes("scheduler.interval") ? ["global", "runtime"] : ["community", "group"];
  if (namespace === "quiz") return ["global", "community", "platform", "group"];
  if (namespace === "memberLifecycle" || namespace === "discipline") return ["community"];
  if (namespace === "joinRequest") return ["global", "community", "platform", "group"];
  if (namespace === "registration" || namespace === "telegram") return ["community", "platform"];
  if (namespace === "menus" || namespace === "logging") return ["global", "runtime"];
  if (namespace === "system" || namespace === "backup") return ["global"];
  if (namespace === "whatsapp") return ["global", "runtime"];
  if (namespace === "raids") return ["global", "community", "group"];
  return ["global"];
}

function descriptionFor(key) {
  const words = key.split(".").slice(1).join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return `Configuração oficial de ${words}.`;
}

function buildDefinition(key) {
  const namespace = key.split(".")[0];
  const invariant = INVARIANTS.has(key);
  const secret = SECRETS.has(key);
  const hasDefault = Object.prototype.hasOwnProperty.call(DEFAULTS, key);
  return {
    key, namespace, description: descriptionFor(key), type: inferType(key),
    ...(hasDefault ? { defaultReference: key } : {}),
    allowedScopes: scopesFor(key, namespace),
    sensitivity: secret ? "secret" : RESTRICTED.has(key) ? "restricted" : PUBLIC.has(key) ? "public" : "operational",
    overrideAllowed: !invariant && !secret,
    status: RESERVED.has(key) ? "reserved" : NEW.has(key) ? "new" : "legacy",
    ownerModule: OWNER_MODULES[namespace],
    consumers: [OWNER_MODULES[namespace]],
    currentSource: CURRENT_SOURCES[namespace],
    invariant, secret, nullable: EXPLICIT_TYPES[key] === "nullable",
    ...(ENUMS[key] ? { allowedValues: ENUMS[key] } : {})
  };
}

const DEFINITIONS = deepFreeze(KEYS.map(buildDefinition));
const BY_KEY = new Map(DEFINITIONS.map(definition => [definition.key, definition]));

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
function getDefinition(key) {
  const definition = BY_KEY.get(String(key || ""));
  return definition ? deepFreeze(clone(definition)) : null;
}
function hasDefinition(key) { return BY_KEY.has(String(key || "")); }
function listDefinitions() {
  return deepFreeze(DEFINITIONS.filter(definition => !definition.secret).map(clone));
}
function listByNamespace(namespace) {
  if (!NAMESPACES.includes(namespace)) return deepFreeze([]);
  return deepFreeze(DEFINITIONS.filter(definition =>
    definition.namespace === namespace && !definition.secret
  ).map(clone));
}
function getDefault(key) {
  const definition = BY_KEY.get(String(key || ""));
  if (!definition || definition.secret || !definition.defaultReference) return undefined;
  return deepFreeze(clone(DEFAULTS[definition.defaultReference]));
}
function listNamespaces() { return deepFreeze([...NAMESPACES]); }

function defaultMatchesType(value, definition) {
  if (value === null) return definition.type === "nullable" || definition.nullable;
  if (definition.type === "boolean") return typeof value === "boolean";
  if (["integer", "duration"].includes(definition.type)) return Number.isInteger(value);
  if (definition.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (["string", "enum"].includes(definition.type)) return typeof value === "string";
  if (definition.type === "array") return Array.isArray(value);
  if (definition.type === "object") return value && typeof value === "object" && !Array.isArray(value);
  if (definition.type === "nullable") return value === null;
  return false;
}

function validateCatalog(definitions = DEFINITIONS, defaults = DEFAULTS) {
  const errors = [], seen = new Set();
  for (const definition of definitions) {
    if (!definition || typeof definition !== "object") { errors.push("definition_invalid"); continue; }
    if (seen.has(definition.key)) errors.push(`duplicate_key:${definition.key}`);
    seen.add(definition.key);
    if (!/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/.test(definition.key || "")) errors.push(`invalid_key:${definition.key || "redacted"}`);
    if (!NAMESPACES.includes(definition.namespace)) errors.push(`unknown_namespace:${definition.key || "redacted"}`);
    if (!TYPES.includes(definition.type)) errors.push(`unknown_type:${definition.key || "redacted"}`);
    if (!Array.isArray(definition.allowedScopes) || definition.allowedScopes.some(scope => !SCOPES.includes(scope))) errors.push(`invalid_scope:${definition.key || "redacted"}`);
    if (!SENSITIVITIES.includes(definition.sensitivity)) errors.push(`invalid_sensitivity:${definition.key || "redacted"}`);
    if (!STATUSES.includes(definition.status)) errors.push(`invalid_status:${definition.key || "redacted"}`);
    if (!definition.ownerModule) errors.push(`missing_owner:${definition.key || "redacted"}`);
    if (!definition.description) errors.push(`missing_description:${definition.key || "redacted"}`);
    if (definition.secret && definition.defaultReference) errors.push("secret_default_exposed");
    if (definition.invariant && definition.overrideAllowed) errors.push(`invariant_override:${definition.key || "redacted"}`);
    if (definition.type === "enum" && (!Array.isArray(definition.allowedValues) || !definition.allowedValues.length)) errors.push(`enum_values_missing:${definition.key || "redacted"}`);
    if (definition.type === "duration" && !/(Milliseconds|Seconds|Minutes|Days)$/.test(definition.key)) errors.push(`duration_unit_missing:${definition.key || "redacted"}`);
    if (definition.defaultReference) {
      if (!Object.prototype.hasOwnProperty.call(defaults, definition.defaultReference)) errors.push(`default_reference_missing:${definition.key || "redacted"}`);
      else if (!defaultMatchesType(defaults[definition.defaultReference], definition)) errors.push(`default_type_mismatch:${definition.key || "redacted"}`);
    }
  }
  return deepFreeze({ valid: errors.length === 0, errors, totalDefinitions: definitions.length, totalNamespaces: NAMESPACES.length });
}

module.exports = {
  getDefinition, hasDefinition, listDefinitions, listByNamespace,
  getDefault, listNamespaces, validateCatalog,
  TYPES: deepFreeze([...TYPES]), SCOPES: deepFreeze([...SCOPES]),
  SENSITIVITIES: deepFreeze([...SENSITIVITIES]),
  STATUSES: deepFreeze([...STATUSES])
};
