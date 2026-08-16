"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createGuidedFlowAnswer, normalizeGuidedFlowContext } = require("../src/events/guidedFlowAnswer");
const { createRegistrationGuidedFlowAnswer } = require("../src/events/registrationGuidedFlowAnswer");
const { createPlatformContext } = require("../src/utils/platformContext");

const complete = overrides => ({
  platform: "whatsapp", conversationId: "group@g.us", groupId: "group@g.us",
  userId: "member@lid", isGroup: true, replyText: async () => undefined, ...overrides
});

function router(activeName = null) {
  const calls = [];
  const flow = name => ({
    hasActiveFlow: async context => {
      calls.push({ name, context });
      return name === activeName;
    },
    handleAnswer: async context => ({ status: name, context })
  });
  const event = flow("event");
  return {
    calls,
    handler: createGuidedFlowAnswer({
      raidGuidedFlow: flow("raid"), feedbackAdministrationFlow: flow("feedback_admin"),
      feedbackFlow: flow("feedback"), moderationWarningFlow: flow("warning"),
      moderationBanFlow: flow("ban"), linkApprovalFlow: flow("link"),
      eventGuidedFlow: event
    })
  };
}

test("normaliza contexto completo e usa groupId real como conversationId legado", () => {
  const normalized = normalizeGuidedFlowContext(complete());
  assert.deepEqual(
    { platform: normalized.platform, conversationId: normalized.conversationId, groupId: normalized.groupId, userId: normalized.userId, isGroup: normalized.isGroup },
    { platform: "whatsapp", conversationId: "group@g.us", groupId: "group@g.us", userId: "member@lid", isGroup: true }
  );
  const legacy = normalizeGuidedFlowContext(complete({ conversationId: undefined }));
  assert.equal(legacy.conversationId, "group@g.us");
  assert.equal(legacy.groupId, "group@g.us");
});

test("contextos sem platform, conversa ou usuário não consultam nenhum fluxo", async () => {
  for (const context of [
    complete({ platform: undefined }),
    complete({ conversationId: undefined, groupId: undefined }),
    complete({ userId: undefined })
  ]) {
    const f = router();
    assert.equal(await f.handler.hasActiveFlow(context), false);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await f.handler.handleGuidedFlowAnswer({ context, text: "1" }), { status: "ignored" });
    assert.deepEqual(f.calls, []);
  }
});

test("grupo entrega o mesmo contexto canônico para Raid e banimento", async () => {
  for (const active of ["raid", "ban"]) {
    const f = router(active);
    assert.equal(await f.handler.hasActiveFlow(complete()), true);
    const received = f.calls.at(-1).context;
    assert.deepEqual(
      { platform: received.platform, conversationId: received.conversationId, userId: received.userId, groupId: received.groupId, isGroup: received.isGroup },
      { platform: "whatsapp", conversationId: "group@g.us", userId: "member@lid", groupId: "group@g.us", isGroup: true }
    );
  }
});

test("Feedback comum e administrativo recebem contexto canônico", async () => {
  for (const active of ["feedback", "feedback_admin"]) {
    const f = router(active);
    assert.equal(await f.handler.hasActiveFlow(complete()), true);
    assert.equal(f.calls.find(call => call.name === active).context.conversationId, "group@g.us");
  }
});

test("mensagem privada preserva conversa e alcança Eventos sem usar identidade genérica", async () => {
  const f = router("event");
  const context = complete({ conversationId: "member@c.us", groupId: "member@c.us", userId: "member@c.us", isGroup: false });
  assert.equal(await f.handler.hasActiveFlow(context), true);
  assert.deepEqual(f.calls.at(-1).context, context);
});

test("Cadastro também recusa contexto incompleto e recebe o contexto canônico", async () => {
  const received = [];
  const registration = createRegistrationGuidedFlowAnswer({
    registrationGuidedFlowService: {
      hasActiveFlow: async context => (received.push(context), true),
      handleAnswer: async context => (received.push(context), { status: "handled" })
    }
  });
  assert.equal(await registration.hasActiveFlow(complete({ userId: undefined })), false);
  assert.equal(received.length, 0);
  assert.equal(await registration.hasActiveFlow(complete()), true);
  assert.equal(received[0].conversationId, "group@g.us");
});

test("createPlatformContext inclui conversationId em grupo e privado", async () => {
  const client = { sendMessage: async () => undefined };
  const group = await createPlatformContext(client, {
    from: "group@g.us", author: "member@lid", id: { _serialized: "message" },
    reply: async () => undefined, getChat: async () => ({ isGroup: true })
  }, { resolveContact: false, detectPrivateLinks: false });
  assert.equal(group.conversationId, group.groupId);
  assert.ok(group.userId);
  const privateMessage = {
    from: "5511999999999@c.us", id: { _serialized: "private-message" }, reply: async () => undefined,
    getChat: async () => ({ isGroup: false })
  };
  const privateContext = await createPlatformContext(client, privateMessage, { resolveContact: false, detectPrivateLinks: false });
  assert.equal(privateContext.conversationId, privateContext.groupId);
  assert.ok(privateContext.userId);
});

test("roteador não cria listeners", () => {
  const source = require("node:fs").readFileSync(require.resolve("../src/events/guidedFlowAnswer"), "utf8");
  assert.equal(/\.on\s*\(/.test(source), false);
});
