"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const { createRegistrationRepository } = require("../src/repositories/registrationRepository");
const { createRegistrationService } = require("../src/services/registrationService");
const { createRegistrationPublicQueryService, NOT_FOUND, INCOMPLETE, DUPLICATE } = require("../src/services/registrationPublicQueryService");
const { createRegistrationPublicQueryCommands } = require("../src/commands/registrationPublicQuery");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-public-query-"));
  const repository = createRegistrationRepository({ databaseDir: path.join(root, "db"), backupRoot: path.join(root, "backups") });
  const registrations = createRegistrationService({ repository });
  const service = createRegistrationPublicQueryService({ registrationService: registrations });
  return { root, repository, registrations, service };
}
const account = (index, overrides = {}) => ({ nick: `Alt${index}`, friendCode: String(200000000000 + index), team: index % 2 ? "valor" : "instinct", level: 50 + index, ...overrides });
const trainer = (identity = "5511999999999", overrides = {}) => ({ primaryIdentity: identity, name: "Mychelle Diniz", nick: "MychelleGO", friendCode: "123456789012", city: "Cidade Privada", mainAccount: { nick: "MychelleGO", friendCode: "123456789012", team: "mystic", level: 100 }, secondaryAccounts: [], playStyle: { fly: true, canela: true }, playSchedule: "Depois das 18h", ...overrides });

test("consulta própria no grupo e privado sem expor dados privados", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer());
  for (const isGroup of [true, false]) {
    const target = f.service.resolveQueryTarget({ msg: {}, args: [], context: { userId: "5511999999999", isGroup } });
    const result = await f.service.getPublicAccounts(target); assert.match(result.text, /MychelleGO/); assert.match(result.text, /1234 5678 9012/);
    for (const forbidden of ["5511999999999", "Cidade Privada", "Depois das 18h", "REG000", "ACC000", "@lid", "@c.us", "fly", "canela"]) assert.doesNotMatch(result.text, new RegExp(forbidden, "i"));
  }
});

test("prioriza menção explícita usando somente metadados", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer("abc@lid"));
  const msg = { mentionedIds: ["abc:2@lid"], getContact: () => { throw new Error("não chamar"); }, getChat: () => { throw new Error("não chamar"); } };
  const target = f.service.resolveQueryTarget({ msg, args: ["Outro"], context: { userId: "self" } }); assert.equal(target.value, "abc@lid");
  assert.match((await f.service.getPublicAccounts(target)).text, /MychelleGO/);
});

test("busca Nick e nome exatos normalizados, nunca parciais", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer());
  assert.equal((await f.service.findPublicTrainer("  MYCHELLEgo ")).status, "found");
  assert.equal((await f.service.findPublicTrainer("mychelle diniz")).status, "found");
  assert.equal((await f.service.findPublicTrainer("Mychelle")).status, "not_found");
  assert.equal((await f.service.findPublicTrainer("5678")).status, "not_found");
});

test("Nick duplicado não escolhe treinador arbitrariamente", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer("5511111111111")); await f.registrations.upsertRegistration(trainer("5522222222222", { name: "Outra", friendCode: "999988887777", mainAccount: { nick: "MychelleGO", friendCode: "999988887777", team: "valor", level: 2 } }));
  const result = await f.service.findPublicTrainer("MychelleGO"); assert.equal(result.status, "duplicate");
  assert.equal((await f.service.getPublicAccounts({ type: "text", value: "MychelleGO", page: 1 })).text, DUPLICATE);
});

test("trata inexistente, revisão, placeholder e conta principal inválida", async () => {
  const f = await fixture(); assert.equal((await f.service.getPublicAccounts({ type: "text", value: "ninguém", page: 1 })).text, NOT_FOUND);
  await f.repository.createRegistration({ registrationId: "REG000010", platform: "whatsapp", primaryIdentity: "review@lid", identityAliases: ["review@lid"], name: "Revisão", nick: "Review", friendCode: "123", city: "X", status: "review_required", validationStatus: "invalid_placeholder", source: "test", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), metadata: {} });
  assert.equal((await f.service.getPublicTrainer("review@lid")).status, "incomplete");
  assert.equal((await f.service.getPublicAccounts({ type: "identity", value: "review@lid", page: 1 })).text, INCOMPLETE);
});

test("formato completo mostra nenhuma, uma e várias secundárias em ordem", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer("5511", { secondaryAccounts: [account(1), account(2)] }));
  const result = await f.service.getPublicAccounts({ type: "identity", value: "5511", page: 1 });
  assert.ok(result.text.indexOf("MychelleGO") < result.text.indexOf("Alt1")); assert.ok(result.text.indexOf("Alt1") < result.text.indexOf("Alt2"));
  assert.match(result.text, /Mystic/); assert.match(result.text, /Nível:\n100/); assert.match(result.text, /Total de contas:\n3/);
  await f.registrations.upsertRegistration(trainer("5522", { nick: "Solo", friendCode: "444455556666", mainAccount: { nick: "Solo", friendCode: "444455556666", team: "valor", level: 999 } }));
  assert.match((await f.service.getPublicAccounts({ type: "identity", value: "5522", page: 1 })).text, /Contas secundárias\n\nNenhuma/);
});

test("formato compacto mostra somente Nicks e Friend Codes formatados", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer("5511", { secondaryAccounts: [account(1)] })); const text = (await f.service.getPublicFriendCodes({ type: "identity", value: "5511", page: 1 })).text;
  assert.match(text, /FRIEND CODES/); assert.match(text, /1234 5678 9012/); assert.match(text, /2000 0000 0001/); assert.doesNotMatch(text, /Mystic|Nível|mystic/); assert.match(text, /Total:\n2 contas/);
});

test("pagina mais de 10 contas e rejeita página inexistente", async () => {
  const f = await fixture(); await f.registrations.upsertRegistration(trainer("5511", { secondaryAccounts: Array.from({ length: 24 }, (_, index) => account(index + 1)) }));
  const page1 = await f.service.getPublicAccounts({ type: "identity", value: "5511", page: 1 }), page2 = await f.service.getPublicAccounts({ type: "identity", value: "5511", page: 2 });
  assert.match(page1.text, /Conta principal/); assert.match(page1.text, /Página 1 de 3/); assert.doesNotMatch(page2.text, /Conta principal/); assert.match(page2.text, /Página 2 de 3/);
  assert.equal((await f.service.getPublicAccounts({ type: "identity", value: "5511", page: 4 })).text, "❌ Esta página não possui contas.");
});

test("resolve paginação em menção, Nick e consulta própria", () => {
  const service = createRegistrationPublicQueryService({ registrationService: { normalizeFriendCode: value => String(value) } });
  assert.deepEqual(service.resolveQueryTarget({ msg: { mentionedIds: ["abc@lid"] }, args: ["@abc", "2"], context: { userId: "self" } }), { type: "identity", value: "abc@lid", page: 2, source: "mention" });
  assert.equal(service.resolveQueryTarget({ msg: {}, args: ["Meu Nick", "3"], context: { userId: "self" } }).page, 3);
  assert.equal(service.resolveQueryTarget({ msg: {}, args: ["2"], context: { userId: "self" } }).source, "self");
});

test("comandos, aliases e execução não consultam APIs adicionais", async () => {
  const calls = [], fakeService = { resolveQueryTarget: value => (calls.push(value), { page: 1 }), getPublicAccounts: async () => ({ text: "perfil" }), getPublicFriendCodes: async () => ({ text: "codes" }) };
  const commands = createRegistrationPublicQueryCommands({ registrationPublicQueryService: fakeService }); const trainerCommand = commands[0], fcCommand = commands[1];
  assert.deepEqual(trainerCommand.aliases, ["contas"]); for (const alias of ["friendcode", "code", "codes", "codigo", "códigos", "friend"]) assert.ok(fcCommand.aliases.includes(alias));
  let response; const msg = { from: "grupo@g.us", author: "user@lid", body: "!treinador", mentionedIds: [], reply: async text => { response = text; }, getContact: () => { throw new Error("não chamar"); }, getChat: () => { throw new Error("não chamar"); } };
  await trainerCommand.execute({}, msg, [], {}); assert.equal(response, "perfil"); assert.equal(calls.length, 1);
});

test("menu numérico oferece consulta e retorno por zero", async () => {
  const menu = require("../src/services/menuRegistry"); const definition = menu.getMenu("trainer_query"); assert.ok(definition); assert.equal(definition.backMenuId, "profile"); assert.equal(definition.options.length, 4);
  const source = await fsp.readFile(path.join(__dirname, "..", "src", "services", "registrationPublicQueryService.js"), "utf8"); const commandSource = await fsp.readFile(path.join(__dirname, "..", "src", "commands", "registrationPublicQuery.js"), "utf8");
  assert.equal(/client\.on\s*\(/.test(source + commandSource), false); assert.equal(/registrations\.json/.test(source + commandSource), false);
});
