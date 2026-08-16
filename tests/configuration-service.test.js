"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createConfigurationService
} = require("../src/services/configurationService");

test("lê defaults existentes sem alterar false, zero ou objetos", () => {
  const service = createConfigurationService();
  assert.equal(service.getDefault("system.commandPrefix"), "!");
  assert.equal(service.get("moderation.enabled"), false);
  assert.equal(service.get("quiz.cooldownSeconds"), 0);
  assert.deepEqual(service.get("quiz.language.accepted"), ["pt-BR", "en"]);
});

test("lê schema completo e imutável", () => {
  const service = createConfigurationService();
  const schema = service.getSchema("quiz.enabled");
  assert.equal(schema.key, "quiz.enabled");
  assert.equal(schema.namespace, "quiz");
  assert.equal(schema.type, "boolean");
  assert.equal(Object.isFrozen(schema), true);
  assert.equal(Object.isFrozen(schema.allowedScopes), true);
});

test("valida existência e normaliza somente espaços externos", () => {
  const service = createConfigurationService();
  assert.equal(service.has("quiz.enabled"), true);
  assert.equal(service.has("unknown.value"), false);
  assert.equal(service.validateKey(" quiz.enabled "), "quiz.enabled");
});

test("lista namespaces e chaves públicas sem referências mutáveis", () => {
  const service = createConfigurationService();
  const namespaces = service.listNamespaces();
  const keys = service.listKeys();
  assert.equal(namespaces.length, 16);
  assert.equal(keys.includes("quiz.enabled"), true);
  assert.equal(keys.includes("telegram.botToken"), false);
  assert.equal(Object.isFrozen(namespaces), true);
  assert.equal(Object.isFrozen(keys), true);
});

test("chave inexistente sempre lança erro consistente e sanitizado", () => {
  const service = createConfigurationService();
  for (const operation of [
    () => service.get("unknown.value"),
    () => service.getDefault("unknown.value"),
    () => service.getSchema("unknown.value"),
    () => service.validateKey("unknown.value"),
    () => service.set("unknown.value", "segredo")
  ]) {
    assert.throws(operation, error =>
      error.name === "ConfigurationError" &&
      error.code === "CONFIGURATION_KEY_UNKNOWN" &&
      !error.message.includes("unknown.value") &&
      !error.message.includes("segredo")
    );
  }
});

test("escrita da fachada é isolada em memória por instância", () => {
  const first = createConfigurationService();
  const second = createConfigurationService();
  assert.equal(first.set("quiz.cooldownSeconds", 30), 30);
  assert.equal(first.get("quiz.cooldownSeconds"), 30);
  assert.equal(second.get("quiz.cooldownSeconds"), 0);
  assert.equal(first.getDefault("quiz.cooldownSeconds"), 0);
});

test("escrita valida tipo e protege segredos e invariantes", () => {
  const service = createConfigurationService();
  assert.throws(
    () => service.set("quiz.enabled", "sim"),
    error => error.code === "CONFIGURATION_VALUE_INVALID"
  );
  assert.throws(
    () => service.set("telegram.botToken", "não-expor"),
    error => error.code === "CONFIGURATION_WRITE_FORBIDDEN" &&
      !error.message.includes("não-expor")
  );
  assert.throws(
    () => service.set("menus.directCommandsRemainAvailable", false),
    error => error.code === "CONFIGURATION_WRITE_FORBIDDEN"
  );
});

test("objetos escritos e retornados não compartilham referências mutáveis", () => {
  const service = createConfigurationService();
  const value = {
    multipleChoice4: 1,
    multipleChoice5: 0,
    weaknessChoice: 0,
    trueFalse: 0,
    open: 0
  };
  service.set("quiz.questions.distribution", value);
  value.multipleChoice4 = 0;
  const stored = service.get("quiz.questions.distribution");
  assert.equal(stored.multipleChoice4, 1);
  assert.equal(Object.isFrozen(stored), true);
});
