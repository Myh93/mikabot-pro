"use strict";

const assert = require("assert");
const test = require("node:test");
const { createRaidPokemonCatalogService, SPECIAL_SOURCES } = require("../src/services/raidPokemonCatalogService");

test("resolve formas base, Mega, Dynamax, Gigantamax e Shadow com aliases seguros", () => {
  const catalog = createRaidPokemonCatalogService();
  const cases = [
    ["Charizard", "Charizard"],
    ["MEGA CHARIZARD X", "Mega Charizard X"],
    ["mega-charizard-x", "Mega Charizard X"],
    ["Mega Charizard Y", "Mega Charizard Y"],
    ["Mega Gengar", "Mega Gengar"],
    ["Dynamax Pikachu", "Dynamax Pikachu"],
    ["Pikachu Dynamax", "Dynamax Pikachu"],
    ["D Max Pikachu", "Dynamax Pikachu"],
    ["D-Max Pikachu", "Dynamax Pikachu"],
    ["Gigantamax Charizard", "Gigantamax Charizard"],
    ["Charizard Gigantamax", "Gigantamax Charizard"],
    ["G-Max Charizard", "Gigantamax Charizard"],
    ["Gmax Charizard", "Gigantamax Charizard"],
    ["Shadow Mewtwo", "Shadow Mewtwo"]
  ];
  for (const [input, expected] of cases) assert.equal(catalog.resolve(input), expected, input);
  assert.equal(catalog.resolve("Gigantamax Rayquaza"), null);
  assert.equal(catalog.resolve("Mega Rayquaza"), null);
});

test("Mega Charizard sem sufixo é ambíguo e nunca escolhe silenciosamente", () => {
  const result = createRaidPokemonCatalogService().resolveDetailed("  MEGA   CHARIZARD ");
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.options, ["Mega Charizard X", "Mega Charizard Y"]);
});

test("todas as formas derivadas das fontes internas resolvem pelo nome canônico", () => {
  const catalog = createRaidPokemonCatalogService();
  for (const canonical of catalog.listCanonicalForms()) {
    assert.equal(catalog.resolve(canonical), canonical, canonical);
  }
  assert.equal(SPECIAL_SOURCES.length, 5);
});

test("estatísticas refletem somente as fontes internas, sem catálogo manual duplicado", () => {
  const stats = createRaidPokemonCatalogService().getStatistics();
  assert.ok(stats.base >= 965);
  assert.equal(stats.mega, 4);
  assert.equal(stats.dynamax, 3);
  assert.equal(stats.gigantamax, 3);
  assert.equal(stats.shadow, 3);
  assert.equal(stats.raid, 0);
});
