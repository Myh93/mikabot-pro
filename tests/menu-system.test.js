"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createMenuSessionService } = require("../src/services/menuSessionService");
const { createMenuRegistry, DEFINITIONS } = require("../src/services/menuRegistry");
const { createMenuAnswerHandler } = require("../src/events/menuAnswer");

const member = { name: "member", rank: 0 };
const admin = { name: "admin", rank: 2 };

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-menu-"));
  let currentRole = options.role || member;
  const sessionService = createMenuSessionService({ filePath: path.join(root, "sessions.json"), durationMs: options.durationMs || 120_000, clock: options.clock });
  const permissionService = {
    hasPermission: (role, requirement) => {
      if (requirement.protectedOwnerOnly) return role?.rank >= 5;
      if (requirement.ownerOnly) return role?.rank >= 4;
      if (requirement.adminOnly) return role?.rank >= 2;
      return true;
    },
    resolveRole: async () => currentRole
  };
  const registry = createMenuRegistry({ sessionService, permissionService, definitions: DEFINITIONS });
  const answer = createMenuAnswerHandler({ sessionService, registry });
  return { root, sessionService, registry, answer, setRole: (role) => { currentRole = role; } };
}

function context(overrides = {}) {
  const replies = [];
  const value = {
    platform: "whatsapp", groupId: "group-a@g.us", conversationId: "group-a@g.us",
    userId: "user-a", isGroup: true, replies,
    replyText: async (text) => { replies.push(text); return text; },
    ...overrides
  };
  if (!Object.prototype.hasOwnProperty.call(overrides, "conversationId")) {
    value.conversationId = value.groupId;
  }
  return value;
}

test("menu principal filtra administração e renumera membro e admin", async () => {
  const memberFixture = fixture();
  const memberContext = context();
  const memberMenu = await memberFixture.registry.openMenu("main", memberContext, member);
  assert.strictEqual(Object.keys(memberMenu.options).length, 6);
  assert.doesNotMatch(memberMenu.text, /Administração/);
  assert.match(memberMenu.text, /número ou nome da opção/);

  const adminFixture = fixture({ role: admin });
  const adminContext = context();
  const adminMenu = await adminFixture.registry.openMenu("main", adminContext, admin);
  assert.strictEqual(Object.keys(adminMenu.options).length, 7);
  assert.match(adminMenu.text, /7️⃣ Administração/);
});

test("menus Quiz, Raid, Pokémon e Perfil possuem opções finais corretas", async () => {
  const { registry } = fixture();
  const expected = { quiz: 12, raid: 8, pokemon: 5, profile: 7 };
  for (const [menuId, count] of Object.entries(expected)) {
    const ctx = context({ userId: `user-${menuId}`, replies: [] });
    ctx.replyText = async (text) => ctx.replies.push(text);
    const opened = await registry.openMenu(menuId, ctx, member);
    assert.strictEqual(Object.keys(opened.options).length, count);
    assert.match(opened.text, /número ou nome da opção/);
  }
});

test("menu Eventos oculta ações administrativas de membros", async () => {
  const { registry } = fixture();
  const publicMenu = await registry.openMenu("events", context(), member);
  assert.strictEqual(Object.keys(publicMenu.options).length, 4);
  assert.match(publicMenu.text, /Criar Evento/);
  assert.doesNotMatch(publicMenu.text, /Editar Evento/);
  const adminMenu = await registry.openMenu("events", context({ userId: "admin", replies: [], replyText: async () => undefined }), admin);
  assert.strictEqual(Object.keys(adminMenu.options).length, 10);
});

test("menus Admin e Config exigem admin e conectam funções existentes", async () => {
  const { registry } = fixture();
  assert.strictEqual((await registry.openMenu("admin", context(), member)).status, "denied");
  const adminMenu = await registry.openMenu("admin", context({ userId: "admin", replies: [], replyText: async () => undefined }), admin);
  const configMenu = await registry.openMenu("config", context({ userId: "admin2", replies: [], replyText: async () => undefined }), admin);
  assert.strictEqual(Object.keys(adminMenu.options).length, 9);
  assert.strictEqual(Object.keys(configMenu.options).length, 7);
  assert.strictEqual(adminMenu.options["3"].menuId, "admin.warnings");
  assert.strictEqual(adminMenu.options["4"].menuId, "admin.bans");
});

test("opção válida encerra sessão e executa comando declarado", async () => {
  const { registry, answer, sessionService } = fixture();
  const ctx = context();
  await registry.openMenu("quiz", ctx, member);
  const commands = [];
  const result = await answer.handleMenuAnswer({ context: ctx, text: "1", executeCommand: async (command) => commands.push(command) });
  assert.strictEqual(result.status, "executed");
  assert.deepStrictEqual(commands, ["jogar quiz"]);
  assert.strictEqual(await sessionService.getActiveMenu(ctx), null);
});

test("opção inválida mantém menu aberto e mostra mensagem exata", async () => {
  const { registry, answer, sessionService } = fixture();
  const ctx = context();
  await registry.openMenu("quiz", ctx, member);
  ctx.replies.length = 0;
  const result = await answer.handleMenuAnswer({ context: ctx, text: "99", executeCommand: async () => undefined });
  assert.strictEqual(result.status, "invalid");
  assert.deepStrictEqual(ctx.replies, ["❌ Opção inválida. Escolha uma das opções do menu."]);
  assert.ok(await sessionService.getActiveMenu(ctx));
});

test("número sem menu é ignorado e sessão vencida é encerrada silenciosamente", async () => {
  let now = new Date("2026-07-15T20:00:00.000Z");
  const { registry, answer } = fixture({ clock: () => new Date(now), durationMs: 60_000 });
  const ctx = context();
  assert.strictEqual((await answer.handleMenuAnswer({ context: ctx, text: "1", executeCommand: async () => undefined })).status, "ignored");
  await registry.openMenu("quiz", ctx, member);
  now = new Date("2026-07-15T20:01:01.000Z");
  assert.strictEqual((await answer.handleMenuAnswer({ context: ctx, text: "1", executeCommand: async () => undefined })).status, "expired");
  assert.doesNotMatch(ctx.replies.at(-1), /Este menu expirou/);
});

test("usuários, grupos e plataformas ficam isolados com sessões simultâneas", async () => {
  const { registry, sessionService } = fixture();
  const contexts = [
    context({ userId: "u1" }), context({ userId: "u2" }),
    context({ userId: "u1", groupId: "group-b@g.us" }),
    context({ userId: "u1", platform: "telegram" })
  ];
  await Promise.all(contexts.map((ctx) => registry.openMenu("quiz", ctx, member)));
  for (const ctx of contexts) assert.ok(await sessionService.getActiveMenu(ctx));
  assert.strictEqual(await sessionService.getActiveMenu(context({ userId: "unknown" })), null);
});

test("novo menu substitui o anterior na mesma chave", async () => {
  const { registry, sessionService } = fixture();
  const ctx = context();
  await registry.openMenu("quiz", ctx, member);
  await registry.openMenu("raid", ctx, member);
  assert.strictEqual((await sessionService.getActiveMenu(ctx)).menuId, "raid");
});

test("seleção pode abrir outro menu", async () => {
  const { registry, answer, sessionService } = fixture();
  const ctx = context();
  await registry.openMenu("main", ctx, member);
  const result = await answer.handleMenuAnswer({ context: ctx, text: "2", executeCommand: async () => undefined });
  assert.strictEqual(result.status, "opened");
  assert.strictEqual((await sessionService.getActiveMenu(ctx)).menuId, "quiz");
});

test("contrato da sessão registra conversa, origem, grupo-alvo nulo, pilha e prazo de dois minutos", async () => {
  let now = new Date("2026-07-15T20:00:00.000Z");
  const { registry } = fixture({ clock: () => new Date(now) });
  const groupSession = (await registry.openMenu("main", context(), member)).session;
  assert.equal(groupSession.conversationId, "group-a@g.us");
  assert.equal(groupSession.origin, "group");
  assert.equal(groupSession.targetGroupId, null);
  assert.deepEqual(groupSession.stack, []);
  assert.equal(Date.parse(groupSession.expiresAt) - Date.parse(groupSession.openedAt), 120_000);

  const privateSession = (await registry.openMenu("main", context({ groupId: "private-user", isGroup: false }), member)).session;
  assert.equal(privateSession.origin, "private");
  assert.equal(privateSession.conversationId, "private-user");
});

test("nome e alias selecionam opções usando o resolvedor central", async () => {
  const { registry, answer, sessionService } = fixture({ role: admin });
  const ctx = context({ userId: "admin" });
  await registry.openMenu("admin", ctx, admin);
  const byName = await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "Segurança", executeCommand: async () => undefined });
  assert.equal(byName.status, "opened");
  assert.equal((await sessionService.getActiveMenu(ctx)).menuId, "admin.security");

  await registry.openMenu("admin", ctx, admin);
  const byAlias = await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "proteção", executeCommand: async () => undefined });
  assert.equal(byAlias.status, "opened");
});

test("voltar usa a pilha, voltar sem histórico usa o pai e zero no menu raiz fecha", async () => {
  const { registry, answer, sessionService } = fixture();
  const ctx = context();
  await registry.openMenu("main", ctx, member);
  await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "Quiz", executeCommand: async () => undefined });
  let active = await sessionService.getActiveMenu(ctx);
  assert.deepEqual(active.stack, ["main"]);
  await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "0", executeCommand: async () => undefined });
  active = await sessionService.getActiveMenu(ctx);
  assert.equal(active.menuId, "main");
  assert.deepEqual(active.stack, []);

  await registry.openMenu("quiz", ctx, member);
  await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "anterior", executeCommand: async () => undefined });
  assert.equal((await sessionService.getActiveMenu(ctx)).menuId, "main");

  const closed = await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "0", executeCommand: async () => undefined });
  assert.equal(closed.status, "closed");
  assert.equal(ctx.replies.at(-1), "✅ Menu fechado.");
  assert.equal(await sessionService.getActiveMenu(ctx), null);
  assert.equal((await answer.handleMenuAnswer({ context: ctx, text: "1" })).status, "ignored");
});

test("fechar aceita aliases universais", async () => {
  for (const input of ["fechar", "sair", "cancelar menu", "encerrar"]) {
    const { registry, answer } = fixture();
    const ctx = context({ userId: `user-${input}` });
    await registry.openMenu("main", ctx, member);
    assert.equal((await answer.handleMenuAnswer({ context: ctx, text: input })).status, "closed");
  }
});

test("resposta após timeout encerra a sessão sem interceptar conversa e não executa ação", async () => {
  let now = new Date("2026-07-15T20:00:00.000Z");
  const { registry, answer } = fixture({ clock: () => new Date(now) });
  const ctx = context();
  await registry.openMenu("quiz", ctx, member);
  now = new Date("2026-07-15T20:02:01.000Z");
  const commands = [];
  const expired = await answer.handleMenuAnswer({ context: ctx, text: "1", executeCommand: async command => commands.push(command) });
  assert.equal(expired.status, "expired");
  assert.doesNotMatch(ctx.replies.at(-1), /Este menu expirou/);
  assert.deepEqual(commands, []);
  assert.equal(await answer.hasActiveMenu(ctx), false);
});

test("texto comum inválido não é consumido e número inválido não renova o prazo", async () => {
  let now = new Date("2026-07-15T20:00:00.000Z");
  const { registry, answer, sessionService } = fixture({ clock: () => new Date(now) });
  const ctx = context();
  const opened = await registry.openMenu("quiz", ctx, member);
  now = new Date("2026-07-15T20:00:30.000Z");
  assert.equal((await answer.handleMenuAnswer({ context: ctx, text: "conversa normal" })).status, "ignored");
  assert.equal((await answer.handleMenuAnswer({ context: ctx, text: "99" })).status, "invalid");
  assert.equal((await sessionService.getActiveMenu(ctx)).expiresAt, opened.session.expiresAt);
});

test("membro não acessa opção administrativa escondida por número ou alias", async () => {
  const { registry, answer } = fixture();
  const ctx = context();
  await registry.openMenu("main", ctx, member);
  assert.equal((await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "Administração", executeCommand: async () => undefined })).status, "ignored");
  assert.equal((await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "7", executeCommand: async () => undefined })).status, "invalid");
});

test("Segurança separa advertências, bans, links, histórico e configurações", async () => {
  const { registry, answer } = fixture({ role: admin });
  const ctx = context({ userId: "admin" });
  await registry.openMenu("admin.security", ctx, admin);
  const result = await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "Advertências", executeCommand: async () => assert.fail("abre submenu") });
  assert.equal(result.status, "opened");
  assert.match(ctx.replies.at(-1), /ADVERTÊNCIAS/);
  assert.equal((await registry.openMenu("admin.security", ctx, admin)).status, "opened");
});

test("opção guiada mantém a sessão aberta e renova o prazo", async () => {
  let now = new Date("2026-07-15T20:00:00.000Z");
  const { registry, answer, sessionService } = fixture({ clock: () => new Date(now) });
  const ctx = context();
  const opened = await registry.openMenu("raid", ctx, member);
  now = new Date("2026-07-15T20:01:00.000Z");
  const result = await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "Editar Raid", executeCommand: async () => assert.fail("não existe fluxo guiado de edição de Raid") });
  assert.equal(result.status, "prompted");
  const active = await sessionService.getActiveMenu(ctx);
  assert.equal(active.menuId, "raid");
  assert.ok(Date.parse(active.expiresAt) > Date.parse(opened.session.expiresAt));
});

test("integrações do Quiz chamam as entradas oficiais e fecham a sessão", async () => {
  const cases = [
    ["Jogar Quiz", "jogar quiz"],
    ["Quiz Individual", "jogar quiz individual"],
    ["Maratona", "maratona"],
    ["Ranking do Grupo", "ranking grupo"],
    ["Estatísticas", "perfil"],
    ["Perfil do Quiz", "perfil quiz"],
    ["Conquistas", "conquistas"],
    ["Ajuda", "ajuda quiz"]
  ];
  for (const [selection, expectedCommand] of cases) {
    const { registry, answer, sessionService } = fixture();
    const ctx = context({ userId: `quiz-${expectedCommand}` });
    await registry.openMenu("quiz", ctx, member);
    const commands = [];
    const result = await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: selection, executeCommand: async command => commands.push(command) });
    assert.equal(result.status, "executed");
    assert.deepEqual(commands, [expectedCommand]);
    assert.equal(await sessionService.getActiveMenu(ctx), null);
  }
});

test("integrações de Perfil usam os comandos existentes", async () => {
  const cases = [
    ["Meu Perfil", "perfil"],
    ["Cadastro", "cadastro"],
    ["Ranking", "ranking"],
    ["Conquistas", "conquistas"],
    ["Perfil do Quiz", "perfil quiz"],
    ["Contas cadastradas", "treinador"]
  ];
  for (const [selection, expectedCommand] of cases) {
    const { registry, answer } = fixture();
    const ctx = context({ userId: `profile-${expectedCommand}` });
    await registry.openMenu("profile", ctx, member);
    const commands = [];
    await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: selection, executeCommand: async command => commands.push(command) });
    assert.deepEqual(commands, [expectedCommand]);
  }
});

test("Raids integram criação, listagem e coletam argumentos das demais ações", async () => {
  const { registry, answer, sessionService } = fixture();
  const ctx = context();
  await registry.openMenu("raid", ctx, member);
  const commands = [];
  await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "Listar Raids", executeCommand: async command => commands.push(command) });
  assert.deepEqual(commands, ["listar raids"]);
  assert.equal(await sessionService.getActiveMenu(ctx), null);

  await registry.openMenu("raid", ctx, member);
  await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "Criar Raid", executeCommand: async command => commands.push(command) });
  assert.deepEqual(commands, ["listar raids", "criar raid"]);
  assert.equal(await sessionService.getActiveMenu(ctx), null);

  for (const selection of ["Editar Raid", "Cancelar Raid", "Publicar Raid", "Entrar em Raid", "Desistir de Raid", "Ver Participantes"]) {
    await registry.openMenu("raid", ctx, member);
    const result = await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: selection, executeCommand: async () => assert.fail("a coleta ainda não executa") });
    assert.equal(result.status, "prompted");
    assert.ok(await sessionService.getActiveMenu(ctx));
  }
});

test("Eventos no privado abrem o menu oficial privado e encaminham fluxos existentes", async () => {
  const { registry, answer, sessionService } = fixture({ role: admin });
  const ctx = context({ groupId: "private-user", userId: "admin", isGroup: false });
  await registry.openMenu("main", ctx, admin);
  const opened = await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "Eventos", executeCommand: async () => undefined });
  assert.equal(opened.status, "opened");
  assert.equal((await sessionService.getActiveMenu(ctx)).menuId, "events_private");

  const cases = [["Criar evento", "criar evento"], ["Editar evento", "editar evento"], ["Cancelar evento", "cancelar evento"], ["Ver agendados", "eventos agendados"]];
  for (const [selection, expectedCommand] of cases) {
    await registry.openMenu("events_private", ctx, admin);
    const commands = [];
    await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: selection, executeCommand: async command => commands.push(command) });
    assert.deepEqual(commands, [expectedCommand]);
  }
});

test("Pokémon coleta pesquisas de forma guiada e executa Pokébola", async () => {
  const { registry, answer, sessionService } = fixture();
  const ctx = context();
  for (const selection of ["Pokédex", "Counters"]) {
    await registry.openMenu("pokemon", ctx, member);
    assert.equal((await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: selection, executeCommand: async () => assert.fail("a coleta ainda não executa") })).status, "prompted");
    assert.ok(await sessionService.getActiveMenu(ctx));
  }
  await registry.openMenu("pokemon", ctx, member);
  const commands = [];
  await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "Pokébola", executeCommand: async command => commands.push(command) });
  assert.deepEqual(commands, ["pokebola"]);
});

test("integração interna usa a mensagem real sem mensagem falsa ou recursão", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "loader.js"), "utf8");
  assert.doesNotMatch(source, /createCommandMessage|Object\.create\(msg\)/);
  assert.match(source, /dispatchCommand\(client, msg, text\)/);
  assert.equal((source.match(/client\.on\("message"/g) || []).length, 1);
});

test("falha de persistência retorna erro seguro sem executar destino", async () => {
  const registry = { parentMenuId: () => null };
  const answer = createMenuAnswerHandler({
    registry,
    sessionService: { getMenuState: async () => { throw new Error("persistência indisponível"); } }
  });
  let executed = false;
  const result = await answer.handleMenuAnswer({ context: context(), text: "1", executeCommand: async () => { executed = true; } });
  assert.equal(result.status, "error");
  assert.equal(executed, false);
});

test("permissão administrativa é revalidada na seleção", async () => {
  const { registry, answer, setRole } = fixture({ role: admin });
  const ctx = context();
  await registry.openMenu("events", ctx, admin);
  setRole(member);
  ctx.replies.length = 0;
  const result = await answer.handleMenuAnswer({ context: ctx, client: {}, msg: {}, text: "5", executeCommand: async () => undefined });
  assert.strictEqual(result.status, "denied");
  assert.deepStrictEqual(ctx.replies, ["❌ Você não tem permissão para acessar esta opção."]);
});

test("persistência é atômica e não deixa temporários", async () => {
  const { registry, root } = fixture();
  await Promise.all(Array.from({ length: 8 }, (_, index) => registry.openMenu("quiz", context({ userId: `u${index}` }), member)));
  assert.deepStrictEqual(fs.readdirSync(root).filter((file) => file.endsWith(".tmp")), []);
  const stored = JSON.parse(fs.readFileSync(path.join(root, "sessions.json"), "utf8"));
  assert.strictEqual(Object.keys(stored.sessions).length, 8);
});

test("loader aplica gate antes do Quiz, não entrega ao menu e mantém um único listener", async () => {
  const loader = require("../src/loader");
  const quizAnswer = require("../src/events/quizAnswer");
  const menuAnswer = require("../src/events/menuAnswer");
  const originals = {
    quizActive: quizAnswer.hasActiveRound, quizHandle: quizAnswer.handleQuizAnswer,
    menuActive: menuAnswer.hasActiveMenu, menuHandle: menuAnswer.handleMenuAnswer
  };
  let quizHandled = 0;
  let menuHandled = 0;
  quizAnswer.hasActiveRound = async () => true;
  quizAnswer.handleQuizAnswer = async () => { quizHandled += 1; };
  menuAnswer.hasActiveMenu = async () => true;
  menuAnswer.handleMenuAnswer = async () => { menuHandled += 1; };
  try {
    const client = { listeners: [], on(event, listener) { this.listeners.push({ event, listener }); }, sendMessage: async () => undefined };
    loader.attach(client);
    loader.attach(client);
    assert.strictEqual(client.listeners.filter(item => item.event === "message").length, 1);
    assert.strictEqual(client.listeners.filter(item => item.event === "group_membership_request").length, 1);
    const replies = [];
    await client.listeners.find(item => item.event === "message").listener({
      fromMe: false,
      from: "group@g.us",
      author: "123@c.us",
      body: "1",
      reply: async text => replies.push(String(text))
    });
    assert.strictEqual(quizHandled, 0);
    assert.strictEqual(menuHandled, 0);
    assert.match(replies.at(-1), /exclusivo para membros cadastrados/);
  } finally {
    quizAnswer.hasActiveRound = originals.quizActive;
    quizAnswer.handleQuizAnswer = originals.quizHandle;
    menuAnswer.hasActiveMenu = originals.menuActive;
    menuAnswer.handleMenuAnswer = originals.menuHandle;
  }
});

test("loader ignora número sem Quiz e sem menu", async () => {
  const loader = require("../src/loader");
  const quizAnswer = require("../src/events/quizAnswer");
  const menuAnswer = require("../src/events/menuAnswer");
  const quizOriginal = quizAnswer.hasActiveRound;
  const menuOriginal = menuAnswer.hasActiveMenu;
  let handled = 0;
  quizAnswer.hasActiveRound = async () => false;
  menuAnswer.hasActiveMenu = async () => false;
  const menuHandleOriginal = menuAnswer.handleMenuAnswer;
  menuAnswer.handleMenuAnswer = async () => { handled += 1; };
  try {
    const client = { listener: null, on(event, listener) { if (event === "message") this.listener = listener; }, sendMessage: async () => undefined };
    loader.attach(client);
    await client.listener({ fromMe: false, from: "group@g.us", author: "123@c.us", body: "42" });
    assert.strictEqual(handled, 0);
  } finally {
    quizAnswer.hasActiveRound = quizOriginal;
    menuAnswer.hasActiveMenu = menuOriginal;
    menuAnswer.handleMenuAnswer = menuHandleOriginal;
  }
});

test("comando permanece prioritário e não entrega a entrada ao menu aberto", async () => {
  const loader = require("../src/loader");
  const menuAnswer = require("../src/events/menuAnswer");
  const activeOriginal = menuAnswer.hasActiveMenu;
  const handleOriginal = menuAnswer.handleMenuAnswer;
  let menuHandled = 0;
  menuAnswer.hasActiveMenu = async () => true;
  menuAnswer.handleMenuAnswer = async () => { menuHandled += 1; };
  const replies = [];
  try {
    const client = { listener: null, on(event, listener) { if (event === "message") this.listener = listener; }, sendMessage: async () => undefined };
    loader.attach(client);
    await client.listener({ fromMe: false, from: "group@g.us", author: "123@c.us", body: "!regras", reply: async text => replies.push(text) });
    assert.equal(menuHandled, 0);
    assert.equal(replies.length, 1);
    assert.match(replies[0], /REGRAS OFICIAIS/);
  } finally {
    menuAnswer.hasActiveMenu = activeOriginal;
    menuAnswer.handleMenuAnswer = handleOriginal;
  }
});

test("Cadastro e fluxo guiado permanecem antes do menu", async () => {
  const loader = require("../src/loader");
  const quizAnswer = require("../src/events/quizAnswer");
  const registration = require("../src/events/registrationGuidedFlowAnswer");
  const guided = require("../src/events/guidedFlowAnswer");
  const menu = require("../src/events/menuAnswer");
  const originals = {
    quizActive: quizAnswer.hasActiveRound,
    registrationActive: registration.hasActiveFlow,
    registrationHandle: registration.handleRegistrationGuidedFlowAnswer,
    guidedActive: guided.hasActiveFlow,
    guidedHandle: guided.handleGuidedFlowAnswer,
    menuActive: menu.hasActiveMenu,
    menuHandle: menu.handleMenuAnswer
  };
  let registrationHandled = 0;
  let guidedHandled = 0;
  let menuHandled = 0;
  quizAnswer.hasActiveRound = async () => false;
  menu.hasActiveMenu = async () => true;
  menu.handleMenuAnswer = async () => { menuHandled += 1; };
  try {
    const client = { listener: null, on(event, listener) { if (event === "message") this.listener = listener; }, sendMessage: async () => undefined };
    loader.attach(client);
    registration.hasActiveFlow = async () => true;
    registration.handleRegistrationGuidedFlowAnswer = async () => { registrationHandled += 1; };
    guided.hasActiveFlow = async () => false;
    await client.listener({ fromMe: false, from: "private-user", body: "1" });
    assert.equal(registrationHandled, 1);
    assert.equal(menuHandled, 0);

    registration.hasActiveFlow = async () => false;
    guided.hasActiveFlow = async () => true;
    guided.handleGuidedFlowAnswer = async () => { guidedHandled += 1; };
    await client.listener({ fromMe: false, from: "private-user", body: "2" });
    assert.equal(guidedHandled, 1);
    assert.equal(menuHandled, 0);
  } finally {
    quizAnswer.hasActiveRound = originals.quizActive;
    registration.hasActiveFlow = originals.registrationActive;
    registration.handleRegistrationGuidedFlowAnswer = originals.registrationHandle;
    guided.hasActiveFlow = originals.guidedActive;
    guided.handleGuidedFlowAnswer = originals.guidedHandle;
    menu.hasActiveMenu = originals.menuActive;
    menu.handleMenuAnswer = originals.menuHandle;
  }
});

test("loader encaminha nome de opção ao menu somente no último estágio", async () => {
  const loader = require("../src/loader");
  const quizAnswer = require("../src/events/quizAnswer");
  const registration = require("../src/events/registrationGuidedFlowAnswer");
  const guided = require("../src/events/guidedFlowAnswer");
  const menu = require("../src/events/menuAnswer");
  const originals = {
    quiz: quizAnswer.hasActiveRound, registration: registration.hasActiveFlow,
    guided: guided.hasActiveFlow, active: menu.hasActiveMenu, handle: menu.handleMenuAnswer
  };
  let received = null;
  quizAnswer.hasActiveRound = async () => false;
  registration.hasActiveFlow = async () => false;
  guided.hasActiveFlow = async () => false;
  menu.hasActiveMenu = async () => true;
  menu.handleMenuAnswer = async input => { received = input.text; };
  try {
    const client = { listener: null, on(event, listener) { if (event === "message") this.listener = listener; }, sendMessage: async () => undefined };
    loader.attach(client);
    await client.listener({ fromMe: false, from: "group@g.us", author: "123@c.us", body: "Pokémon" });
    assert.equal(received, "Pokémon");
  } finally {
    quizAnswer.hasActiveRound = originals.quiz;
    registration.hasActiveFlow = originals.registration;
    guided.hasActiveFlow = originals.guided;
    menu.hasActiveMenu = originals.active;
    menu.handleMenuAnswer = originals.handle;
  }
});

test("falha ao consultar chat não concede admin dinâmico", async () => {
  const loader = require("../src/loader");
  const replies = [];
  const msg = {
    from: "grupo-seguro@g.us", author: "usuario@lid", body: "!admin",
    getContact: async () => ({ id: { _serialized: "usuario@lid" } }),
    getChat: async () => { throw new Error("r"); },
    reply: async (text) => replies.push(String(text))
  };
  await loader.dispatchCommand({ info: {}, sendMessage: async () => undefined }, msg, "admin");
  assert.deepEqual(replies, ["❌ Apenas admins!"]);
});

test("comandos escritos continuam registrados e executáveis", async () => {
  const loader = require("../src/loader");
  const commands = Object.values(loader);
  assert.ok(commands.find((command) => command.name === "quiz").aliases.includes("jogar quiz"));
  assert.ok(commands.find((command) => command.name === "game").aliases.includes("pokebola"));
  assert.ok(commands.find((command) => command.name === "criar raid").aliases.includes("raid"));
  assert.ok(commands.find((command) => command.name === "config").adminOnly);
  const replies = [];
  const msg = {
    from: "group@g.us", author: "123@c.us", body: "!proximo quiz",
    getContact: async () => ({ number: "123", id: { user: "123" } }),
    reply: async (text) => replies.push(text)
  };
  assert.strictEqual(await loader.dispatchCommand({ sendMessage: async () => undefined }, msg, "proximo quiz"), true);
  assert.deepStrictEqual(replies, ["⏰ Nenhum Quiz programado neste grupo."]);
});
