"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const DATABASE = path.join(ROOT, "src", "database");
const MANIFEST_PATH = path.join(DATABASE, "pokemon", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
const { createPokemonDataService } = require("../src/services/pokemonDataService");
const FILES = manifest.generations.map((generation) => generation.file);

function hash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readGenerations(directory = DATABASE) {
  return FILES.map((file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")));
}

function withTemporaryDataset(mutator) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-pokedex-test-"));
  const database = path.join(root, "database");
  const pokemon = path.join(database, "pokemon");
  fs.mkdirSync(pokemon, { recursive: true });
  FILES.forEach((file) => fs.copyFileSync(path.join(DATABASE, file), path.join(database, file)));
  const copiedManifest = JSON.parse(JSON.stringify(manifest));
  mutator(copiedManifest, database);
  fs.writeFileSync(path.join(pokemon, "manifest.json"), JSON.stringify(copiedManifest), "utf8");
  return { root, manifestPath: path.join(pokemon, "manifest.json") };
}

test("backup contém os nove originais e permite restauração validada", () => {
  const backup = path.resolve(ROOT, manifest.backupUsed);
  const backupManifest = JSON.parse(fs.readFileSync(path.join(backup, "backup-manifest.json"), "utf8"));
  assert.strictEqual(backupManifest.validation.status, "valid");
  assert.strictEqual(backupManifest.restoration.possible, true);
  assert.deepStrictEqual([...backupManifest.files].sort(), [...FILES].sort());
  const restoreDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-pokedex-restore-"));
  for (const file of FILES) {
    fs.copyFileSync(path.join(backup, file), path.join(restoreDirectory, file));
    assert.strictEqual(hash(path.join(restoreDirectory, file)), backupManifest.checksums[file].value);
  }
});

test("movimentações, limites, contagem, unicidade e ordenação estão corretos", () => {
  const generations = readGenerations();
  const all = generations.flat();
  assert.strictEqual(all.length, manifest.pokemonCount);
  assert.strictEqual(new Set(all.map((pokemon) => pokemon.numero)).size, manifest.pokemonCount);
  assert.deepStrictEqual(generations[2].filter((pokemon) => pokemon.numero >= 353 && pokemon.numero <= 386).map((pokemon) => pokemon.numero), Array.from({ length: 34 }, (_, index) => 353 + index));
  assert.deepStrictEqual(generations[7].filter((pokemon) => pokemon.numero >= 899 && pokemon.numero <= 905).map((pokemon) => pokemon.numero), Array.from({ length: 7 }, (_, index) => 899 + index));
  manifest.generations.forEach((definition, index) => {
    assert.ok(generations[index].every((pokemon) => pokemon.numero >= definition.min && pokemon.numero <= definition.max));
    assert.deepStrictEqual(generations[index].map((pokemon) => pokemon.numero), [...generations[index]].sort((a, b) => a.numero - b.numero).map((pokemon) => pokemon.numero));
  });
});

test("serviço carrega pelo manifesto e reutiliza cache", () => {
  const service = createPokemonDataService({ manifestPath: MANIFEST_PATH });
  const first = service.loadDataset();
  const second = service.loadDataset();
  assert.strictEqual(first, second);
  assert.strictEqual(first.pokemon.length, manifest.pokemonCount);
  assert.deepStrictEqual(service.listAvailableGenerations(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.strictEqual(service.validateDataset().valid, true);
});

test("consulta por número e nome respeita conflitos bloqueados", () => {
  const service = createPokemonDataService({ manifestPath: MANIFEST_PATH });
  assert.strictEqual(service.getPokemonByNumber(1).nome, "Bulbasaur");
  assert.strictEqual(service.getPokemonByName("bulbasaur").numero, 1);
  const blocked = manifest.blockedPokemonNumbers[0];
  assert.strictEqual(service.isPokemonBlocked(blocked), true);
  assert.strictEqual(service.getPokemonByName(service.getPokemonByNumber(blocked).nome), null);
});

test("seleção elegível nunca retorna registro bloqueado", () => {
  const service = createPokemonDataService({ manifestPath: MANIFEST_PATH });
  const eligible = service.getEligiblePokemon("tipo_duplo");
  assert.ok(eligible.length > 0);
  assert.ok(eligible.every((pokemon) => pokemon.tipo.length === 2 && !service.isPokemonBlocked(pokemon)));
  assert.strictEqual(service.isPokemonBlocked(service.getRandomPokemon("multipla_escolha", () => 0)), false);
  assert.deepStrictEqual(service.getEligiblePokemon("silhueta"), []);
});

test("manifesto inválido falha sem disponibilizar dataset", () => {
  const temporary = withTemporaryDataset((copy) => { copy.status = "audit_pending_correction"; });
  assert.throws(() => createPokemonDataService({ manifestPath: temporary.manifestPath }).loadDataset(), /Dataset Pokémon inválido/);
});

test("checksum incorreto falha com identificação do arquivo", () => {
  const temporary = withTemporaryDataset((copy) => { copy.checksums[FILES[0]].value = "0".repeat(64); });
  assert.throws(() => createPokemonDataService({ manifestPath: temporary.manifestPath }).loadDataset(), new RegExp(`Checksum incorreto para ${FILES[0]}`));
});
