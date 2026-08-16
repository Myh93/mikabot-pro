"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createMenuSessionService } = require("../src/services/menuSessionService");
const { createMenuRegistry, DEFINITIONS } = require("../src/services/menuRegistry");
const { createMenuAnswerHandler } = require("../src/events/menuAnswer");

function setup(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-menu-15-19-"));
  let now = new Date("2026-08-16T12:00:00.000Z");
  const sessions = createMenuSessionService({
    filePath: path.join(root, "sessions.json"), durationMs: 60_000,
    clock: () => new Date(now)
  });
  const permission = {
    hasPermission: (role, requirement) => !requirement.adminOnly || role?.rank >= 2,
    resolveRole: async () => options.role || { name: "member", rank: 0 }
  };
  const registry = createMenuRegistry({ sessionService: sessions, permissionService: permission, definitions: DEFINITIONS });
  const answer = createMenuAnswerHandler({ sessionService: sessions, registry });
  return { sessions, registry, answer, advance(ms) { now = new Date(now.getTime() + ms); } };
}

function context(userId = "member-a", conversationId = "group@g.us", platform = "whatsapp") {
  const replies = [];
  return {
    platform, conversationId, groupId: conversationId, userId,
    isGroup: conversationId.endsWith("@g.us"), replies,
    replyText: async text => replies.push(String(text))
  };
}

test("Pokédex e Counter iniciados no menu coletam o Pokémon e reutilizam o comando", async () => {
  for (const [selection, expected] of [["1", "pokedex Pikachu"], ["2", "counter Mewtwo"]]) {
    const f = setup();
    const ctx = context(`u-${selection}`);
    await f.registry.openMenu("pokemon", ctx, { name: "member", rank: 0 });
    const prompted = await f.answer.handleMenuAnswer({ context: ctx, text: selection, executeCommand: async () => undefined });
    assert.equal(prompted.status, "prompted");
    assert.doesNotMatch(ctx.replies.at(-1), /!pokedex|!counter/);
    const commands = [];
    const result = await f.answer.handleMenuAnswer({ context: ctx, text: selection === "1" ? "Pikachu" : "Mewtwo", executeCommand: async value => commands.push(value) });
    assert.equal(result.status, "executed_prompt");
    assert.deepEqual(commands, [expected]);
  }
});

test("Raid e Evento coletam dados pelo menu sem devolver sintaxe prefixada", async () => {
  for (const [menuId, selection, answer, command] of [
    ["raid", "8", "R1024", "lista R1024"],
    ["events", "3", "E0001", "ver evento E0001"]
  ]) {
    const f = setup();
    const ctx = context(`${menuId}-user`);
    await f.registry.openMenu(menuId, ctx, { name: "member", rank: 0 });
    const commands = [];
    const selected = await f.answer.handleMenuAnswer({ context: ctx, text: selection, executeCommand: async value => commands.push(value) });
    if (menuId === "events") {
      assert.equal(selected.status, "executed");
      assert.deepEqual(commands, ["ver evento"]);
      continue;
    }
    assert.equal(selected.status, "prompted");
    assert.doesNotMatch(ctx.replies.at(-1), /Use:|Envie:|![a-z]/i);
    await f.answer.handleMenuAnswer({ context: ctx, text: answer, executeCommand: async value => commands.push(value) });
    assert.deepEqual(commands, [command]);
  }
});

test("sessão pertence ao usuário, à conversa e à plataforma mesmo para administradores", async () => {
  const f = setup({ role: { name: "admin", rank: 2 } });
  const owner = context("member-a");
  await f.registry.openMenu("pokemon", owner, { name: "member", rank: 0 });
  assert.equal(await f.answer.hasActiveMenu(context("admin-a")), false);
  assert.equal(await f.answer.hasActiveMenu(context("member-a", "other@g.us")), false);
  assert.equal(await f.answer.hasActiveMenu(context("member-a", "group@g.us", "telegram")), false);
  assert.equal(await f.answer.hasActiveMenu(owner), true);
});

test("sessão expirada é encerrada silenciosamente e não intercepta conversa futura", async () => {
  const f = setup();
  const expired = context("expired-user");
  const active = context("active-user");
  await f.registry.openMenu("pokemon", expired, { name: "member", rank: 0 });
  f.advance(30_000);
  await f.registry.openMenu("quiz", active, { name: "member", rank: 0 });
  f.advance(31_000);
  assert.equal(await f.answer.hasActiveMenu(expired), false);
  assert.deepEqual(expired.replies.slice(-1), [expired.replies.at(-1)]);
  assert.equal((await f.sessions.getMenuState(expired)).status, "inactive");
  assert.equal(await f.answer.hasActiveMenu(active), true);
  assert.equal((await f.answer.handleMenuAnswer({ context: expired, text: "conversa comum", executeCommand: async () => assert.fail() })).status, "ignored");
});

test("Ajuda organiza descoberta e mantém ações administrativas invisíveis ao membro", async () => {
  const memberSetup = setup();
  const memberHelp = await memberSetup.registry.openMenu("help", context("member"), { name: "member", rank: 0 });
  assert.match(memberHelp.text, /Cadastro e Perfil|Raids|Feedback/);
  assert.doesNotMatch(memberHelp.text, /Administração/);
  const adminSetup = setup({ role: { name: "admin", rank: 2 } });
  const adminHelp = await adminSetup.registry.openMenu("help", context("admin"), { name: "admin", rank: 2 });
  assert.match(adminHelp.text, /Administração/);
});

test("Loader declara normalização segura sem prefixo e preserva frases comuns", () => {
  const loader = require("../src/loader");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "loader.js"), "utf8");
  assert.match(source, /PREFIX_OPTIONAL_COMMANDS/);
  assert.match(source, /PREFIX_OPTIONAL_WITH_ARGUMENTS/);
  assert.match(source, /resolveUnprefixedCommand/);
  for (const value of ["MENU", "QUIZ", "PERFIL", "POKEBOLA", "CADASTRO", "pokedex Pikachu"]) {
    assert.ok(loader.resolveUnprefixedCommand(value), value);
  }
  for (const value of ["o quiz ontem estava legal", "quiz ontem estava legal", "menu depois", "cancelar"]) {
    assert.equal(loader.resolveUnprefixedCommand(value), null, value);
  }
});

test("catálogo de ajuda torna recursos públicos e administrativos descobríveis por permissão", async () => {
  const memberSetup = setup();
  const member = await memberSetup.registry.openMenu("help", context("member-catalog"), { name: "member", rank: 0 });
  assert.match(member.text, /Outros recursos/);
  assert.doesNotMatch(member.text, /Comandos administrativos/);
  const adminSetup = setup({ role: { name: "admin", rank: 2 } });
  const admin = await adminSetup.registry.openMenu("help", context("admin-catalog"), { name: "admin", rank: 2 });
  assert.match(admin.text, /Comandos administrativos/);
  const shown = await adminSetup.answer.handleMenuAnswer({ context: context("admin-catalog"), text: "Comandos administrativos", executeCommand: async () => undefined });
  assert.equal(shown.status, "informed");
});
