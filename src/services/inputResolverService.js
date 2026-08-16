"use strict";

const YES = new Set(["1", "sim", "s", "ss", "yes", "y", "ok", "confirmar", "confirmo", "continuar", "prosseguir"]);
const NO = new Set(["2", "nao", "n", "no", "cancelar resposta", "negativo"]);
const NAVIGATION = Object.freeze({
  menu: new Set(["0", "menu", "inicio", "home", "principal"]),
  confirm: new Set(["5", "confirmar", "confirmo", "ok", "prosseguir"]),
  draft: new Set(["6", "rascunho", "salvar", "salvar rascunho", "continuar depois"]),
  repeat: new Set(["7", "repetir", "repete", "novamente", "ajuda"]),
  back: new Set(["8", "voltar", "volta", "v", "anterior"]),
  cancel: new Set(["9", "cancelar", "cancela", "sair", "parar", "fechar"])
});

function normalizeInput(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("pt-BR")
    .replace(/^!+/, "")
    .replace(/\s+/g, " ");
}

function resolveYesNo(value) {
  const normalized = normalizeInput(value);
  if (YES.has(normalized)) return true;
  if (NO.has(normalized)) return false;
  return null;
}

function resolveNavigation(value) {
  const normalized = normalizeInput(value);
  for (const [action, aliases] of Object.entries(NAVIGATION)) if (aliases.has(normalized)) return action;
  return null;
}

function normalizeOption(option, index) {
  if (typeof option === "string" || typeof option === "number") return { value: option, aliases: [String(option)], number: index + 1 };
  return { value: option.value ?? option.id ?? option.key ?? index + 1, aliases: [option.label, option.name, option.id, option.key, ...(option.aliases || [])].filter(value => value !== undefined), number: option.number ?? index + 1 };
}

function resolveMenuOption(value, options = []) {
  const normalized = normalizeInput(value);
  for (let index = 0; index < options.length; index += 1) {
    const option = normalizeOption(options[index], index);
    if (normalized === String(option.number) || option.aliases.some(alias => normalizeInput(alias) === normalized)) return option.value;
  }
  return null;
}

function resolveMenuNavigation(value, options = {}) {
  const normalized = normalizeInput(value);
  if (!normalized) return null;
  if (normalized === "0") return options.canGoBack ? "back" : "close";
  if (["voltar", "volta", "anterior", "menu anterior"].includes(normalized)) return "back";
  if (["fechar", "sair", "cancelar", "cancelar menu", "encerrar"].includes(normalized)) return "close";
  if (["menu", "inicio", "home", "principal"].includes(normalized)) return "root";
  return null;
}

function resolveCommandAlias(value, commands = {}) {
  const normalized = normalizeInput(value);
  if (!normalized) return null;
  if (Array.isArray(commands)) {
    for (const command of commands) if ([command.name, ...(command.aliases || [])].some(alias => normalizeInput(alias) === normalized)) return command.name;
    return null;
  }
  for (const [command, aliases] of Object.entries(commands)) if ([command, ...(Array.isArray(aliases) ? aliases : [aliases])].some(alias => normalizeInput(alias) === normalized)) return command;
  return null;
}

module.exports = { normalizeInput, resolveYesNo, resolveNavigation, resolveMenuOption, resolveMenuNavigation, resolveCommandAlias };
