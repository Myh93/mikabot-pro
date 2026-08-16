"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMenuAnswerHandler } = require("../src/events/menuAnswer");
const { createMenuSessionService } = require("../src/services/menuSessionService");
const { createPlatformContext } = require("../src/utils/platformContext");

function canonical(overrides = {}) {
  return {
    platform: "whatsapp",
    conversationId: "conversation@g.us",
    groupId: "conversation@g.us",
    userId: "member@lid",
    isGroup: true,
    replyText: async () => undefined,
    ...overrides
  };
}

function service() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-menu-context-"));
  return createMenuSessionService({ filePath: path.join(root, "sessions.json") });
}

test("roteador ignora contextos ausente e incompletos sem consultar a sessao", async () => {
  let calls = 0;
  const answer = createMenuAnswerHandler({
    sessionService: { getMenuState: async () => { calls += 1; return { status: "inactive" }; } }
  });
  for (const context of [
    null,
    canonical({ platform: undefined }),
    canonical({ conversationId: undefined }),
    canonical({ userId: undefined })
  ]) {
    assert.equal(await answer.hasActiveMenu(context), false);
    assert.deepEqual(await answer.handleMenuAnswer({ context, text: "1" }), { status: "ignored" });
  }
  assert.equal(calls, 0);
});

test("sessao aceita contexto canonico, distingue menu ativo e inexistente", async () => {
  const sessions = service();
  const context = canonical();
  assert.equal((await sessions.getMenuState(context)).status, "inactive");
  await sessions.openMenu(context, { menuId: "main", options: {} });
  assert.equal((await sessions.getMenuState(context)).status, "active");
});

test("servico retorna contratos seguros e buildMenuKey permanece estrito", async () => {
  const sessions = service();
  const invalid = canonical({ conversationId: "" });
  assert.equal((await sessions.getMenuState(invalid)).status, "ignored");
  assert.equal(await sessions.getActiveMenu(invalid), null);
  assert.equal((await sessions.selectOption(invalid, "1")).status, "ignored");
  assert.equal(await sessions.closeMenu(invalid), false);
  assert.throws(() => sessions.buildMenuKey("whatsapp", "", "member"), /obrigat/);
});

test("mensagens sem body ou caption e midias produzem contexto canonico sem excecao", async () => {
  const answer = createMenuAnswerHandler({
    sessionService: { getMenuState: async () => ({ status: "inactive", session: null }) }
  });
  for (const type of ["image", "sticker", "audio", "video", "document", "system"]) {
    const msg = {
      type,
      from: "conversation@g.us",
      author: "member@lid",
      reply: async () => undefined,
      getChat: async () => ({ isGroup: true, id: { _serialized: "conversation@g.us" } })
    };
    const context = await createPlatformContext({ sendMessage: async () => undefined }, msg, {
      resolveContact: false,
      detectPrivateLinks: false
    });
    assert.equal(await answer.hasActiveMenu(context), false);
    assert.equal((await answer.handleMenuAnswer({ context, text: msg.body || msg.caption })).status, "ignored");
  }
});

test("Loader cria o contexto antes de consultar o menu e permanece inalterado", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "loader.js"), "utf8");
  const contextAt = source.indexOf("createPlatformContext(client, msg");
  const menuAt = source.indexOf("menuAnswer.hasActiveMenu");
  assert.ok(contextAt >= 0);
  assert.ok(menuAt > contextAt);
});
