"use strict";

const fs = require("fs");
const path = require("path");
const pokemonDataDefault = require("./pokemonDataService");

const SPECIAL_SOURCES = Object.freeze([
  { file: "pokemon_megaraids.json", kind: "mega" },
  { file: "pokemon_dynamax.json", kind: "dynamax" },
  { file: "pokemon_gmax.json", kind: "gigantamax" },
  { file: "pokemon_shadows.json", kind: "shadow" },
  { file: "pokemon_raids,json", kind: "raid" }
]);

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\bg\s+max\b/g, "gmax")
    .replace(/\bd\s+max\b/g, "dmax")
    .replace(/\s+/g, " ")
    .trim();
}

function displayName(value) {
  return String(value || "").split(/\s+/).map(part => {
    const lower = part.toLowerCase();
    if (["x", "y"].includes(lower)) return lower.toUpperCase();
    return part ? part[0].toUpperCase() + part.slice(1).toLowerCase() : part;
  }).join(" ");
}

function createRaidPokemonCatalogService(options = {}) {
  const pokemonData = options.pokemonDataService || pokemonDataDefault;
  const specialDirectory = options.specialDirectory || path.join(__dirname, "..", "database");
  let cache = null;

  function buildCache() {
    const aliases = new Map();
    const byNumber = new Map();
    const canonical = new Map();
    const stats = { base: 0, mega: 0, dynamax: 0, gigantamax: 0, shadow: 0, raid: 0 };
    const add = (alias, name) => {
      const key = normalize(alias);
      if (!key || !name) return;
      if (!aliases.has(key)) aliases.set(key, new Set());
      aliases.get(key).add(name);
    };
    const addCanonical = (name, kind) => {
      if (!canonical.has(name)) {
        canonical.set(name, kind);
        stats[kind] = (stats[kind] || 0) + 1;
      }
      add(name, name);
    };

    const dataset = pokemonData.loadDataset();
    for (const pokemon of dataset.pokemon || []) {
      addCanonical(pokemon.nome, "base");
      if (!byNumber.has(pokemon.numero)) byNumber.set(pokemon.numero, pokemon.nome);
    }

    for (const source of SPECIAL_SOURCES) {
      const filePath = path.join(specialDirectory, source.file);
      if (!fs.existsSync(filePath)) continue;
      const records = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const rawName of Object.keys(records || {})) {
        const normalizedRaw = normalize(rawName);
        let name = displayName(rawName);
        let base = normalizedRaw;
        if (source.kind === "mega") {
          base = normalizedRaw.replace(/^mega\s+/, "");
          name = `Mega ${displayName(base)}`;
        } else if (source.kind === "dynamax") {
          base = normalizedRaw.replace(/^dynamax\s+/, "");
          name = `Dynamax ${displayName(base)}`;
        } else if (source.kind === "gigantamax") {
          base = normalizedRaw.replace(/^(?:gmax|gigantamax)\s+/, "");
          name = `Gigantamax ${displayName(base)}`;
        } else if (source.kind === "shadow") {
          base = normalizedRaw.replace(/^shadow\s+/, "");
          name = `Shadow ${displayName(base)}`;
        }
        addCanonical(name, source.kind);
        add(rawName, name);
        if (["dynamax", "gigantamax", "shadow", "raid"].includes(source.kind)) {
          const baseCanonical = displayName(base);
          if (!aliases.has(normalize(baseCanonical))) addCanonical(baseCanonical, "base");
        }
        if (source.kind === "mega") {
          add(`mega-${base.replace(/\s+/g, "-")}`, name);
          const ambiguousBase = base.replace(/\s+(?:x|y)$/, "");
          if (ambiguousBase !== base) add(`mega ${ambiguousBase}`, name);
        } else if (source.kind === "dynamax") {
          add(`${base} dynamax`, name);
          add(`dmax ${base}`, name);
          add(`d-max ${base}`, name);
          add(`d max ${base}`, name);
        } else if (source.kind === "gigantamax") {
          for (const prefix of ["gmax", "g-max", "g max", "gigantamax"]) add(`${prefix} ${base}`, name);
          add(`${base} gigantamax`, name);
        } else if (source.kind === "shadow") {
          add(`${base} shadow`, name);
        }
      }
    }
    return { aliases, byNumber, canonical, stats };
  }

  function ensureCache() {
    if (!cache) cache = buildCache();
    return cache;
  }

  function resolveDetailed(value) {
    const input = String(value || "").trim();
    if (!input) return { status: "invalid", value: null, options: [] };
    const data = ensureCache();
    if (/^\d+$/.test(input)) {
      const valueByNumber = data.byNumber.get(Number(input)) || null;
      return valueByNumber
        ? { status: "resolved", value: valueByNumber, options: [valueByNumber] }
        : { status: "invalid", value: null, options: [] };
    }
    const matches = [...(data.aliases.get(normalize(input)) || [])];
    if (matches.length === 1) return { status: "resolved", value: matches[0], options: matches };
    if (matches.length > 1) return { status: "ambiguous", value: null, options: matches.sort() };
    return { status: "invalid", value: null, options: [] };
  }

  function resolve(value) {
    const result = resolveDetailed(value);
    return result.status === "resolved" ? result.value : null;
  }

  function listCanonicalForms(kind = null) {
    return [...ensureCache().canonical.entries()]
      .filter(([, formKind]) => !kind || formKind === kind)
      .map(([name]) => name);
  }

  function getStatistics() {
    return { ...ensureCache().stats };
  }

  function reload() {
    cache = buildCache();
    return true;
  }

  return { resolve, resolveDetailed, listCanonicalForms, getStatistics, reload, normalize };
}

const service = createRaidPokemonCatalogService();
module.exports = { ...service, createRaidPokemonCatalogService, normalize, SPECIAL_SOURCES };
