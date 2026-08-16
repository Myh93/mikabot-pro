"use strict";

const configurationServiceDefault = require("./configurationService");

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function administrationError(code, message) {
  const error = new Error(message);
  error.name = "ConfigurationAdministrationError";
  error.code = code;
  return error;
}

function createConfigurationAdministrationService(options = {}) {
  const configurationService = options.configurationService || configurationServiceDefault;
  const authorize = options.authorize;
  const clock = options.clock || (() => new Date());

  if (typeof authorize !== "function") {
    throw administrationError(
      "CONFIGURATION_AUTHORIZER_REQUIRED",
      "Um callback externo de autorização é obrigatório."
    );
  }

  async function ensureAuthorized(action, context = {}, details = {}) {
    const allowed = await authorize(action, deepFreeze(clone({ ...context, ...details })));
    if (!allowed) {
      throw administrationError(
        "CONFIGURATION_ADMINISTRATION_DENIED",
        "Operação de configuração não autorizada."
      );
    }
  }

  function auditContext(context = {}, reason) {
    const author = String(context.authorCanonical || "").trim();
    if (!author) {
      throw administrationError(
        "CONFIGURATION_AUDIT_AUTHOR_REQUIRED",
        "O autor canônico é obrigatório para alterações."
      );
    }
    return {
      ...context,
      audit: {
        author,
        origin: String(context.origin || "configurationAdministrationService").trim(),
        ...(reason ? { reason: String(reason).trim() } : {}),
        date: clock().toISOString()
      }
    };
  }

  function requireReason(reason) {
    const normalized = String(reason || "").trim();
    if (!normalized) {
      throw administrationError(
        "CONFIGURATION_REASON_REQUIRED",
        "O motivo é obrigatório para esta operação."
      );
    }
    return normalized;
  }

  async function getConfiguration(key, context = {}) {
    await ensureAuthorized("getConfiguration", context, { key });
    return configurationService.getResolved(key, context);
  }

  async function setConfiguration(key, value, context = {}) {
    await ensureAuthorized("setConfiguration", context, { key });
    const schema = configurationService.getSchema(key);
    const reason = schema.sensitivity === "restricted"
      ? requireReason(context.reason)
      : String(context.reason || "").trim();
    return configurationService.setPersistent(
      key,
      value,
      auditContext(context, reason)
    );
  }

  async function removeConfiguration(key, context = {}) {
    await ensureAuthorized("removeConfiguration", context, { key });
    configurationService.getSchema(key);
    const reason = requireReason(context.reason);
    return configurationService.removePersistentOverride(
      key,
      auditContext(context, reason)
    );
  }

  async function listConfigurations(context = {}) {
    await ensureAuthorized("listConfigurations", context);
    return deepFreeze(configurationService.listKeys().map((key) => {
      const resolved = configurationService.getResolved(key, context);
      return {
        key,
        value: clone(resolved.value),
        source: resolved.source,
        schema: clone(configurationService.getSchema(key))
      };
    }));
  }

  async function listOverrides(context = {}) {
    await ensureAuthorized("listOverrides", context);
    return configurationService.listPersistentOverrides(context);
  }

  async function getConfigurationSource(key, context = {}) {
    await ensureAuthorized("getConfigurationSource", context, { key });
    return configurationService.getResolved(key, context).source;
  }

  async function validateConfiguration(key, value, context = {}) {
    await ensureAuthorized("validateConfiguration", context, { key });
    return configurationService.validatePersistent(key, value, context);
  }

  return Object.freeze({
    getConfiguration,
    setConfiguration,
    removeConfiguration,
    listConfigurations,
    listOverrides,
    getConfigurationSource,
    validateConfiguration
  });
}

module.exports = { createConfigurationAdministrationService };
