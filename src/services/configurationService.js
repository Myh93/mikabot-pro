"use strict";

const catalogDefault = require("../config/schema");

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

function configurationError(code, message) {
  const error = new Error(message);
  error.name = "ConfigurationError";
  error.code = code;
  return error;
}

function createConfigurationService(options = {}) {
  const catalog = options.catalog || catalogDefault;
  const runtimeValues = new Map();
  let repository = null;
  let repositoryInitialized = false;
  let persisted = emptyPersistedState();
  let persistenceQueue = Promise.resolve();
  let observability = null;

  function metric(name, amount = 1) {
    try { observability?.recordMetric?.(name, amount); } catch (_) {}
  }

  function event(name, payload) {
    try { observability?.emit?.(name, payload); } catch (_) {}
  }

  function attachObservability(candidate) {
    observability = candidate &&
      typeof candidate.recordMetric === "function" &&
      typeof candidate.emit === "function"
      ? candidate
      : null;
    return Boolean(observability);
  }

  function detachObservability() {
    const detached = Boolean(observability);
    observability = null;
    return detached;
  }

  function emptyPersistedState() {
    return {
      global: { values: {} },
      communities: { communities: {} },
      platforms: { platforms: {} },
      groups: { groups: {} }
    };
  }

  function validateKey(key) {
    const normalized = String(key || "").trim();
    if (!normalized || !catalog.hasDefinition(normalized)) {
      throw configurationError(
        "CONFIGURATION_KEY_UNKNOWN",
        "Chave de configuração desconhecida."
      );
    }
    return normalized;
  }

  function has(key) {
    return catalog.hasDefinition(String(key || "").trim());
  }

  function getSchema(key) {
    const normalized = validateKey(key);
    return deepFreeze(clone(catalog.getDefinition(normalized)));
  }

  function getDefault(key) {
    const normalized = validateKey(key);
    return deepFreeze(clone(catalog.getDefault(normalized)));
  }

  function valueMatchesSchema(value, definition) {
    if (value === null) return definition.nullable || definition.type === "nullable";
    if (definition.type === "boolean") return typeof value === "boolean";
    if (definition.type === "integer") return Number.isInteger(value);
    if (definition.type === "number") return typeof value === "number" && Number.isFinite(value);
    if (definition.type === "string") return typeof value === "string";
    if (definition.type === "enum") {
      return typeof value === "string" && definition.allowedValues.includes(value);
    }
    if (definition.type === "duration") return Number.isInteger(value) && value >= 0;
    if (definition.type === "array") return Array.isArray(value);
    if (definition.type === "object") {
      return value && typeof value === "object" && !Array.isArray(value);
    }
    if (definition.type === "nullable") return value === null;
    return false;
  }

  function validateWritableValue(key, value, errorCode = "CONFIGURATION_VALUE_INVALID") {
    const definition = catalog.getDefinition(key);
    if (!definition.overrideAllowed || definition.invariant || definition.secret) {
      throw configurationError(
        "CONFIGURATION_WRITE_FORBIDDEN",
        "Esta chave de configuração não permite escrita."
      );
    }
    if (!valueMatchesSchema(value, definition)) {
      throw configurationError(
        errorCode,
        "Valor incompatível com o schema da configuração."
      );
    }
    return definition;
  }

  function normalizedContext(context = {}) {
    return {
      communityId: String(context.communityId || "").trim(),
      platform: String(context.platform || "").trim().toLowerCase(),
      groupId: String(context.groupId || "").trim()
    };
  }

  function enqueuePersistent(operation) {
    const current = persistenceQueue.catch(() => undefined).then(operation);
    persistenceQueue = current;
    return current;
  }

  function runtimeKey(key, context = {}) {
    const normalized = normalizedContext(context);
    if (!normalized.communityId && !normalized.platform && !normalized.groupId) return key;
    return [
      key,
      normalized.communityId,
      normalized.platform,
      normalized.groupId
    ].join("|");
  }

  function ownValue(container, key) {
    if (!container || typeof container !== "object") return { found: false };
    const values = container.values;
    if (!values || typeof values !== "object" ||
        !Object.prototype.hasOwnProperty.call(values, key)) {
      return { found: false };
    }
    return { found: true, value: values[key] };
  }

  function scopeAllowed(definition, scope) {
    return Array.isArray(definition.allowedScopes) &&
      definition.allowedScopes.includes(scope);
  }

  function getResolved(key, context = {}) {
    metric("configuration.resolve.total");
    const normalized = validateKey(key);
    const definition = catalog.getDefinition(normalized);
    const resolvedContext = normalizedContext(context);
    const contextualRuntimeKey = runtimeKey(normalized, resolvedContext);

    if (runtimeValues.has(contextualRuntimeKey)) {
      metric("configuration.resolve.cacheHit");
      return deepFreeze({
        key: normalized,
        value: clone(runtimeValues.get(contextualRuntimeKey)),
        source: "runtime"
      });
    }
    if (contextualRuntimeKey !== normalized && runtimeValues.has(normalized)) {
      metric("configuration.resolve.cacheHit");
      return deepFreeze({
        key: normalized,
        value: clone(runtimeValues.get(normalized)),
        source: "runtime"
      });
    }

    if (repositoryInitialized) {
      const { communityId, platform, groupId } = resolvedContext;
      const groups = persisted.groups.groups || {};
      const communities = persisted.communities.communities || {};
      const platforms = persisted.platforms.platforms || {};
      const candidates = [];

      if (groupId && scopeAllowed(definition, "group")) {
        if (platform) candidates.push(["group", groups[`${platform}:${groupId}`]]);
        candidates.push(["group", groups[groupId]]);
      }
      if (communityId && platform &&
          scopeAllowed(definition, "community") &&
          scopeAllowed(definition, "platform")) {
        candidates.push(
          ["communityPlatform", platforms[`${communityId}:${platform}`]],
          ["communityPlatform", communities[communityId]?.platforms?.[platform]]
        );
      }
      if (platform && scopeAllowed(definition, "platform")) {
        candidates.push(["platform", platforms[platform]]);
      }
      if (communityId && scopeAllowed(definition, "community")) {
        candidates.push(["community", communities[communityId]]);
      }
      if (scopeAllowed(definition, "global")) {
        candidates.push(["global", persisted.global]);
      }

      for (const [source, container] of candidates) {
        const result = ownValue(container, normalized);
        if (result.found) {
          metric("configuration.resolve.cacheHit");
          return deepFreeze({ key: normalized, value: clone(result.value), source });
        }
      }
    }

    metric("configuration.resolve.cacheMiss");
    return deepFreeze({
      key: normalized,
      value: clone(catalog.getDefault(normalized)),
      source: "default"
    });
  }

  function get(key, context = {}) {
    return getResolved(key, context).value;
  }

  function set(key, value, context = {}) {
    const normalized = validateKey(key);
    validateWritableValue(normalized, value);
    runtimeValues.set(runtimeKey(normalized, context), deepFreeze(clone(value)));
    return get(normalized, context);
  }

  function listNamespaces() {
    return deepFreeze(clone(catalog.listNamespaces()));
  }

  function listKeys() {
    return deepFreeze(catalog.listDefinitions().map(definition => definition.key));
  }

  function validateRepository(candidate) {
    const required = [
      "initialize",
      "readGlobal",
      "readCommunities",
      "readPlatforms",
      "readGroups"
    ];
    if (!candidate || required.some(method => typeof candidate[method] !== "function")) {
      throw configurationError(
        "CONFIGURATION_REPOSITORY_INVALID",
        "Repositório de configuração inválido."
      );
    }
  }

  function attachRepository(candidate) {
    validateRepository(candidate);
    repository = candidate;
    repositoryInitialized = false;
    persisted = emptyPersistedState();
    return true;
  }

  function detachRepository() {
    const detached = Boolean(repository);
    repository = null;
    repositoryInitialized = false;
    persisted = emptyPersistedState();
    return detached;
  }

  function requireRepository() {
    if (!repository) {
      throw configurationError(
        "CONFIGURATION_REPOSITORY_NOT_ATTACHED",
        "Nenhum repositório de configuração foi anexado."
      );
    }
    return repository;
  }

  function resolvePersistentScope(context = {}) {
    const normalized = normalizedContext(context);
    const requested = String(context.scope || "").trim();
    const inferred = normalized.groupId
      ? "group"
      : normalized.communityId && normalized.platform
        ? "communityPlatform"
        : normalized.platform
          ? "platform"
          : normalized.communityId
            ? "community"
            : "global";
    const scope = requested || inferred;
    if (!["global", "community", "platform", "communityPlatform", "group"].includes(scope)) {
      throw configurationError(
        "CONFIGURATION_SCOPE_INVALID",
        "Escopo persistente inválido."
      );
    }
    if (scope === "community" && !normalized.communityId ||
        scope === "platform" && !normalized.platform ||
        scope === "communityPlatform" && (!normalized.communityId || !normalized.platform) ||
        scope === "group" && !normalized.groupId) {
      throw configurationError(
        "CONFIGURATION_SCOPE_CONTEXT_REQUIRED",
        "O contexto obrigatório do escopo não foi informado."
      );
    }
    return { scope, context: normalized };
  }

  function validatePersistentScope(definition, scope) {
    if (scope === "communityPlatform") {
      if (scopeAllowed(definition, "community") && scopeAllowed(definition, "platform")) return;
    } else if (scopeAllowed(definition, scope)) {
      return;
    }
    throw configurationError(
      "CONFIGURATION_SCOPE_INVALID",
      "Escopo persistente não permitido para a configuração."
    );
  }

  function validatePersistent(key, value, context = {}) {
    try {
      const normalized = validateKey(key);
      const definition = validateWritableValue(normalized, value);
      const scopeDetails = resolvePersistentScope(context);
      validatePersistentScope(definition, scopeDetails.scope);
      metric("configuration.validation.success");
      return deepFreeze({
        valid: true,
        key: normalized,
        scope: scopeDetails.scope,
        definition: clone(definition)
      });
    } catch (error) {
      metric("configuration.validation.failure");
      event("configuration.validation.failed", {
        key: String(key || ""),
        scope: String(context.scope || "unknown"),
        source: "configurationService",
        operation: "validate"
      });
      throw error;
    }
  }

  function auditMetadata(context = {}) {
    const metadata = context.audit;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
    const clean = {};
    for (const field of ["author", "origin", "reason", "date"]) {
      if (typeof metadata[field] === "string" && metadata[field].trim()) {
        clean[field] = metadata[field].trim();
      }
    }
    return clean;
  }

  function persistentTarget(state, scopeDetails, create = false) {
    const { scope, context } = scopeDetails;
    if (scope === "global") return state.global;
    if (scope === "community") {
      const collection = state.communities.communities;
      if (create && !collection[context.communityId]) collection[context.communityId] = { values: {} };
      return collection[context.communityId] || null;
    }
    if (scope === "platform" || scope === "communityPlatform") {
      const collection = state.platforms.platforms;
      const id = scope === "communityPlatform"
        ? `${context.communityId}:${context.platform}`
        : context.platform;
      if (create && !collection[id]) collection[id] = { values: {} };
      return collection[id] || null;
    }
    const collection = state.groups.groups;
    const id = context.platform ? `${context.platform}:${context.groupId}` : context.groupId;
    if (create && !collection[id]) collection[id] = { values: {} };
    return collection[id] || null;
  }

  async function persistStateForScope(state, scope) {
    if (scope === "global") return repository.writeGlobal(state.global);
    if (scope === "community") return repository.writeCommunities(state.communities);
    if (scope === "platform" || scope === "communityPlatform") {
      return repository.writePlatforms(state.platforms);
    }
    return repository.writeGroups(state.groups);
  }

  function historyContext(scopeDetails) {
    const { scope, context } = scopeDetails;
    return {
      scope,
      ...(context.communityId ? { communityId: context.communityId } : {}),
      ...(context.platform ? { platform: context.platform } : {}),
      ...(context.groupId ? { groupId: context.groupId } : {})
    };
  }

  async function ensureRepositoryInitialized() {
    requireRepository();
    if (!repositoryInitialized) await reload();
  }

  async function setPersistent(key, value, context = {}) {
    const validation = validatePersistent(key, value, context);
    const normalized = validation.key;
    const scopeDetails = {
      scope: validation.scope,
      context: normalizedContext(context)
    };
    return enqueuePersistent(async () => {
      await ensureRepositoryInitialized();
      const next = clone(persisted);
      const target = persistentTarget(next, scopeDetails, true);
      const previous = Object.prototype.hasOwnProperty.call(target.values, normalized)
        ? clone(target.values[normalized])
        : undefined;
      target.values[normalized] = clone(value);
      try {
        await persistStateForScope(next, scopeDetails.scope);
      } catch (error) {
        event("configuration.persistence.failed", {
          key: normalized, scope: scopeDetails.scope,
          source: "configurationRepository", operation: "write"
        });
        throw error;
      }
      metric("configuration.persistence.write");
      metric("configuration.cache.invalidations");
      persisted = next;
      await repository.appendHistory({
        action: "set",
        key: normalized,
        previousValue: previous,
        value: clone(value),
        ...auditMetadata(context),
        ...historyContext(scopeDetails)
      });
      event("configuration.changed", {
        key: normalized, scope: scopeDetails.scope,
        source: "persistent", operation: "write"
      });
      return getResolved(normalized, context);
    });
  }

  async function removePersistentOverride(key, context = {}) {
    const normalized = validateKey(key);
    const definition = catalog.getDefinition(normalized);
    if (!definition.overrideAllowed || definition.invariant || definition.secret) {
      throw configurationError(
        "CONFIGURATION_WRITE_FORBIDDEN",
        "Esta chave de configuração não permite escrita."
      );
    }
    const scopeDetails = resolvePersistentScope(context);
    validatePersistentScope(definition, scopeDetails.scope);
    return enqueuePersistent(async () => {
      await ensureRepositoryInitialized();
      const next = clone(persisted);
      const target = persistentTarget(next, scopeDetails, false);
      if (!target?.values ||
          !Object.prototype.hasOwnProperty.call(target.values, normalized)) {
        return { removed: false, resolved: getResolved(normalized, context) };
      }
      const previous = clone(target.values[normalized]);
      delete target.values[normalized];
      try {
        await persistStateForScope(next, scopeDetails.scope);
      } catch (error) {
        event("configuration.persistence.failed", {
          key: normalized, scope: scopeDetails.scope,
          source: "configurationRepository", operation: "remove"
        });
        throw error;
      }
      metric("configuration.persistence.remove");
      metric("configuration.cache.invalidations");
      persisted = next;
      await repository.appendHistory({
        action: "remove",
        key: normalized,
        previousValue: previous,
        ...auditMetadata(context),
        ...historyContext(scopeDetails)
      });
      event("configuration.removed", {
        key: normalized, scope: scopeDetails.scope,
        source: "persistent", operation: "remove"
      });
      return deepFreeze({
        removed: true,
        resolved: getResolved(normalized, context)
      });
    });
  }

  function hasPersistentOverride(key, context = {}) {
    const normalized = validateKey(key);
    const scopeDetails = resolvePersistentScope(context);
    const target = persistentTarget(persisted, scopeDetails, false);
    return Boolean(repositoryInitialized && target?.values &&
      Object.prototype.hasOwnProperty.call(target.values, normalized));
  }

  function listPersistentOverrides(context = {}) {
    const scopeDetails = resolvePersistentScope(context);
    const target = persistentTarget(persisted, scopeDetails, false);
    if (!repositoryInitialized || !target?.values) return deepFreeze([]);
    return deepFreeze(Object.entries(target.values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        value: clone(value),
        ...historyContext(scopeDetails)
      })));
  }

  async function flush() {
    await persistenceQueue.catch(() => undefined);
    if (!repository) {
      return deepFreeze({ synchronized: true, repositoryAttached: false });
    }
    await reload();
    return deepFreeze({ synchronized: true, repositoryAttached: true });
  }

  function validatePersistedValues(values, scope) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw configurationError(
        "CONFIGURATION_PERSISTED_DATA_INVALID",
        "Estrutura persistente de configuração inválida."
      );
    }
    for (const [key, value] of Object.entries(values)) {
      const normalized = validateKey(key);
      const definition = validateWritableValue(
        normalized,
        value,
        "CONFIGURATION_PERSISTED_VALUE_INVALID"
      );
      if (!scopeAllowed(definition, scope)) {
        throw configurationError(
          "CONFIGURATION_SCOPE_INVALID",
          "Escopo persistente não permitido para a configuração."
        );
      }
    }
  }

  function validateContainerCollection(collection, scope) {
    if (!collection || typeof collection !== "object" || Array.isArray(collection)) {
      throw configurationError(
        "CONFIGURATION_PERSISTED_DATA_INVALID",
        "Coleção persistente de configuração inválida."
      );
    }
    for (const [containerId, container] of Object.entries(collection)) {
      validatePersistedValues(container?.values || {}, scope);
      if (scope === "platform" && containerId.includes(":")) {
        for (const key of Object.keys(container?.values || {})) {
          const definition = catalog.getDefinition(key);
          if (!scopeAllowed(definition, "community")) {
            throw configurationError(
              "CONFIGURATION_SCOPE_INVALID",
              "Escopo persistente nÃ£o permitido para a configuraÃ§Ã£o."
            );
          }
        }
      }
      if (scope === "community" && container?.platforms) {
        for (const platformContainer of Object.values(container.platforms)) {
          validatePersistedValues(platformContainer?.values || {}, "platform");
          for (const key of Object.keys(platformContainer?.values || {})) {
            const definition = catalog.getDefinition(key);
            if (!scopeAllowed(definition, "community")) {
              throw configurationError(
                "CONFIGURATION_SCOPE_INVALID",
                "Escopo persistente não permitido para a configuração."
              );
            }
          }
        }
      }
    }
  }

  function validatePersistedState(state) {
    validatePersistedValues(state.global?.values || {}, "global");
    validateContainerCollection(state.communities?.communities || {}, "community");
    validateContainerCollection(state.platforms?.platforms || {}, "platform");
    validateContainerCollection(state.groups?.groups || {}, "group");
  }

  async function reload() {
    const startedAt = Date.now();
    metric("configuration.reload.total");
    if (!repository) {
      repositoryInitialized = false;
      persisted = emptyPersistedState();
      metric("configuration.reload.success");
      event("configuration.reload", {
        source: "memory", operation: "reload", durationMs: Date.now() - startedAt
      });
      return deepFreeze({ initialized: false, repositoryAttached: false });
    }
    try {
      await repository.initialize();
      const next = {
        global: await repository.readGlobal(),
        communities: await repository.readCommunities(),
        platforms: await repository.readPlatforms(),
        groups: await repository.readGroups()
      };
      metric("configuration.persistence.read", 4);
      validatePersistedState(next);
      persisted = clone(next);
      repositoryInitialized = true;
      metric("configuration.reload.success");
      metric("configuration.cache.invalidations");
      event("configuration.reload", {
        source: "configurationRepository", operation: "reload",
        durationMs: Date.now() - startedAt
      });
      return deepFreeze({ initialized: true, repositoryAttached: true });
    } catch (error) {
      metric("configuration.reload.failure");
      event("configuration.persistence.failed", {
        source: "configurationRepository", operation: "read",
        durationMs: Date.now() - startedAt
      });
      throw error;
    }
  }

  async function initialize() {
    if (!repository) {
      return deepFreeze({ initialized: true, repositoryAttached: false });
    }
    return reload();
  }

  return Object.freeze({
    has,
    get,
    set,
    getDefault,
    getSchema,
    getResolved,
    listKeys,
    listNamespaces,
    validateKey,
    attachObservability,
    detachObservability,
    initialize,
    attachRepository,
    detachRepository,
    reload,
    validatePersistent,
    setPersistent,
    removePersistentOverride,
    hasPersistentOverride,
    listPersistentOverrides,
    flush
  });
}

const service = createConfigurationService();
module.exports = { ...service, createConfigurationService };
