"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createConfigurationObservabilityService
} = require("../src/services/configurationObservabilityService");
const {
  createConfigurationService
} = require("../src/services/configurationService");
const {
  createAuthorizationCallback
} = require("../src/services/configurationAuthorizationAdapter");

function observer() {
  return createConfigurationObservabilityService({
    clock: () => new Date("2026-07-30T12:00:00.000Z")
  });
}

test("serviço ausente não altera resolução, validação ou runtime", () => {
  const service = createConfigurationService();
  assert.equal(service.get("quiz.ranking.pageSize"), 10);
  assert.equal(service.validatePersistent("quiz.ranking.pageSize", 20).valid, true);
  service.set("quiz.ranking.pageSize", 30);
  assert.equal(service.get("quiz.ranking.pageSize"), 30);
  assert.equal(service.detachObservability(), false);
});

test("registra cache miss, cache hit e total de resoluções", () => {
  const service = createConfigurationService();
  const observed = observer();
  assert.equal(service.attachObservability(observed), true);
  service.get("quiz.ranking.pageSize");
  service.set("quiz.ranking.pageSize", 30);
  service.get("quiz.ranking.pageSize");
  assert.deepEqual({
    total: observed.getMetrics()["configuration.resolve.total"],
    hits: observed.getMetrics()["configuration.resolve.cacheHit"],
    misses: observed.getMetrics()["configuration.resolve.cacheMiss"]
  }, { total: 3, hits: 2, misses: 1 });
});

test("registra validação bem-sucedida e falha estruturada", () => {
  const service = createConfigurationService();
  const observed = observer();
  service.attachObservability(observed);
  service.validatePersistent("quiz.ranking.pageSize", 20);
  assert.throws(() => service.validatePersistent("quiz.ranking.pageSize", "20"));
  const metrics = observed.getMetrics();
  assert.equal(metrics["configuration.validation.success"], 1);
  assert.equal(metrics["configuration.validation.failure"], 1);
  assert.equal(observed.getEvents()[0].event, "configuration.validation.failed");
});

test("registra reload, leituras e invalidação sem expor conteúdo", async () => {
  const service = createConfigurationService();
  const observed = observer();
  service.attachObservability(observed);
  const repository = {
    async initialize() {},
    async readGlobal() { return { values: {} }; },
    async readCommunities() { return { communities: {} }; },
    async readPlatforms() { return { platforms: {} }; },
    async readGroups() { return { groups: {} }; }
  };
  service.attachRepository(repository);
  await service.reload();
  const metrics = observed.getMetrics();
  assert.equal(metrics["configuration.reload.total"], 1);
  assert.equal(metrics["configuration.reload.success"], 1);
  assert.equal(metrics["configuration.persistence.read"], 4);
  assert.equal(metrics["configuration.cache.invalidations"], 1);
  assert.equal(observed.getEvents()[0].event, "configuration.reload");
});

test("registra autorização permitida, negada e erro interno", async () => {
  const observed = observer();
  const context = { identity: "canonical-owner" };
  await createAuthorizationCallback({
    async resolveRole() { return { name: "owner", rank: 4 }; },
    hasPermission() { return true; }
  }, observed)("configuration.read", context);
  await assert.rejects(createAuthorizationCallback({
    async resolveRole() { return { name: "member", rank: 0 }; },
    hasPermission() { return false; }
  }, observed)("configuration.read", context));
  await assert.rejects(createAuthorizationCallback({
    async resolveRole() { throw new Error("private failure"); },
    hasPermission() { return true; }
  }, observed)("configuration.read", context));
  const metrics = observed.getMetrics();
  assert.equal(metrics["configuration.authorization.allowed"], 1);
  assert.equal(metrics["configuration.authorization.denied"], 1);
  assert.equal(metrics["configuration.authorization.error"], 1);
  assert.equal(observed.getEvents().at(-1).event, "configuration.authorization.denied");
});

test("sanitiza eventos e nunca retém valores, credenciais ou identificadores", () => {
  const observed = observer();
  observed.emit("configuration.changed", {
    key: "telegram.botToken",
    scope: "group",
    source: "5511999999999@c.us",
    operation: "write",
    value: "secret",
    token: "token",
    groupId: "123456789@g.us",
    author: "5511999999999"
  });
  const event = observed.getEvents()[0];
  assert.equal(event.source, "[redacted]");
  assert.equal("value" in event, false);
  assert.equal("token" in event, false);
  assert.equal("groupId" in event, false);
  assert.equal("author" in event, false);
});

test("falha interna do observador nunca chega ao consumidor", async () => {
  const broken = {
    recordMetric() { throw new Error("metric failure"); },
    emit() { throw new Error("event failure"); }
  };
  const service = createConfigurationService();
  service.attachObservability(broken);
  assert.equal(service.get("quiz.ranking.pageSize"), 10);
  const authorize = createAuthorizationCallback({
    async resolveRole() { return { name: "owner", rank: 4 }; },
    hasPermission() { return true; }
  }, broken);
  assert.equal(await authorize("configuration.read", { identity: "owner" }), true);
});

test("falha de persistência gera evento sem alterar o erro original", async () => {
  const observed = observer();
  const service = createConfigurationService();
  service.attachObservability(observed);
  service.attachRepository({
    async initialize() {},
    async readGlobal() { return { values: {} }; },
    async readCommunities() { return { communities: {} }; },
    async readPlatforms() { return { platforms: {} }; },
    async readGroups() { return { groups: {} }; },
    async writeGlobal() { throw new Error("disk unavailable"); },
    async appendHistory() {}
  });
  await service.initialize();
  await assert.rejects(
    service.setPersistent("quiz.ranking.pageSize", 20),
    /disk unavailable/
  );
  assert.equal(
    observed.getEvents().at(-1).event,
    "configuration.persistence.failed"
  );
});

test("sink externo e APIs de inspeção são seguros e imutáveis", () => {
  const calls = [];
  const observed = createConfigurationObservabilityService({
    sink: {
      recordMetric(name) { calls.push(name); },
      emit(name) { calls.push(name); }
    }
  });
  observed.recordMetric("configuration.reload.total");
  observed.emit("configuration.reload", { operation: "reload" });
  assert.deepEqual(calls, [
    "configuration.reload.total",
    "configuration.reload"
  ]);
  assert.ok(Object.isFrozen(observed.getMetrics()));
  assert.ok(Object.isFrozen(observed.getEvents()));
});
