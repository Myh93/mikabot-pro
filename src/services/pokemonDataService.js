"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_MANIFEST = path.join(__dirname, "..", "database", "pokemon", "manifest.json");
const VALID_TYPES = new Set(["Bug", "Dark", "Dragon", "Electric", "Fairy", "Fighting", "Fire", "Flying", "Ghost", "Grass", "Ground", "Ice", "Normal", "Poison", "Psychic", "Rock", "Steel", "Water"]);
const QUESTION_TYPES = {
  tipo: (pokemon) => pokemon.tipo.length >= 1,
  type: (pokemon) => pokemon.tipo.length >= 1,
  tipo_duplo: (pokemon) => pokemon.tipo.length === 2,
  dual_type: (pokemon) => pokemon.tipo.length === 2,
  numero: (pokemon) => Number.isInteger(pokemon.numero),
  pokedex_number: (pokemon) => Number.isInteger(pokemon.numero),
  fraqueza: (pokemon) => pokemon.fraquezas.length >= 1,
  weakness: (pokemon) => pokemon.fraquezas.length >= 1,
  multipla_escolha: () => true,
  multiple_choice: () => true,
  pistas: (pokemon) => pokemon.tipo.length >= 1 && Number.isInteger(pokemon.numero),
  clues: (pokemon) => pokemon.tipo.length >= 1 && Number.isInteger(pokemon.numero)
};

function normalizeName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function createPokemonDataService(options = {}) {
  const manifestPath = path.resolve(options.manifestPath || DEFAULT_MANIFEST);
  let cache = null;

  function datasetFile(entry) {
    return path.resolve(path.dirname(manifestPath), "..", entry.file);
  }

  function validateCandidate(manifest, generations) {
    const errors = [];
    if (!manifest || manifest.status !== "partial_validated") errors.push("Manifesto não está com status partial_validated.");
    if (!Array.isArray(manifest?.generations) || !manifest.generations.length) errors.push("Manifesto sem gerações válidas.");
    if (!Array.isArray(manifest?.missingNumbers) || !Array.isArray(manifest?.blockedPokemonNumbers)) errors.push("Manifesto sem listas de pendências.");
    const all = [];
    for (const item of generations || []) {
      const { definition, records, checksum } = item;
      if (!Array.isArray(records)) {
        errors.push(`${definition.file} não contém array.`);
        continue;
      }
      const declaredChecksum = typeof manifest.checksums?.[definition.file] === "string" ? manifest.checksums[definition.file] : manifest.checksums?.[definition.file]?.value;
      if (!declaredChecksum || declaredChecksum !== checksum) errors.push(`Checksum incorreto para ${definition.file}.`);
      records.forEach((pokemon, index) => {
        if (!pokemon || !Number.isInteger(pokemon.numero) || typeof pokemon.nome !== "string" || !Array.isArray(pokemon.tipo) || !Array.isArray(pokemon.fraquezas) || typeof pokemon.descricao !== "string") errors.push(`Formato inválido em ${definition.file}[${index}].`);
        else {
          if (pokemon.numero < definition.min || pokemon.numero > definition.max) errors.push(`${pokemon.numero} fora dos limites de ${definition.file}.`);
          if (pokemon.tipo.some((type) => !VALID_TYPES.has(type)) || pokemon.fraquezas.some((type) => !VALID_TYPES.has(type))) errors.push(`Tipo inválido no Pokémon ${pokemon.numero}.`);
          if (index && records[index - 1].numero >= pokemon.numero) errors.push(`${definition.file} fora de ordem.`);
          all.push(pokemon);
        }
      });
    }
    const uniqueNumbers = new Set(all.map((pokemon) => pokemon.numero));
    if (all.length !== manifest?.pokemonCount) errors.push(`Contagem real ${all.length} difere do manifesto ${manifest?.pokemonCount}.`);
    if (uniqueNumbers.size !== all.length) errors.push("Existem números duplicados.");
    return { valid: errors.length === 0, errors, pokemonCount: all.length, uniqueNumberCount: uniqueNumbers.size };
  }

  function buildCache() {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw new Error(`Manifesto Pokémon inválido: ${error.message}`);
    }
    const generations = (manifest.generations || []).map((definition) => {
      const filePath = datasetFile(definition);
      let records;
      try {
        records = JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch (error) {
        throw new Error(`Falha ao carregar ${definition.file}: ${error.message}`);
      }
      return { definition, records, checksum: hashFile(filePath) };
    });
    const validation = validateCandidate(manifest, generations);
    if (!validation.valid) throw new Error(`Dataset Pokémon inválido: ${validation.errors.join(" ")}`);
    const all = generations.flatMap((item) => item.records);
    const byNumber = new Map(all.map((pokemon) => [pokemon.numero, pokemon]));
    const byName = new Map();
    all.forEach((pokemon) => {
      const names = [...new Set([pokemon.nome, ...(pokemon.aliases || [])].map(normalizeName))];
      for (const name of names) {
        const key = normalizeName(name);
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(pokemon);
      }
    });
    const loadedAt = new Date().toISOString();
    const dataset = deepFreeze({ manifest, pokemon: all, generations: generations.map((item) => item.definition), loadedAt });
    return { manifest: dataset.manifest, generations, all: dataset.pokemon, byNumber, byName, blocked: new Set(manifest.blockedPokemonNumbers), validation: deepFreeze(validation), loadedAt, dataset };
  }

  function ensureCache() {
    if (!cache) cache = buildCache();
    return cache;
  }

  function loadDataset() {
    return ensureCache().dataset;
  }

  function reloadDataset() {
    const replacement = buildCache();
    cache = replacement;
    return cache.dataset;
  }

  function validateDataset(manifest, generations) {
    if (arguments.length === 0) return ensureCache().validation;
    return validateCandidate(manifest, generations);
  }

  function listAvailableGenerations() {
    return ensureCache().manifest.generations.map((entry) => entry.generation);
  }

  function getPokemonByNumber(number) {
    return ensureCache().byNumber.get(Number(number)) || null;
  }

  function getPokemonByName(name) {
    const matches = ensureCache().byName.get(normalizeName(name)) || [];
    if (matches.length !== 1 || isPokemonBlocked(matches[0].numero)) return null;
    return matches[0];
  }

  function resolvePokemon(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (/^\d+$/.test(raw)) {
      const pokemon = getPokemonByNumber(Number(raw));
      return pokemon && !isPokemonBlocked(pokemon.numero) ? pokemon : null;
    }
    return getPokemonByName(raw);
  }

  function editDistance(left, right) {
    const a = normalizeName(left), b = normalizeName(right);
    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let row = 1; row <= a.length; row += 1) {
      let diagonal = previous[0];
      previous[0] = row;
      for (let column = 1; column <= b.length; column += 1) {
        const above = previous[column];
        previous[column] = Math.min(
          previous[column] + 1,
          previous[column - 1] + 1,
          diagonal + Number(a[row - 1] !== b[column - 1])
        );
        diagonal = above;
      }
    }
    return previous[b.length];
  }

  function suggestPokemon(value, limit = 3) {
    const input = normalizeName(value);
    if (!input) return [];
    const maximumDistance = Math.max(2, Math.floor(input.length * 0.45));
    return ensureCache().all
      .filter(pokemon => !isPokemonBlocked(pokemon.numero))
      .map(pokemon => ({ pokemon, distance: editDistance(input, pokemon.nome) }))
      .filter(item => item.distance <= maximumDistance)
      .sort((a, b) => a.distance - b.distance || a.pokemon.nome.localeCompare(b.pokemon.nome))
      .slice(0, Math.max(1, Number(limit) || 3))
      .map(item => item.pokemon);
  }

  function isPokemonBlocked(pokemonOrNumber) {
    const number = typeof pokemonOrNumber === "object" ? pokemonOrNumber?.numero : Number(pokemonOrNumber);
    return ensureCache().blocked.has(number);
  }

  function getEligiblePokemon(questionType) {
    const predicate = QUESTION_TYPES[normalizeName(questionType).replace(/ /g, "_")];
    if (!predicate) return [];
    return ensureCache().all.filter((pokemon) => !isPokemonBlocked(pokemon.numero) && predicate(pokemon));
  }

  function getRandomPokemon(questionType, random = Math.random) {
    const eligible = getEligiblePokemon(questionType);
    if (!eligible.length) return null;
    const value = Number(random());
    const index = Math.min(eligible.length - 1, Math.max(0, Math.floor((Number.isFinite(value) ? value : 0) * eligible.length)));
    return eligible[index];
  }

  function getDatasetVersion() {
    return ensureCache().manifest.datasetVersion;
  }

  function getDatasetHealth() {
    const data = ensureCache();
    return deepFreeze({
      status: data.manifest.status,
      datasetVersion: data.manifest.datasetVersion,
      pokemonCount: data.validation.pokemonCount,
      expectedPokemonCount: data.manifest.pokemonCountExpected,
      missingCount: data.manifest.missingNumbers.length,
      duplicateNameCount: data.manifest.duplicateNames.length,
      blockedPokemonCount: data.blocked.size,
      loadedAt: data.loadedAt
    });
  }

  return { loadDataset, reloadDataset, validateDataset, listAvailableGenerations, getPokemonByNumber, getPokemonByName, resolvePokemon, suggestPokemon, getRandomPokemon, getEligiblePokemon, getDatasetVersion, getDatasetHealth, isPokemonBlocked };
}

const service = createPokemonDataService();
module.exports = { ...service, createPokemonDataService };
