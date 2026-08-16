"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fsp = require("fs").promises;
const path = require("path");
const inputResolver = require("../src/services/inputResolverService");
const messageStyle = require("../src/services/messageStyleService");

const root = path.join(__dirname, "..");

test("release está marcada como MikaBot PRO v2.0 Stable", async () => {
  const pkg = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.version, "2.0.0"); assert.match(pkg.description, /MikaBot PRO v2\.0 Stable/);
});

test("documentação obrigatória existe e identifica a versão", async () => {
  for (const name of ["README.md", "CHANGELOG.md", "ARCHITECTURE.md", "ROADMAP.md", "VERSIONS.md"]) {
    const content = await fsp.readFile(path.join(root, name), "utf8"); assert.ok(content.length > 200, `${name} está incompleto`);
  }
  assert.match(await fsp.readFile(path.join(root, "VERSIONS.md"), "utf8"), /2\.0\.0[\s\S]*Stable/);
});

test("padrão visual central possui separador e estados estáveis", () => {
  assert.equal(messageStyle.SEPARATOR, "━━━━━━━━━━━━━━━━━━━━━━");
  assert.equal(messageStyle.status("success", "Concluído"), "✅ Concluído");
  assert.match(messageStyle.section("TÍTULO", ["Conteúdo"]), /TÍTULO[\s\S]*Conteúdo/);
});

test("fluxo de Eventos reutiliza o resolvedor central", async () => {
  const source = await fsp.readFile(path.join(root, "src", "services", "eventGuidedFlowService.js"), "utf8");
  assert.match(source, /inputResolver\.resolveYesNo/); assert.match(source, /inputResolver\.resolveNavigation/);
  assert.equal(/normalize\("NFD"\)[\s\S]{0,100}===\s*"nao"/.test(source), false);
  assert.equal(inputResolver.resolveYesNo(" NÃO "), false);
});

test("serviços de estilo e resolvedor não criam listeners", async () => {
  const sources = await Promise.all(["messageStyleService.js", "inputResolverService.js"].map(name => fsp.readFile(path.join(root, "src", "services", name), "utf8")));
  assert.equal(/client\.on\s*\(/.test(sources.join("\n")), false);
});
