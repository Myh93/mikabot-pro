"use strict";

const ACTION_PERMISSIONS = Object.freeze({
  getConfiguration: "configuration.read",
  getConfigurationSource: "configuration.read",
  setConfiguration: "configuration.write",
  removeConfiguration: "configuration.remove",
  listConfigurations: "configuration.list",
  listOverrides: "configuration.list",
  validateConfiguration: "configuration.validate",
  "configuration.read": "configuration.read",
  "configuration.write": "configuration.write",
  "configuration.remove": "configuration.remove",
  "configuration.list": "configuration.list",
  "configuration.validate": "configuration.validate"
});

const PERMISSION_REQUIREMENTS = Object.freeze({
  "configuration.read": Object.freeze({ adminOnly: true }),
  "configuration.write": Object.freeze({ ownerOnly: true }),
  "configuration.remove": Object.freeze({ ownerOnly: true }),
  "configuration.list": Object.freeze({ adminOnly: true }),
  "configuration.validate": Object.freeze({ adminOnly: true })
});

function authorizationError(code, message) {
  const error = new Error(message);
  error.name = "ConfigurationAuthorizationError";
  error.code = code;
  return error;
}

function cleanString(value, lowerCase = false) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return lowerCase ? normalized.toLowerCase() : normalized;
}

function resolveScope(context) {
  const requested = cleanString(context.scope);
  const inferred = context.groupId
    ? "group"
    : context.communityId && context.platform
      ? "communityPlatform"
      : context.platform
        ? "platform"
        : context.communityId
          ? "community"
          : "global";
  const scope = requested || inferred;
  if (!["global", "community", "platform", "communityPlatform", "group"].includes(scope)) {
    throw authorizationError(
      "CONFIGURATION_AUTHORIZATION_INVALID_CONTEXT",
      "Contexto de autorização de configuração inválido."
    );
  }
  return scope;
}

function normalizeContext(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw authorizationError(
      "CONFIGURATION_AUTHORIZATION_INVALID_CONTEXT",
      "Contexto de autorização de configuração inválido."
    );
  }
  const context = {
    ...input,
    communityId: cleanString(input.communityId),
    platform: cleanString(input.platform, true),
    groupId: cleanString(input.groupId)
  };
  const identity = input.identity || input.user || input.authorCanonical || null;
  if (!identity) {
    throw authorizationError(
      "CONFIGURATION_AUTHORIZATION_INVALID_CONTEXT",
      "O usuário do contexto de autorização é obrigatório."
    );
  }
  context.identity = identity;
  context.scope = resolveScope(context);

  if (
    context.scope === "community" && !context.communityId ||
    context.scope === "platform" && !context.platform ||
    context.scope === "communityPlatform" && (!context.communityId || !context.platform) ||
    context.scope === "group" && !context.groupId
  ) {
    throw authorizationError(
      "CONFIGURATION_AUTHORIZATION_INVALID_CONTEXT",
      "O contexto obrigatório do escopo não foi informado."
    );
  }
  return Object.freeze(context);
}

function createAuthorizationCallback(permissionService, observability = null) {
  const metric = (name) => {
    try { observability?.recordMetric?.(name); } catch (_) {}
  };
  const event = (name, payload) => {
    try { observability?.emit?.(name, payload); } catch (_) {}
  };
  if (
    !permissionService ||
    typeof permissionService.resolveRole !== "function" ||
    typeof permissionService.hasPermission !== "function"
  ) {
    throw authorizationError(
      "CONFIGURATION_AUTHORIZATION_INTERNAL_ERROR",
      "Serviço de permissão indisponível."
    );
  }

  return async function authorize(action, inputContext) {
    const permission = ACTION_PERMISSIONS[action];
    if (!permission) {
      throw authorizationError(
        "CONFIGURATION_AUTHORIZATION_INVALID_CONTEXT",
        "Ação administrativa de configuração desconhecida."
      );
    }
    const context = normalizeContext(inputContext);
    try {
      const role = await permissionService.resolveRole(context);
      const allowed = await permissionService.hasPermission(
        role,
        PERMISSION_REQUIREMENTS[permission]
      );
      if (!allowed) {
        metric("configuration.authorization.denied");
        event("configuration.authorization.denied", {
          scope: context.scope,
          source: "permissionService",
          operation: permission
        });
        throw authorizationError(
          "CONFIGURATION_AUTHORIZATION_DENIED",
          "Acesso administrativo à configuração negado."
        );
      }
      metric("configuration.authorization.allowed");
      return true;
    } catch (error) {
      if (error?.code === "CONFIGURATION_AUTHORIZATION_DENIED") throw error;
      metric("configuration.authorization.error");
      throw authorizationError(
        "CONFIGURATION_AUTHORIZATION_INTERNAL_ERROR",
        "Não foi possível validar a autorização da configuração."
      );
    }
  };
}

module.exports = {
  createAuthorizationCallback,
  ACTION_PERMISSIONS,
  PERMISSION_REQUIREMENTS
};
