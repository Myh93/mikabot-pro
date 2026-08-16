"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { createMemberExperienceRepository } = require("../src/repositories/memberExperienceRepository");
const { createMemberJourneyService } = require("../src/services/memberJourneyService");
const { createMemberExperienceService, WEEK_MS } = require("../src/services/memberExperienceService");
const { createMemberExperienceAdministrationService } = require("../src/services/memberExperienceAdministrationService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-member-experience-"));
  const repository = createMemberExperienceRepository({ filePath: path.join(root, "state.json") });
  return { root, repository, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

test("repositório versionado mantém configurações por grupo e concessão concorrente única", async t => {
  const f = await fixture(); t.after(f.cleanup);
  assert.equal((await f.repository.load()).schemaVersion, 1);
  await f.repository.updateGroupConfig("g1", { welcome: { enabled: false, deleteAfterMs: 60000 } });
  assert.equal((await f.repository.getGroupConfig("g1")).welcome.enabled, false);
  assert.equal((await f.repository.getGroupConfig("g2")).welcome.enabled, true);
  const claims = await Promise.all(Array.from({ length: 10 }, () => f.repository.claimGrant("u1", "first_raid")));
  assert.equal(claims.filter(item => item.granted).length, 1);
});

test("recompensas e missões concedem XP e conquista exatamente uma vez", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const group = new Map(), global = new Map();
  const update = store => async (_platform, ...args) => {
    const operation = args.pop(); const updater = args.pop(); const id = args.pop();
    const current = store.get(id) || { xp: 0, achievements: [], operations: [] };
    if (current.operations.includes(operation)) return { progress: current, applied: false };
    const next = { ...current, ...updater(current), operations: [...current.operations, operation] }; store.set(id, next); return { progress: next, applied: true };
  };
  const journey = createMemberJourneyService({ experienceRepository: f.repository, playerProgressRepository: { updatePlayerProgress: update(group), updateGlobalProgress: update(global) }, log: () => undefined });
  const [first, duplicate] = await Promise.all([journey.grant("u1", "registration_completion", { groupId: "g1" }), journey.grant("u1", "registration_completion", { groupId: "g1" })]);
  assert.equal([first, duplicate].filter(item => item.granted).length, 1);
  assert.equal(global.get("u1").xp, 100);
  assert.equal(global.get("u1").achievements.filter(item => item.id === "onboarding_first_step").length, 1);
  await journey.grant("u1", "first_raid", { groupId: "g1" });
  const missions = await journey.getMissions("u1");
  assert.equal(missions.completed, 2); assert.match(journey.formatMissions(missions), /Progresso: 2\/6/);
});

test("boas-vindas, retorno e despedida preservam ordem e toleram falha de mídia", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const image = path.join(f.root, "welcome.png"); await fsp.writeFile(image, "image");
  await f.repository.updateGroupConfig("group", { welcome: { imageEnabled: true, imagePath: image }, farewell: { stickerEnabled: true, stickerPath: path.join(f.root, "missing.webp") } });
  const sent = [];
  const client = { sendMessage: async (_group, content) => { sent.push(typeof content === "string" ? content : "media"); return { fromMe: true, id: { _serialized: `m${sent.length}` }, delete: async () => undefined }; } };
  const registrations = { getRegistrationByIdentity: async () => null };
  const service = createMemberExperienceService({ repository: f.repository, memberMediaLibraryService: { selectVisual: async () => null, selectMedia: async () => null }, registrationService: registrations, memberJourneyService: { grant: async () => ({ granted: false }) }, identityService: { normalizeUserId: value => value, collectCanonicalIdentityCandidates: value => [value] }, mediaFactory: () => ({ media: true }), log: () => undefined });
  await service.handleJoin(client, { chatId: "group", recipientIds: ["u1"] });
  assert.deepEqual(sent.slice(0, 2).map(value => value === "media" ? value : /Bem-vindo/.test(value) ? "text" : value), ["media", "text"]);
  await service.handleJoin(client, { chatId: "group", recipientIds: ["u1"] });
  assert.match(sent.at(-1), /volta/);
  const before = sent.length; await service.handleLeave(client, { chatId: "group", recipientIds: ["u1"], type: "remove" });
  assert.equal(sent.length, before + 1); assert.match(sent.at(-1), /não faz mais parte/);
});

test("mensagens reais resolvem nome público e nunca exibem marcador ou ID técnico", async t => {
  const f = await fixture(); t.after(f.cleanup); const sent = [];
  const contact = { id: { _serialized: "member@lid" }, pushname: "Mychelle" };
  const client = { getContactById: async id => id === "member@lid" ? contact : null, sendMessage: async (_group, content, options = {}) => { sent.push({ content, options }); return {}; } };
  const media = { selectVisual: async () => null, selectMedia: async () => null };
  const registrations = { getRegistrationByIdentity: async identity => String(identity?.id || identity) === "nick@lid" ? { mainAccount: { nick: "Mestre GO" } } : null };
  const service = createMemberExperienceService({ repository: f.repository, memberMediaLibraryService: media, registrationService: registrations, memberJourneyService: { grant: async () => ({ granted: false }) }, log: () => undefined });
  await service.handleJoin(client, { chatId: "group@g.us", recipientIds: ["member@lid"] });
  await service.handleLeave(client, { chatId: "group@g.us", recipientIds: ["member@lid"], type: "leave" });
  await service.handleLeave(client, { chatId: "group@g.us", recipientIds: ["nick@lid"], type: "remove" });
  await service.handleLeave(client, { chatId: "group@g.us", recipientIds: ["unknown@lid"], type: "leave" });
  const output = sent.map(item => String(item.content)).join("\n");
  assert.match(output, /@Mychelle/); assert.match(output, /@Mestre GO/); assert.match(output, /Um membro/);
  assert.doesNotMatch(output, /@Treinador|member@lid|nick@lid|unknown@lid|@c\.us|@g\.us/);
  assert.equal(sent[0].options.mentions[0], contact);
});

test("anúncio de ban usa identidade pública resolvida sem mudar disciplina", async t => {
  const f = await fixture(); t.after(f.cleanup); const sent = [];
  const service = createMemberExperienceService({ repository: f.repository, memberMediaLibraryService: { selectVisual: async () => null, selectMedia: async () => null }, registrationService: { getRegistrationByIdentity: async () => ({ mainAccount: { nick: "Treinadora Azul" } }) }, memberJourneyService: { grant: async () => ({}) }, log: () => undefined });
  const result = await service.announceBan({ sendMessage: async (_group, content, options = {}) => { sent.push({ content, options }); return {}; } }, { groupId: "group@g.us", memberId: "secret@lid", reason: "Regra" });
  assert.equal(result.textSent, true); assert.match(sent[0].content, /@Treinadora Azul/); assert.doesNotMatch(sent[0].content, /@Treinador(?![\p{L}\p{N}_])|secret@lid/u);
});

test("cadastro existente sem histórico no grupo continua sendo primeira entrada", async t => {
  const f = await fixture(); t.after(f.cleanup); const sent = [];
  const service = createMemberExperienceService({
    repository: f.repository,
    registrationService: { getRegistrationByIdentity: async () => ({ createdAt: "2026-01-01T00:00:00.000Z" }) },
    memberJourneyService: { grant: async () => ({ granted: false }) },
    memberMediaLibraryService: { selectVisual: async () => null, selectMedia: async () => null },
    moderationRepository: { getActiveBan: async () => null }, disciplineService: { isBlocked: async () => ({ blocked: false }) },
    identityService: { normalizeUserId: value => value, collectCanonicalIdentityCandidates: value => [value] }, log: () => undefined
  });
  const result = await service.handleJoin({ sendMessage: async (_group, content) => { sent.push(content); return {}; } }, { chatId: "new-group@g.us", recipientIds: ["member@lid"] });
  assert.equal(result[0].state, "first_entry"); assert.equal(result[0].returning, false);
  assert.match(sent.at(-1), /Bem-vindo,/); assert.doesNotMatch(sent.at(-1), /de volta/);
});

test("histórico por grupo diferencia saída voluntária, remoção administrativa e pós-ban", async t => {
  const f = await fixture(); t.after(f.cleanup); const sent = [];
  const service = createMemberExperienceService({
    repository: f.repository,
    registrationService: { getRegistrationByIdentity: async () => ({ createdAt: "2026-01-01T00:00:00.000Z" }) },
    memberJourneyService: { grant: async () => ({ granted: false }) },
    memberMediaLibraryService: { selectVisual: async () => null, selectMedia: async () => null },
    moderationRepository: { getActiveBan: async () => null }, disciplineService: { isBlocked: async () => ({ blocked: false }) },
    identityService: { normalizeUserId: value => value, collectCanonicalIdentityCandidates: value => [value] }, log: () => undefined
  });
  const client = { sendMessage: async (_group, content) => { sent.push(content); return {}; } };
  await service.handleJoin(client, { chatId: "g@g.us", recipientIds: ["u@lid"] });
  await service.handleLeave(client, { chatId: "g@g.us", recipientIds: ["u@lid"], type: "leave" });
  assert.equal((await service.handleJoin(client, { chatId: "g@g.us", recipientIds: ["u@lid"] }))[0].state, "return_voluntary");
  assert.match(sent.at(-1), /Que bom ter você novamente/);
  await service.handleLeave(client, { chatId: "g@g.us", recipientIds: ["u@lid"], type: "remove" });
  assert.equal((await service.handleJoin(client, { chatId: "g@g.us", recipientIds: ["u@lid"] }))[0].state, "return_after_removal");
  assert.match(sent.at(-1), /readicionado à comunidade/); assert.doesNotMatch(sent.at(-1), /infrações/);
  await service.announceBan(client, { groupId: "g@g.us", memberId: "u@lid", reason: "Regra" });
  assert.equal((await service.handleJoin(client, { chatId: "g@g.us", recipientIds: ["u@lid"] }))[0].state, "return_after_ban");
  assert.match(sent.at(-1), /readicionado pela administração/); assert.match(sent.at(-1), /Evite novas infrações/);
  assert.equal((await service.handleJoin(client, { chatId: "other@g.us", recipientIds: ["u@lid"] }))[0].state, "first_entry");
});

test("banimento ativo não é apresentado como retorno comum", async t => {
  const f = await fixture(); t.after(f.cleanup); let sends = 0;
  await f.repository.updateMember("u@lid", item => { item.groups = { "g@g.us": { joinCount: 1, active: false, lastExitReason: "ban" } }; });
  const service = createMemberExperienceService({
    repository: f.repository,
    registrationService: { getRegistrationByIdentity: async () => ({}) }, memberJourneyService: { grant: async () => ({}) },
    memberMediaLibraryService: { selectVisual: async () => null, selectMedia: async () => null },
    moderationRepository: { getActiveBan: async () => ({ active: true }) }, disciplineService: { isBlocked: async () => ({ blocked: false }) },
    identityService: { normalizeUserId: value => value, collectCanonicalIdentityCandidates: value => [value] }, log: () => undefined
  });
  const result = await service.handleJoin({ sendMessage: async () => { sends += 1; } }, { chatId: "g@g.us", recipientIds: ["u@lid"] });
  assert.deepEqual(result[0], { memberId: "u@lid", state: "ban_active", returning: false, blocked: true }); assert.equal(sends, 0);
  assert.equal((await f.repository.getMember("u@lid")).groups["g@g.us"].joinCount, 1);
});

test("mensagens temporárias apagam somente mensagem do bot e retomam sem timer duplicado", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const scheduled = []; const timer = fn => { scheduled.push(fn); return { unref() {} }; };
  const service = createMemberExperienceService({ repository: f.repository, setTimeoutFn: timer, clearTimeoutFn: () => undefined, log: () => undefined });
  let deletions = 0;
  const message = { fromMe: true, id: { _serialized: "m1" }, delete: async () => { deletions += 1; } };
  assert.equal(await service.scheduleTemporary(message, "g1", 60000, {}), true);
  assert.equal(await service.scheduleTemporary(message, "g1", 60000, {}), false);
  await service.resume({}); assert.equal(scheduled.length, 1);
  await scheduled[0](); assert.equal(deletions, 1);
  assert.equal(await service.scheduleTemporary({ ...message, fromMe: false }, "g1", 60000, {}), false);
});

test("lembrete é somente privado, respeita sete dias, fluxo ativo, cadastro e PARAR", async t => {
  const f = await fixture(); t.after(f.cleanup);
  let now = new Date("2026-08-05T10:00:00.000Z"); let registered = false; let active = false; const privateMessages = [], replies = [];
  const service = createMemberExperienceService({ repository: f.repository, clock: () => now, registrationService: { getRegistrationByIdentity: async () => registered ? { id: "r1" } : null }, guidedFlowService: { hasActiveFlowForUser: async () => active }, identityService: { normalizeUserId: value => value }, log: () => undefined });
  const context = { userId: "u1", isGroup: true, identity: { id: "u1" }, sendPrivate: async (_id, text) => privateMessages.push(text), replyText: async text => replies.push(text) };
  assert.equal((await service.handleIncomingMessage(context, "oi")).status, "sent");
  assert.equal((await service.handleIncomingMessage(context, "outra")).status, "cooldown");
  now = new Date(now.getTime() + WEEK_MS + 1); active = true;
  assert.equal((await service.handleIncomingMessage(context, "oi")).status, "guided_flow");
  active = false; registered = true;
  assert.equal((await service.handleIncomingMessage(context, "oi")).status, "registered");
  assert.equal(privateMessages.length, 1);
  registered = false;
  assert.equal((await service.handleIncomingMessage({ ...context, isGroup: false }, "PARAR")).status, "disabled");
  assert.match(replies.at(-1), /não receberá/);
});

test("admin configura boas-vindas por fluxo guiado, salva, volta e cancela", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const flows = createGuidedFlowService({ filePath: path.join(f.root, "flows.json") });
  const service = createMemberExperienceAdministrationService({ repository: f.repository, guidedFlowService: flows, memberExperienceService: { validMedia: () => true } });
  const replies = []; const context = { platform: "whatsapp", conversationId: "g1", groupId: "g1", userId: "admin", isGroup: true, replyText: async text => replies.push(text) };
  await service.start(context, "welcome");
  await service.handleAnswer(context, "3"); await service.handleAnswer(context, "não"); await service.handleAnswer(context, "salvar");
  assert.equal((await f.repository.getGroupConfig("g1")).welcome.enabled, false);
  await service.start(context, "farewell"); await service.handleAnswer(context, "9");
  assert.match(replies.at(-1), /cancelada/);
});

test("remoção parcial preserva conquistas e remoção integral segue a política de dados", async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.repository.updateMember("u1", item => { item.registeredAt = "2026-08-05T00:00:00.000Z"; item.reminderDisabled = true; });
  await f.repository.claimGrant("u1", "registration_completion"); await f.repository.completeGrant("u1", "registration_completion");
  await f.repository.clearRegistrationState("u1");
  const partial = await f.repository.getMember("u1");
  assert.equal(partial.registeredAt, null); assert.equal(partial.reminderDisabled, false);
  assert.equal((await f.repository.listCompletedGrants("u1")).length, 1);
  const removed = await f.repository.removeMemberData("u1");
  assert.equal(removed.itemsRemoved, 2); assert.equal(await f.repository.getMember("u1"), null); assert.deepEqual(await f.repository.listCompletedGrants("u1"), []);
});
