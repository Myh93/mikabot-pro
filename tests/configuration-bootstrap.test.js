"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createConfigurationBootstrap
} = require("../src/services/configurationBootstrapService");

function fixture(options = {}) {
  const order = [];
  const repository = options.repository === undefined ? {
    async initialize() {
      order.push("repository.initialize");
      if (options.repositoryError) throw options.repositoryError;
    }
  } : options.repository;
  const configurationService = {
    attachRepository(value) {
      order.push("configuration.attachRepository");
      assert.equal(value, repository);
    },
    async initialize() {
      order.push("configuration.initialize");
      if (options.configurationError) throw options.configurationError;
    },
    attachObservability(value) {
      order.push("configuration.attachObservability");
      if (options.observabilityError) throw options.observabilityError;
      return Boolean(value);
    },
    detachRepository() { order.push("configuration.detachRepository"); },
    detachObservability() { order.push("configuration.detachObservability"); }
  };
  const observability = Object.prototype.hasOwnProperty.call(options, "observability")
    ? options.observability
    : { recordMetric() {}, emit() {} };
  const permissionService = Object.prototype.hasOwnProperty.call(options, "permissionService")
    ? options.permissionService
    : { resolveRole() {}, hasPermission() {} };
  const errors = [];
  const bootstrap = createConfigurationBootstrap({
    repository,
    configurationService,
    observability,
    permissionService,
    createAuthorizationCallback(service, observer) {
      order.push("authorization.create");
      if (options.authorizationError) throw options.authorizationError;
      assert.equal(service, permissionService);
      assert.equal(observer, observability);
      return options.authorize === undefined ? async () => true : options.authorize;
    },
    createAdministrationService({ configurationService: received, authorize }) {
      order.push("administration.create");
      assert.equal(received, configurationService);
      if (options.administrationError) throw options.administrationError;
      if (typeof authorize !== "function") throw new Error("authorize ausente");
      return { ready: true };
    },
    logError(message, error) { errors.push({ message, error }); }
  });
  return { bootstrap, order, errors, repository, configurationService };
}

test("inicialização normal respeita a ordem oficial", async () => {
  const item = fixture();
  const result = await item.bootstrap.initialize();
  assert.deepEqual(item.order, [
    "repository.initialize",
    "configuration.attachRepository",
    "configuration.initialize",
    "configuration.attachObservability",
    "authorization.create",
    "administration.create"
  ]);
  assert.equal(result.status, "ready");
  assert.equal(result.persistenceEnabled, true);
  assert.equal(result.observabilityEnabled, true);
  assert.deepEqual(result.administrationService, { ready: true });
  assert.equal(item.errors.length, 0);
});

test("bootstrap sem repository mantém fallback degradado", async () => {
  const item = fixture({ repository: null });
  const result = await item.bootstrap.initialize();
  assert.equal(result.status, "degraded");
  assert.equal(result.persistenceEnabled, false);
  assert.equal(result.reasonCode, "CONFIGURATION_REPOSITORY_UNAVAILABLE");
  assert.deepEqual(item.order, [
    "configuration.detachRepository",
    "configuration.detachObservability"
  ]);
});

for (const [name, repositoryError] of [
  ["repository corrompido", Object.assign(new Error("corrupt"), {
    code: "CONFIGURATION_FILE_CORRUPT"
  })],
  ["schema incompatível", Object.assign(new Error("schema"), {
    code: "SCHEMA_VERSION_INCOMPATIBLE"
  })],
  ["catálogo incompatível", Object.assign(new Error("catalog"), {
    code: "CATALOG_REVISION_INCOMPATIBLE"
  })]
]) {
  test(`${name} desliga persistência e não interrompe o bot`, async () => {
    const item = fixture({ repositoryError });
    const result = await item.bootstrap.initialize();
    assert.equal(result.status, "degraded");
    assert.equal(result.persistenceEnabled, false);
    assert.equal(result.reasonCode, repositoryError.code);
    assert.equal(item.errors.length, 1);
    assert.ok(item.order.includes("configuration.detachRepository"));
  });
}

test("observador ausente é permitido sem desativar persistência", async () => {
  const item = fixture({ observability: null });
  const result = await item.bootstrap.initialize();
  assert.equal(result.status, "ready");
  assert.equal(result.persistenceEnabled, true);
  assert.equal(result.observabilityEnabled, false);
  assert.equal(item.order.includes("configuration.attachObservability"), false);
});

test("falha da observabilidade ativa fallback integral", async () => {
  const item = fixture({
    observabilityError: Object.assign(new Error("observer"), {
      code: "OBSERVABILITY_FAILURE"
    })
  });
  const result = await item.bootstrap.initialize();
  assert.equal(result.status, "degraded");
  assert.equal(result.persistenceEnabled, false);
  assert.equal(result.observabilityEnabled, false);
  assert.equal(result.reasonCode, "OBSERVABILITY_FAILURE");
});

test("callback de autorização ausente ou inválido desliga persistência", async () => {
  const item = fixture({ authorize: null });
  const result = await item.bootstrap.initialize();
  assert.equal(result.status, "degraded");
  assert.equal(result.persistenceEnabled, false);
  assert.equal(
    result.reasonCode,
    "CONFIGURATION_AUTHORIZATION_CALLBACK_UNAVAILABLE"
  );
});

test("PermissionService ausente é tratado como falha de autorização", async () => {
  const item = fixture({
    permissionService: null,
    authorizationError: Object.assign(new Error("permission"), {
      code: "CONFIGURATION_AUTHORIZATION_INTERNAL_ERROR"
    })
  });
  const result = await item.bootstrap.initialize();
  assert.equal(result.status, "degraded");
  assert.equal(result.persistenceEnabled, false);
  assert.equal(result.reasonCode, "CONFIGURATION_AUTHORIZATION_INTERNAL_ERROR");
});

test("inicializações simultâneas e repetidas são idempotentes", async () => {
  const item = fixture();
  const [first, second, third] = await Promise.all([
    item.bootstrap.initialize(),
    item.bootstrap.initialize(),
    item.bootstrap.initialize()
  ]);
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(
    item.order.filter((entry) => entry === "repository.initialize").length,
    1
  );
  assert.equal(await item.bootstrap.initialize(), first);
  assert.equal(item.bootstrap.getState(), first);
});

test("nenhum erro de log impede o fallback", async () => {
  const configurationService = {
    detachRepository() {},
    detachObservability() {}
  };
  const bootstrap = createConfigurationBootstrap({
    repository: { async initialize() { throw new Error("failure"); } },
    configurationService,
    logError() { throw new Error("logger failure"); }
  });
  const result = await bootstrap.initialize();
  assert.equal(result.status, "degraded");
  assert.equal(result.persistenceEnabled, false);
});
