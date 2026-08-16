"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createFeedbackRepository } = require("../src/repositories/feedbackRepository");
const { createFeedbackService } = require("../src/services/feedbackService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-feedback-"));
  const filePath = path.join(root, "feedback.json");
  const flowPath = path.join(root, "flows.json");
  const repository = createFeedbackRepository({ filePath });
  const flows = createGuidedFlowService({ filePath: flowPath });
  const notifications = [];
  const service = createFeedbackService({
    repository,
    guidedFlowService: flows,
    notifier: async (author, message) => notifications.push({ author, message })
  });
  return { root, filePath, flowPath, repository, flows, service, notifications };
}

const cleanup = root => fsp.rm(root, { recursive: true, force: true });
const admin = { userId: "admin@lid", role: { isAdmin: true, rank: 2 } };
const user = id => ({ userId: id });
const context = (id = "user@lid", overrides = {}) => {
  const replies = [];
  return {
    platform: "whatsapp", groupId: "group@g.us", conversationId: "group@g.us",
    userId: id, communityId: "community-1", isGroup: true,
    replyText: async text => replies.push(String(text)), replies, ...overrides
  };
};

test("banco vazio inicia válido e primeiro protocolo é FB000001", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.repository.listFeedbacks(), []);
    const item = await f.service.createFeedback({
      tipo: "ERROR", autor: "one@lid", plataforma: "whatsapp", descricao: "Falha detalhada"
    });
    assert.equal(item.id, "FB000001");
    assert.equal(item.status, "NEW");
    assert.equal((await f.repository.load()).nextId, 2);
  } finally { await cleanup(f.root); }
});

test("protocolos são sequenciais, persistentes e nunca reutilizados", async () => {
  const f = await fixture();
  try {
    const first = await f.service.createFeedback({ tipo: "ERROR", autor: "a", plataforma: "whatsapp", descricao: "A" });
    const second = await f.service.createFeedback({ tipo: "QUESTION", autor: "b", plataforma: "whatsapp", descricao: "B" });
    assert.deepEqual([first.id, second.id], ["FB000001", "FB000002"]);
    const restarted = createFeedbackService({
      repository: createFeedbackRepository({ filePath: f.filePath }),
      guidedFlowService: createGuidedFlowService({ filePath: f.flowPath })
    });
    const third = await restarted.createFeedback({ tipo: "SUGGESTION", autor: "c", plataforma: "whatsapp", descricao: "C" });
    assert.equal(third.id, "FB000003");
  } finally { await cleanup(f.root); }
});

test("fluxo cria, permite editar descrição e confirma protocolo", async () => {
  const f = await fixture();
  const ctx = context();
  try {
    await f.service.start(ctx);
    assert.match(ctx.replies.at(-1), /AJUDA E FEEDBACK/);
    await f.service.handleAnswer(ctx, "1");
    assert.match(ctx.replies.at(-1), /Descreva/);
    await f.service.handleAnswer(ctx, "Descrição inicial");
    assert.match(ctx.replies.at(-1), /Confirmar envio/);
    await f.service.handleAnswer(ctx, "2");
    await f.service.handleAnswer(ctx, "Descrição corrigida");
    const result = await f.service.handleAnswer(ctx, "1");
    assert.equal(result.status, "created");
    assert.equal(result.feedback.descricao, "Descrição corrigida");
    assert.match(ctx.replies.at(-1), /FB000001/);
    assert.equal(await f.service.hasActiveFlow(ctx), false);
  } finally { await cleanup(f.root); }
});

test("cancelamento não cria feedback", async () => {
  const f = await fixture();
  const ctx = context();
  try {
    await f.service.start(ctx);
    await f.service.handleAnswer(ctx, "2");
    await f.service.handleAnswer(ctx, "Uma sugestão");
    assert.equal((await f.service.handleAnswer(ctx, "3")).status, "cancelled");
    assert.deepEqual(await f.repository.listFeedbacks(), []);
  } finally { await cleanup(f.root); }
});

test("filtros por status, tipo, autor, grupo e data são combináveis", async () => {
  const f = await fixture();
  try {
    const a = await f.service.createFeedback({ tipo: "ERROR", autor: "a", plataforma: "whatsapp", grupo: "g1", descricao: "A", createdAt: "2026-08-01T10:00:00.000Z" });
    await f.service.createFeedback({ tipo: "QUESTION", autor: "b", plataforma: "whatsapp", grupo: "g2", descricao: "B", createdAt: "2026-08-02T10:00:00.000Z" });
    await f.service.updateFeedback(a.id, { status: "IN_PROGRESS" }, admin);
    assert.equal((await f.service.listFeedbacks({ status: "IN_PROGRESS" }, admin)).length, 1);
    assert.equal((await f.service.listFeedbacks({ tipo: "QUESTION", autor: "b", grupo: "g2", data: "2026-08-02" }, admin)).length, 1);
    assert.equal((await f.service.listFeedbacks({}, user("a"))).length, 1);
  } finally { await cleanup(f.root); }
});

test("usuário consulta somente os próprios protocolos", async () => {
  const f = await fixture();
  try {
    const item = await f.service.createFeedback({ tipo: "ERROR", autor: "owner", plataforma: "whatsapp", descricao: "Erro" });
    assert.equal((await f.service.getFeedback(item.id, user("owner"))).id, item.id);
    await assert.rejects(f.service.getFeedback(item.id, user("other")), error => error.code === "FEEDBACK_FORBIDDEN");
    assert.equal((await f.service.getFeedback(item.id, admin)).id, item.id);
  } finally { await cleanup(f.root); }
});

test("somente administrador responde, resolve ou rejeita e usuário é notificado", async () => {
  const f = await fixture();
  try {
    const first = await f.service.createFeedback({ tipo: "ERROR", autor: "owner", plataforma: "whatsapp", descricao: "Erro" });
    await assert.rejects(f.service.addResponse(first.id, "Resposta", user("owner")), error => error.code === "FEEDBACK_FORBIDDEN");
    const answered = await f.service.addResponse(first.id, "Estamos analisando.", admin);
    assert.equal(answered.status, "IN_PROGRESS");
    assert.equal(answered.resposta, "Estamos analisando.");
    const resolved = await f.service.resolveFeedback(first.id, admin, "Corrigido.");
    assert.equal(resolved.status, "RESOLVED");
    assert.ok(resolved.resolvedAt);
    assert.equal(resolved.resolvedBy, "admin@lid");
    const second = await f.service.createFeedback({ tipo: "SUGGESTION", autor: "other", plataforma: "whatsapp", descricao: "Sugestão" });
    const rejected = await f.service.rejectFeedback(second.id, admin, "Fora do escopo.");
    assert.equal(rejected.status, "REJECTED");
    assert.equal(f.notifications.length, 3);
    assert.match(f.notifications[1].message, /RESOLVIDO[\s\S]*Corrigido/);
    assert.match(f.notifications[2].message, /REJEITADO[\s\S]*Fora do escopo/);
  } finally { await cleanup(f.root); }
});

test("múltiplos usuários e escritas concorrentes não perdem protocolos", async () => {
  const f = await fixture();
  try {
    const created = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      f.service.createFeedback({
        tipo: index % 2 ? "IMPROVEMENT" : "QUESTION",
        autor: `user-${index}`, plataforma: "whatsapp", descricao: `Feedback ${index}`
      })
    ));
    assert.equal(new Set(created.map(item => item.id)).size, 20);
    assert.equal((await f.repository.listFeedbacks()).length, 20);
    assert.equal(created.at(-1).id, "FB000020");
  } finally { await cleanup(f.root); }
});
