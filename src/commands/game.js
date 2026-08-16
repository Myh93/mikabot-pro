"use strict";

const pokemonDataServiceDefault = require("../services/pokemonDataService");
const { normalizeInput } = require("../services/inputResolverService");

const DEFAULT_CAPTURE_RATE = 0.65;
const DEFAULT_SUSPENSE_MS = 2500;

function createGameCommand(options = {}) {
  const pokemonDataService = options.pokemonDataService || pokemonDataServiceDefault;
  const random = options.random || Math.random;
  const captureRate = Number.isFinite(options.captureRate) ? options.captureRate : DEFAULT_CAPTURE_RATE;
  const suspenseMs = Number.isFinite(options.suspenseMs) ? options.suspenseMs : DEFAULT_SUSPENSE_MS;
  const wait = options.wait || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));

  async function execute(_client, msg, _args, context = {}) {
    const commandName = context.commandName || normalizeInput(msg.body).split(" ")[0];
    if (commandName !== "pokebola") return undefined;
    const pokemon = pokemonDataService.getRandomPokemon("multiple_choice", random);
    if (!pokemon) return msg.reply("❌ Nenhum Pokémon está disponível para captura agora.");
    const captured = random() < captureRate;
    await msg.reply("⚾ Pokébola, vai!...");
    await wait(suspenseMs);
    return msg.reply(captured ? `✨ ${pokemon.nome} foi capturado!` : `💨 Ah não! ${pokemon.nome} escapou da Pokébola!`);
  }

  return { name: "game", aliases: ["pokebola"], execute };
}

const command = createGameCommand();
module.exports = { ...command, createGameCommand, DEFAULT_CAPTURE_RATE, DEFAULT_SUSPENSE_MS };
