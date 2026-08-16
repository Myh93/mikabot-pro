"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const configurationService = require("../src/services/configurationService");
const localeService = require("../src/services/pokemonLocaleService");

test("pokemonLocaleService obtém somente os defaults de idioma pela fachada", () => {
  assert.equal(
    localeService.DEFAULT_LOCALE_CONFIGURATION.quizLanguage,
    configurationService.get("quiz.language.display")
  );
  assert.deepEqual(
    localeService.DEFAULT_LOCALE_CONFIGURATION.acceptedLanguages,
    configurationService.get("quiz.language.accepted")
  );
  assert.equal(Object.isFrozen(localeService.DEFAULT_LOCALE_CONFIGURATION), true);
  assert.equal(Object.isFrozen(localeService.DEFAULT_LOCALE_CONFIGURATION.acceptedLanguages), true);
});

test("migração preserva integralmente o comportamento de localização padrão", () => {
  assert.equal(localeService.translateType("water"), "Água");
  assert.equal(localeService.translateDifficulty("easy"), "Fácil");
  assert.equal(localeService.formatDualType(["dark", "dragon"]), "Sombrio/Dragão");
  assert.equal(localeService.translateAnswer("Pikachu"), "Pikachu");
});

test("consumidor não lê defaults ou schema diretamente", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "services", "pokemonLocaleService.js"),
    "utf8"
  );
  assert.match(source, /require\(["']\.\/configurationService["']\)/);
  assert.doesNotMatch(source, /require\(["'][^"']*config\/(?:defaults|schema)["']\)/);
});
