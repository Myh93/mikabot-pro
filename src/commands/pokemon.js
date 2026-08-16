"use strict";

const fs = require("fs");
const path = require("path");
const menuRegistryDefault = require("../services/menuRegistry");
const registrationGuidedFlowDefault = require("../services/registrationGuidedFlowService");
const pokemonDataServiceDefault = require("../services/pokemonDataService");
const pokemonLocaleServiceDefault = require("../services/pokemonLocaleService");
const { createPlatformContext } = require("../utils/platformContext");
const { normalizeInput } = require("../services/inputResolverService");
const { FALLBACK: REGISTRATION_PRIVATE_FALLBACK } = require("../services/registrationPrivateShortcutService");

const COUNTER_FILES = ["pokemon_raids,json", "pokemon_megaraids.json", "pokemon_dynamax.json", "pokemon_gmax.json", "pokemon_shadows.json"];

function createPokemonCommand(options = {}) {
  const menuRegistry = options.menuRegistry || menuRegistryDefault;
  const registrationGuidedFlow = options.registrationGuidedFlow || registrationGuidedFlowDefault;
  const pokemonDataService = options.pokemonDataService || pokemonDataServiceDefault;
  const localeService = options.pokemonLocaleService || pokemonLocaleServiceDefault;
  const databasePath = options.databasePath || path.join(__dirname, "..", "database");
  let counterIndex = null;

  function loadCounterIndex() {
    if (counterIndex) return counterIndex;
    counterIndex = new Map();
    for (const filename of COUNTER_FILES) {
      const filePath = path.join(databasePath, filename);
      if (!fs.existsSync(filePath)) continue;
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      for (const [name, details] of Object.entries(data)) {
        const key = normalizeInput(name);
        if (!counterIndex.has(key)) counterIndex.set(key, details);
      }
    }
    return counterIndex;
  }

  function resolveCounters(search) {
    const pokemon = pokemonDataService.resolvePokemon(search);
    const candidates = [search, pokemon?.nome, ...(pokemon?.aliases || [])].filter(Boolean);
    const index = loadCounterIndex();
    for (const candidate of candidates) {
      const details = index.get(normalizeInput(candidate));
      if (details) return { pokemon, details };
    }
    return { pokemon, details: null };
  }

  async function execute(client, msg, args, context = {}) {
    const commandName = context.commandName || normalizeInput(msg.body).split(" ")[0];
    if (commandName === "pokemon") return menuRegistry.openMenuFromCommand("pokemon", client, msg, context);
    if (commandName === "perfil") return menuRegistry.openMenuFromCommand("profile", client, msg, context);
    if (["cadastro", "cadastrar", "registro", "registrar"].includes(commandName)) {
      const platformContext = context.platformContext || await createPlatformContext(client, msg);
      if (args.length) await msg.reply(`ℹ️ O cadastro agora é feito pelo fluxo seguro no privado.\n\n${REGISTRATION_PRIVATE_FALLBACK}`);
      return registrationGuidedFlow.start({ ...platformContext, conversationId: platformContext.conversationId || platformContext.groupId });
    }

    const search = args.join(" ").trim();
    if (commandName === "pokedex") {
      if (!search) return msg.reply("⚠️ Qual Pokémon deseja consultar?");
      const pokemon = pokemonDataService.resolvePokemon(search);
      if (!pokemon) return msg.reply("❌ Pokémon não encontrado na Pokédex local.");
      return msg.reply([
        `📖 *#${pokemon.numero} — ${pokemon.nome.toUpperCase()}*`, "",
        `🧬 *Tipo:* ${pokemon.tipo.map(type => localeService.translateType(type)).join("/")}`,
        `⚔️ *Fraquezas:* ${pokemon.fraquezas.map(type => localeService.translateWeakness(type)).join(", ")}`
      ].join("\n"));
    }

    if (["counter", "counters"].includes(commandName)) {
      if (!search) return msg.reply("⚠️ Qual Pokémon deseja consultar?");
      const result = resolveCounters(search);
      if (!result.details) return msg.reply("ℹ️ Os dados de counters ainda não estão disponíveis para esse Pokémon.");
      const officialName = result.pokemon?.nome || search;
      return msg.reply(`⚔️ *COUNTERS PARA ${officialName.toUpperCase()}*\n\n${result.details.counters.join("\n")}`);
    }
  }

  return { name: "pokemon", aliases: ["pokedex", "counter", "counters", "cadastro", "cadastrar", "registro", "registrar", "perfil"], execute, resolveCounters };
}

const command = createPokemonCommand();
module.exports = { ...command, createPokemonCommand, COUNTER_FILES };
