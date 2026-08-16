"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const catalog = require("../src/config/schema");
const { DEFAULTS } = require("../src/config/defaults");

test("catálogo possui 105 chaves e 16 namespaces válidos", () => {
  const validation = catalog.validateCatalog();
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.equal(validation.totalDefinitions, 105);
  assert.equal(validation.totalNamespaces, 16);
  assert.equal(catalog.listNamespaces().length, 16);
});

test("chaves públicas não possuem duplicidade e usam camelCase hierárquico", () => {
  const definitions = catalog.listDefinitions();
  assert.equal(new Set(definitions.map(item => item.key)).size, definitions.length);
  assert.equal(definitions.every(item => /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/.test(item.key)), true);
});

test("tipos, escopos, sensibilidades e status pertencem aos conjuntos oficiais", () => {
  for (const definition of catalog.listDefinitions()) {
    assert.equal(catalog.TYPES.includes(definition.type), true);
    assert.equal(definition.allowedScopes.every(scope => catalog.SCOPES.includes(scope)), true);
    assert.equal(catalog.SENSITIVITIES.includes(definition.sensitivity), true);
    assert.equal(catalog.STATUSES.includes(definition.status), true);
  }
});

test("false, zero e null são preservados como defaults reais", () => {
  assert.equal(catalog.getDefault("moderation.enabled"), false);
  assert.equal(catalog.getDefault("quiz.cooldownSeconds"), 0);
  assert.equal(catalog.getDefault("backup.retentionCount"), null);
});

test("segredos existem no catálogo mas não aparecem em listagens ou defaults", () => {
  assert.equal(catalog.hasDefinition("telegram.botToken"), true);
  assert.equal(catalog.hasDefinition("whatsapp.sessionData"), true);
  assert.equal(catalog.getDefault("telegram.botToken"), undefined);
  assert.equal(catalog.listDefinitions().some(item => item.secret), false);
  assert.equal(catalog.listByNamespace("telegram").some(item => item.key === "telegram.botToken"), false);
});

test("defaults restritos também permanecem sem valor exportado", () => {
  for (const definition of catalog.listDefinitions().filter(item => item.sensitivity === "restricted")) {
    assert.equal(catalog.getDefault(definition.key), undefined, definition.key);
  }
});

test("invariantes nunca permitem override", () => {
  for (const definition of catalog.listDefinitions().filter(item => item.invariant)) {
    assert.equal(definition.overrideAllowed, false, definition.key);
  }
});

test("estruturas exportadas e retornos são profundamente imutáveis", () => {
  assert.equal(Object.isFrozen(DEFAULTS), true);
  assert.equal(Object.isFrozen(DEFAULTS["quiz.questions.distribution"]), true);
  const definition = catalog.getDefinition("quiz.language.accepted");
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.allowedScopes), true);
  const listed = catalog.listDefinitions();
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(Object.isFrozen(listed[0]), true);
});

test("consultas por chave e namespace são somente leitura", () => {
  assert.equal(catalog.hasDefinition("quiz.enabled"), true);
  assert.equal(catalog.getDefinition("quiz.enabled").namespace, "quiz");
  assert.equal(catalog.listByNamespace("quiz").every(item => item.namespace === "quiz"), true);
  assert.equal(catalog.getDefinition("unknown.value"), null);
  assert.deepEqual(catalog.listByNamespace("unknown"), []);
  assert.equal(catalog.getDefault("unknown.value"), undefined);
});

test("validador detecta erros sem expor valores secretos", () => {
  const invalid = [{
    key: "telegram.botToken", namespace: "telegram", description: "Segredo",
    type: "string", defaultReference: "telegram.botToken", allowedScopes: ["runtime"],
    sensitivity: "secret", overrideAllowed: false, status: "reserved",
    ownerModule: "telegram", consumers: ["telegram"], currentSource: "environment",
    invariant: false, secret: true, nullable: false
  }];
  const result = catalog.validateCatalog(invalid, { "telegram.botToken": "valor-ultrassecreto" });
  assert.equal(result.valid, false);
  assert.equal(result.errors.includes("secret_default_exposed"), true);
  assert.doesNotMatch(result.errors.join(" "), /valor-ultrassecreto/);
});
