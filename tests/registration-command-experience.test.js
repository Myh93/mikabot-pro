"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const path = require("node:path");
const loader = require("../src/loader");
const pokemon = require("../src/commands/pokemon");
const guided = require("../src/services/registrationGuidedFlowService");
const experience = require("../src/services/memberExperienceService");
const publicQuery = require("../src/services/registrationPublicQueryService");
const edit = require("../src/services/registrationEditFlowService");

test("cadastro no privado aceita caixa e prefixo sem aceitar texto comum ou grupo", () => {
  for (const value of ["cadastro", "Cadastro", "CADASTRO", "!cadastro", "!CADASTRO"]) assert.equal(loader.resolvePrivateRegistrationCommand({ isGroup: false }, value), "cadastro");
  assert.equal(loader.resolvePrivateRegistrationCommand({ isGroup: false }, "quero cadastro"), null);
  assert.equal(loader.resolvePrivateRegistrationCommand({ isGroup: true }, "cadastro"), null);
  assert.ok(pokemon.aliases.includes("cadastro"));
});

test("mensagens de cadastro exibem somente a forma sem exclamação", async () => {
  const files = ["src/services/memberExperienceService.js", "src/services/registrationPublicQueryService.js", "src/services/registrationGuidedFlowService.js", "src/services/registrationEditFlowService.js", "src/commands/pokemon.js"];
  const source = (await Promise.all(files.map(file => fsp.readFile(path.join(__dirname, "..", file), "utf8")))).join("\n");
  assert.doesNotMatch(source, /!cadastro/i);
  assert.match(guided.GROUP_GUIDANCE, /\ncadastro\n/); assert.doesNotMatch(guided.GROUP_GUIDANCE, /!cadastro/i);
  assert.match(experience.registrationRequiredMessage(), /\ncadastro\n/); assert.doesNotMatch(experience.registrationRequiredMessage(), /!cadastro/i);
  assert.doesNotMatch(publicQuery.NOT_FOUND || "", /!cadastro/i); assert.doesNotMatch(edit.NOT_FOUND || "", /!cadastro/i);
});

test("atalho privado não altera Join Request nem cria listener", async () => {
  const source = await fsp.readFile(path.join(__dirname, "..", "src", "loader.js"), "utf8");
  assert.equal((source.match(/client\.on\("message"/g) || []).length, 1);
  assert.doesNotMatch(loader.resolvePrivateRegistrationCommand.toString(), /joinRequest|approve|revalid/i);
});
