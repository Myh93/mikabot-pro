"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createFeedbackRepository } = require("../src/repositories/feedbackRepository");
const { createFeedbackService } = require("../src/services/feedbackService");
const { createFeedbackAdministrationService } = require("../src/services/feedbackAdministrationService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-feedback-admin-"));
  const filePath = path.join(root, "feedback.json");
  const flowPath = path.join(root, "flows.json");
  const repository = createFeedbackRepository({ filePath });
  const flows = createGuidedFlowService({ filePath: flowPath });
  const notifications = [];
  const feedback = createFeedbackService({
    repository,
    guidedFlowService: flows,
    notifier: async (author, message) => notifications.push({ author, message })
  });
  const administration = createFeedbackAdministrationService({ feedbackService: feedback, guidedFlowService: flows });
  return { root, filePath, flowPath, repository, flows, feedback, administration, notifications };
}

const cleanup = root => fsp.rm(root, { recursive: true, force: true });
const role = { name: "admin", rank: 2, isAdmin: true };
function context(userId = "admin@lid", overrides = {}) {
  const replies = [];
  return {
    platform: "whatsapp", groupId: "private@c.us", conversationId: "private@c.us",
    userId, role, replyText: async value => replies.push(String(value)), replies, ...overrides
  };
}
const create = (feedback, overrides = {}) => feedback.createFeedback({
  tipo: "ERROR", autor: "member@lid", plataforma: "whatsapp", grupo: "group@g.us",
  descricao: "Descrição detalhada", ...overrides
});

test("lista protocolos abertos por padrão e aplica filtros administrativos", async () => {
  const f = await fixture();
  try {
    const open = await create(f.feedback);
    const resolved = await create(f.feedback, { tipo: "SUGGESTION", autor: "two@lid" });
    const rejected = await create(f.feedback, { tipo: "QUESTION", autor: "three@lid" });
    await f.feedback.resolveFeedback(resolved.id, { userId: "admin", role }, "Concluído");
    await f.feedback.rejectFeedback(rejected.id, { userId: "admin", role }, "Motivo");
    assert.deepEqual((await f.administration.listFeedbacks(context())).map(item => item.id), [open.id]);
    assert.deepEqual((await f.administration.listFeedbacks(context(), ["resolvidas"])).map(item => item.id), [resolved.id]);
    assert.deepEqual((await f.administration.listFeedbacks(context(), ["rejeitadas"])).map(item => item.id), [rejected.id]);
    assert.deepEqual((await f.administration.listFeedbacks(context(), ["sugestão"])).map(item => item.id), [resolved.id]);
    assert.deepEqual((await f.administration.listFeedbacks(context(), ["erro"])).map(item => item.id), [open.id]);
  } finally { await cleanup(f.root); }
});

test("visualiza protocolo completo e trata banco vazio e protocolo inexistente", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.administration.viewFeedback(context(), "FB999999"), null);
    assert.match(f.administration.formatFeedback(null), /não encontrado/i);
    assert.match(f.administration.formatList([]), /Nenhum feedback/i);
    const item = await create(f.feedback);
    const shown = f.administration.formatFeedback(await f.administration.viewFeedback(context(), item.id));
    assert.match(shown, /FB000001/);
    assert.match(shown, /Descrição detalhada/);
  } finally { await cleanup(f.root); }
});

test("resposta guiada permite editar, salva IN_PROGRESS e notifica o autor", async () => {
  const f = await fixture();
  const ctx = context();
  try {
    const item = await create(f.feedback);
    assert.equal((await f.administration.startAction(ctx, "respond", item.id)).status, "started");
    await f.administration.handleAnswer(ctx, "Resposta inicial");
    assert.equal((await f.administration.handleAnswer(ctx, "2")).status, "edit");
    await f.administration.handleAnswer(ctx, "Resposta final");
    const result = await f.administration.handleAnswer(ctx, "1");
    assert.equal(result.feedback.status, "IN_PROGRESS");
    assert.equal(result.feedback.resposta, "Resposta final");
    assert.equal(f.notifications.length, 1);
    assert.match(f.notifications[0].message, /EM ANDAMENTO/);
    assert.equal(await f.administration.hasActiveFlow(ctx), false);
  } finally { await cleanup(f.root); }
});

test("resolução aceita observação opcional e rejeição exige motivo", async () => {
  const f = await fixture();
  try {
    const resolved = await create(f.feedback);
    const resolveContext = context("owner@lid", { role: { name: "owner", rank: 3, isOwner: true } });
    await f.administration.startAction(resolveContext, "resolve", resolved.id);
    await f.administration.handleAnswer(resolveContext, "pular");
    const result = await f.administration.handleAnswer(resolveContext, "1");
    assert.equal(result.feedback.status, "RESOLVED");
    assert.ok(result.feedback.resolvedAt);
    assert.equal(result.feedback.resolvedBy, "owner@lid");

    const rejected = await create(f.feedback, { autor: "second@lid" });
    const rejectContext = context();
    await f.administration.startAction(rejectContext, "reject", rejected.id);
    assert.equal((await f.administration.handleAnswer(rejectContext, "pular")).status, "validation_error");
    await f.administration.handleAnswer(rejectContext, "Fora do escopo");
    const rejectedResult = await f.administration.handleAnswer(rejectContext, "1");
    assert.equal(rejectedResult.feedback.status, "REJECTED");
    assert.equal(rejectedResult.feedback.resposta, "Fora do escopo");
    assert.ok(rejectedResult.feedback.resolvedAt);
  } finally { await cleanup(f.root); }
});

test("cancelamento encerra fluxo sem modificar o protocolo", async () => {
  const f = await fixture();
  const ctx = context();
  try {
    const item = await create(f.feedback);
    await f.administration.startAction(ctx, "respond", item.id);
    assert.equal((await f.administration.handleAnswer(ctx, "cancelar")).status, "cancelled");
    assert.equal((await f.repository.getFeedback(item.id)).status, "NEW");
  } finally { await cleanup(f.root); }
});

test("estatísticas contabilizam status, tipos e tempo médio", async () => {
  const f = await fixture();
  try {
    const one = await create(f.feedback, { createdAt: "2026-08-01T10:00:00.000Z" });
    await create(f.feedback, { tipo: "IMPROVEMENT", autor: "two" });
    await f.repository.updateFeedback(one.id, {
      status: "RESOLVED", resolvedAt: "2026-08-01T12:00:00.000Z", resolvedBy: "admin"
    });
    const value = await f.administration.stats(context());
    assert.equal(value.total, 2);
    assert.equal(value.open, 1);
    assert.equal(value.resolved, 1);
    assert.equal(value.errors, 1);
    assert.equal(value.improvements, 1);
    assert.equal(value.averageResolutionMs, 2 * 60 * 60 * 1000);
    assert.match(f.administration.formatStats(value), /2\.0 hora/);
  } finally { await cleanup(f.root); }
});

test("somente owner, dona protegida ou admin podem administrar", async () => {
  const f = await fixture();
  try {
    await create(f.feedback);
    for (const deniedRole of [{ name: "member", rank: 0 }, { name: "moderator", rank: 1, isModerator: true }]) {
      await assert.rejects(f.administration.listFeedbacks(context("denied", { role: deniedRole })), error => error.code === "FEEDBACK_ADMIN_FORBIDDEN");
    }
    assert.equal((await f.administration.listFeedbacks(context("protected", { role: { isProtectedOwner: true } }))).length, 1);
    assert.equal((await f.administration.listFeedbacks(context("admin-two", { role: { isAdmin: true } }))).length, 1);
  } finally { await cleanup(f.root); }
});

test("persistência administrativa sobrevive à reinicialização dos serviços", async () => {
  const f = await fixture();
  try {
    const item = await create(f.feedback);
    await f.feedback.addResponse(item.id, "Persistida", { userId: "admin", role });
    const restartedRepository = createFeedbackRepository({ filePath: f.filePath });
    const restartedFeedback = createFeedbackService({ repository: restartedRepository, guidedFlowService: createGuidedFlowService({ filePath: f.flowPath }) });
    const restartedAdministration = createFeedbackAdministrationService({ feedbackService: restartedFeedback, guidedFlowService: createGuidedFlowService({ filePath: f.flowPath }) });
    const persisted = await restartedAdministration.viewFeedback(context(), item.id);
    assert.equal(persisted.status, "IN_PROGRESS");
    assert.equal(persisted.resposta, "Persistida");
  } finally { await cleanup(f.root); }
});

test("comandos administrativos são registrados sem remover o comando de criação", () => {
  const feedbackCommand = require("../src/commands/feedback");
  const feedbacksCommand = require("../src/commands/feedback-admin");
  assert.equal(feedbackCommand.name, "feedback");
  assert.equal(feedbacksCommand.name, "feedbacks");
  assert.equal(feedbacksCommand.adminOnly, true);
});

test("subcomando administrativo misto resolve a função pelo PermissionService", async () => {
  const feedbackCommand = require("../src/commands/feedback");
  const administration = require("../src/services/feedbackAdministrationService");
  const permissions = require("../src/services/permissionService");
  const originalStats = administration.stats;
  const originalFormat = administration.formatStats;
  const originalResolveRole = permissions.resolveRole;
  const replies = [];
  let roleResolved = false;
  try {
    permissions.resolveRole = async () => {
      roleResolved = true;
      return { name: "admin", rank: 2, isAdmin: true };
    };
    administration.stats = async ctx => {
      assert.equal(ctx.role.isAdmin, true);
      return { total: 0 };
    };
    administration.formatStats = () => "estatísticas";
    const platformContext = {
      platform: "whatsapp", groupId: "private@c.us", userId: "admin@lid",
      replyText: async text => replies.push(text)
    };
    const msg = { getContact: async () => ({}), getChat: async () => ({ isGroup: false }) };
    await feedbackCommand.execute({}, msg, ["stats"], { platformContext });
    assert.equal(roleResolved, true);
    assert.deepEqual(replies, ["estatísticas"]);
  } finally {
    administration.stats = originalStats;
    administration.formatStats = originalFormat;
    permissions.resolveRole = originalResolveRole;
  }
});
