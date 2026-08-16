"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const resolver = require("../src/services/inputResolverService");

test("resolve todas as variantes de SIM", () => {
  for (const value of ["1", "sim", "s", "ss", "yes", "y", "ok", "confirmar", "confirmo", "continuar", "prosseguir"]) assert.equal(resolver.resolveYesNo(value), true, value);
});
test("resolve todas as variantes de NÃO", () => {
  for (const value of ["2", "nao", "não", "n", "no", "cancelar resposta", "negativo"]) assert.equal(resolver.resolveYesNo(value), false, value);
});
test("resolve navegação universal", () => {
  const variants = { back: ["8", "voltar", "volta", "v", "anterior", "!voltar"], menu: ["0", "menu", "inicio", "início", "home", "principal", "!menu"], cancel: ["9", "cancelar", "cancela", "sair", "parar", "fechar", "!sair"], repeat: ["7", "repetir", "repete", "novamente", "ajuda"], draft: ["6", "rascunho", "salvar", "salvar rascunho", "continuar depois", "!rascunho"], confirm: ["5", "confirmar", "confirmo", "ok", "prosseguir"] };
  for (const [action, values] of Object.entries(variants)) for (const value of values) assert.equal(resolver.resolveNavigation(value), action, value);
});
test("ignora acentos, caixa e espaços extras", () => {
  assert.equal(resolver.normalizeInput("  NÃO  "), "nao"); assert.equal(resolver.normalizeInput("  InÍcIo   Principal "), "inicio principal"); assert.equal(resolver.resolveYesNo(" SiM "), true);
});
test("retorna null para entradas inválidas", () => {
  assert.equal(resolver.resolveYesNo("talvez"), null); assert.equal(resolver.resolveNavigation("42"), null); assert.equal(resolver.resolveMenuOption("x", ["a"]), null); assert.equal(resolver.resolveCommandAlias("x", {}), null);
});
test("resolve opções numéricas, texto e aliases", () => {
  const options = [{ value: "valor", label: "Valor", aliases: ["vermelho"] }, { value: "mystic", label: "Mystic", aliases: ["sabedoria"] }];
  assert.equal(resolver.resolveMenuOption("1", options), "valor"); assert.equal(resolver.resolveMenuOption(" SABEDORIA ", options), "mystic");
});

test("resolve navegação específica do MikaMenu sem ambiguidade no zero", () => {
  assert.equal(resolver.resolveMenuNavigation("0", { canGoBack: true }), "back");
  assert.equal(resolver.resolveMenuNavigation("0", { canGoBack: false }), "close");
  for (const input of ["voltar", "anterior", "menu anterior"]) assert.equal(resolver.resolveMenuNavigation(input), "back");
  for (const input of ["fechar", "sair", "cancelar menu", "encerrar"]) assert.equal(resolver.resolveMenuNavigation(input), "close");
  assert.equal(resolver.resolveMenuNavigation("MENU"), "root");
  assert.equal(resolver.resolveMenuNavigation("texto comum"), null);
});
test("resolve comandos e aliases com ou sem exclamação", () => {
  const commands = [{ name: "cadastro", aliases: ["cadastrar", "registro"] }];
  assert.equal(resolver.resolveCommandAlias("!Cadastrar", commands), "cadastro"); assert.equal(resolver.resolveCommandAlias("registro", { cadastro: ["registrar", "registro"] }), "cadastro");
});
