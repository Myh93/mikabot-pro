"use strict";

const stateServiceDefault = require("./registrationStateService");
const { FALLBACK } = require("./registrationPrivateShortcutService");

const MEMBER_COMMANDS = new Set([
  "quiz", "maratona", "parar maratona", "perfil", "ranking", "conquistas",
  "game", "pokebola", "missoes", "missões", "jornada", "pokedex", "counter",
  "evento", "criar raid", "raid", "editar raid", "cancelar raid", "publicar raid",
  "listar raids", "listar raids arquivadas", "vou", "desistir", "lista",
  "treinador", "contas", "fc", "friendcode", "code", "codes", "codigo", "códigos", "friend",
  "treinadores"
]);

const MESSAGE = [
  "🔒 Este recurso é exclusivo para membros cadastrados.",
  "",
  "Conclua seu cadastro no privado do MikaBot.",
  "",
  FALLBACK
].join("\n");

function createRegistrationAccessService(options = {}) {
  const states = options.registrationStateService || stateServiceDefault;
  function requiresRegistration(command = {}, matchedName = "") {
    if (command.registrationRequired === true) return true;
    if (command.registrationRequired === false) return false;
    return MEMBER_COMMANDS.has(String(matchedName || command.name || "").toLocaleLowerCase("pt-BR"));
  }
  async function authorize(context, command, matchedName) {
    if (!requiresRegistration(command, matchedName)) return { allowed: true, state: null };
    const resolved = await states.resolveRegistrationState(context);
    return { allowed: resolved.state === states.STATES.ACTIVE, ...resolved };
  }
  return { requiresRegistration, authorize, MESSAGE, MEMBER_COMMANDS };
}

const service = createRegistrationAccessService();
module.exports = { ...service, createRegistrationAccessService, MESSAGE, MEMBER_COMMANDS };
