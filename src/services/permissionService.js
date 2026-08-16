const fs = require("fs");
const path = require("path");
const config = require("../../config.json");
const identityService = require("./identityService");
const configurationServiceDefault = require("./configurationService");

const DEFAULT_ROLES_FILE = path.join(__dirname, "..", "database", "roles.json");
const ROLE_RANK = {
  member: 0,
  moderator: 1,
  admin: 2,
  trustedGroupCreator: 3,
  owner: 4,
  protectedOwner: 5
};

function createPermissionService(settings = config, options = {}) {
  const identities = options.identityService || identityService;
  const rolesFile = options.rolesFile || DEFAULT_ROLES_FILE;
  const configurationService = Object.prototype.hasOwnProperty.call(options, "configurationService")
    ? options.configurationService
    : configurationServiceDefault;

  function resolveAdministrativeSetting(key, legacyKey, expectedType) {
    try {
      const value = configurationService?.getResolved?.(key)?.value;
      if (expectedType === "array" && Array.isArray(value)) return value;
      if (expectedType === "string" && typeof value === "string" && value.trim()) {
        return value;
      }
    } catch (_) {
      // Falha na infraestrutura nunca impede a autorização legada.
    }
    return settings[legacyKey];
  }

  function isProtectedOwner(identity) {
    return identities.identitiesMatch(
      identity,
      resolveAdministrativeSetting(
        "permissions.protectedOwnerNumber",
        "protectedOwnerNumber",
        "string"
      )
    );
  }

  function isOwner(identity) {
    const ownerNumbers = resolveAdministrativeSetting(
      "permissions.ownerNumbers",
      "ownerNumbers",
      "array"
    );
    return (ownerNumbers || []).some(ownerNumber =>
      identities.identitiesMatch(identity, ownerNumber)
    );
  }

  function isGroupContext(context) {
    return Boolean(
      context.chat?.isGroup ||
      (typeof context.msg?.from === "string" && context.msg.from.endsWith("@g.us"))
    );
  }

  function findParticipant(identity, context) {
    if (context.participant) return context.participant;
    if (!Array.isArray(context.chat?.participants)) return null;
    return context.chat.participants.find(participant =>
      identities.identitiesMatch(identity, participant.id)
    ) || null;
  }

  function isTrustedGroupCreator(identity, context = {}) {
    if (!isGroupContext(context)) return false;
    const trustedGroupCreatorNumber = resolveAdministrativeSetting(
      "permissions.trustedGroupCreatorNumber",
      "trustedGroupCreatorNumber",
      "string"
    );
    if (!identities.identitiesMatch(identity, trustedGroupCreatorNumber)) return false;
    const participant = findParticipant(identity, context);
    return Boolean(participant?.isSuperAdmin);
  }

  function isGroupAdmin(identity, context = {}) {
    if (!isGroupContext(context)) return false;
    const participant = findParticipant(identity, context);
    return Boolean(participant?.isAdmin || participant?.isSuperAdmin);
  }

  function isConfiguredAdmin(identity, context = {}) {
    if (!isGroupContext(context)) return false;
    const adminNumbers = resolveAdministrativeSetting(
      "permissions.adminNumbers",
      "adminNumbers",
      "array"
    );
    return (adminNumbers || []).some(adminNumber =>
      identities.identitiesMatch(identity, adminNumber)
    );
  }

  function isModerator(identity, context = {}) {
    if (!isGroupContext(context) || !fs.existsSync(rolesFile)) return false;
    const roles = JSON.parse(fs.readFileSync(rolesFile, "utf8") || "{}");
    return (roles.mods || []).some(moderatorId =>
      identities.identitiesMatch(identity, moderatorId)
    );
  }

  function getConnectedBotIdentity(client) {
    return client?.info?.wid ||
      client?.info?.me ||
      client?.info?.id ||
      null;
  }

  function createRole(name, identity, participant = null) {
    return {
      name,
      rank: ROLE_RANK[name],
      identity,
      participant,
      isProtectedOwner: name === "protectedOwner",
      isOwner: name === "protectedOwner" || name === "owner",
      isAdmin: ROLE_RANK[name] >= ROLE_RANK.admin,
      isModerator: ROLE_RANK[name] >= ROLE_RANK.moderator
    };
  }

  async function resolveRole(context = {}) {
    const identity = context.identity ||
      await identities.resolveIdentity(context.msg, context.contact);
    const participant = findParticipant(identity, context);
    const enrichedContext = { ...context, participant };
    const botIdentity = getConnectedBotIdentity(context.client);

    if (botIdentity && identities.identitiesMatch(identity, botIdentity)) {
      return createRole("member", identity, participant);
    }
    if (isProtectedOwner(identity)) {
      return createRole("protectedOwner", identity, participant);
    }
    if (isOwner(identity)) {
      return createRole("owner", identity, participant);
    }
    if (isTrustedGroupCreator(identity, enrichedContext)) {
      return createRole("trustedGroupCreator", identity, participant);
    }
    if (
      isConfiguredAdmin(identity, enrichedContext) ||
      isGroupAdmin(identity, enrichedContext)
    ) {
      return createRole("admin", identity, participant);
    }
    if (isModerator(identity, enrichedContext)) {
      return createRole("moderator", identity, participant);
    }
    return createRole("member", identity, participant);
  }

  function hasPermission(role, commandOrPermission = {}) {
    const requirement = typeof commandOrPermission === "string"
      ? { [commandOrPermission]: true }
      : commandOrPermission;

    if (requirement.protectedOwnerOnly) return role.name === "protectedOwner";
    if (requirement.ownerOnly) return role.rank >= ROLE_RANK.owner;
    if (requirement.adminOnly) return role.rank >= ROLE_RANK.admin;
    if (requirement.moderatorOnly) return role.rank >= ROLE_RANK.moderator;
    return true;
  }

  return {
    resolveRole,
    hasPermission,
    isProtectedOwner,
    isOwner,
    isTrustedGroupCreator,
    isGroupAdmin,
    isModerator
  };
}

const defaultPermissionService = createPermissionService();

module.exports = {
  ...defaultPermissionService,
  createPermissionService,
  ROLE_RANK
};
