"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const pokemonData = require("../src/services/pokemonDataService");
const { createPokemonDataService } = pokemonData;
const { createRepository } = require("../src/repositories/raidRepository");
const { createRaidService } = require("../src/services/raidService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createRaidGuidedFlowService } = require("../src/services/raidGuidedFlowService");

const cleanup = root => fsp.rm(root, { recursive: true, force: true });

test("fonte oficial aceita nome, caixa, acentos e sugere erro de digitação", () => {
  assert.equal(pokemonData.resolvePokemon("Rayquaza").numero, 384);
  assert.equal(pokemonData.resolvePokemon("  RAYQUAZA ").numero, 384);
  assert.equal(pokemonData.resolvePokemon("flabebe")?.nome, "Flabébé");
  assert.equal(pokemonData.resolvePokemon("FLABÉBÉ")?.nome, "Flabébé");
  assert.equal(pokemonData.suggestPokemon("Rayquasa", 2)[0].nome, "Rayquaza");
  assert.deepEqual(pokemonData.suggestPokemon("zzzzzzzz", 3), []);
});

test("aliases existentes no registro são indexados sem criar outra base", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-pokemon-alias-"));
  try {
    const pokemonDir = path.join(root, "pokemon");
    await fsp.mkdir(pokemonDir);
    const records = [{
      numero: 1, nome: "Pokémon Oficial", aliases: ["Alias Local"],
      tipo: ["Grass"], fraquezas: ["Fire"], descricao: "Teste"
    }];
    const raw = JSON.stringify(records);
    const checksum = crypto.createHash("sha256").update(raw).digest("hex");
    await fsp.writeFile(path.join(root, "generation.json"), raw, "utf8");
    await fsp.writeFile(path.join(pokemonDir, "manifest.json"), JSON.stringify({
      status: "partial_validated",
      datasetVersion: "test",
      generations: [{ generation: 1, min: 1, max: 1, file: "generation.json" }],
      checksums: { "generation.json": checksum },
      pokemonCount: 1,
      pokemonCountExpected: 1,
      missingNumbers: [],
      duplicateNames: [],
      blockedPokemonNumbers: []
    }), "utf8");
    const service = createPokemonDataService({ manifestPath: path.join(pokemonDir, "manifest.json") });
    assert.equal(service.resolvePokemon("alias local").numero, 1);
    assert.equal(service.resolvePokemon("POKEMON OFICIAL").numero, 1);
  } finally { await cleanup(root); }
});

test("Raid persiste metadados oficiais e publicação inclui tipos", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-raid-pokedex-"));
  try {
    const repository = createRepository(path.join(root, "raids.json"));
    const service = createRaidService(repository, {
      listRegistrations: async () => []
    });
    const created = await service.createRaidFromMessage(
      { from: "group@g.us", author: "creator@lid" },
      { name: "rayquaza", groupId: "group@g.us" }
    );
    assert.equal(created.raid.pokemonId, 384);
    assert.equal(created.raid.nomeOficial, "Rayquaza");
    assert.deepEqual(created.raid.pokemonTypes, ["Dragon", "Flying"]);
    const publication = await service.formatPublication(created.raid);
    assert.match(publication, /Pokémon: Rayquaza/);
    assert.match(publication, /Tipo\(s\): Dragon \/ Flying/);

    const oldRaid = repository.createRaid({
      name: "pokemon antigo", groupId: "group@g.us", status: "active"
    });
    assert.equal(oldRaid.pokemonId, undefined);
    assert.match(await service.formatPublication(oldRaid), /Pokemon Antigo/i);
  } finally { await cleanup(root); }
});

test("fluxo oferece sugestões oficiais e persiste a escolha na sessão", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-raid-suggest-"));
  try {
    const flows = createGuidedFlowService({ filePath: path.join(root, "flows.json") });
    const replies = [];
    const flow = createRaidGuidedFlowService({
      guidedFlowService: flows,
      pokemonDataService: pokemonData,
      raidPokemonCatalogService: {
        resolve: () => null,
        resolveDetailed: () => ({ status: "invalid", value: null, options: [] })
      },
      menuSessionService: { closeMenu: async () => false },
      authorize: async () => true
    });
    const context = {
      platform: "whatsapp", groupId: "group@g.us", conversationId: "group@g.us",
      userId: "user@lid", isGroup: true,
      replyText: async text => replies.push(String(text))
    };
    await flow.start(context);
    const suggested = await flow.handleAnswer(context, "Rayquasa");
    assert.equal(suggested.session.step, "pokemon_ambiguity");
    assert.match(replies.at(-1), /Você quis dizer:[\s\S]*Rayquaza/);
    const selected = await flow.handleAnswer(context, "1");
    assert.equal(selected.session.step, "coordinates");
    assert.equal(selected.session.data.pokemonId, 384);
    assert.equal(selected.session.data.nomeOficial, "Rayquaza");
    assert.deepEqual(selected.session.data.pokemonTypes, ["Dragon", "Flying"]);
  } finally { await cleanup(root); }
});
