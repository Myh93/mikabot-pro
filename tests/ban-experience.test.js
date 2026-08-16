"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createMemberExperienceRepository } = require("../src/repositories/memberExperienceRepository");
const { createMemberMediaRepository } = require("../src/repositories/memberMediaRepository");
const { createMemberMediaLibraryService } = require("../src/services/memberMediaLibraryService");
const { createMemberExperienceService } = require("../src/services/memberExperienceService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createBanExperienceAdministrationService } = require("../src/services/banExperienceAdministrationService");

const png = () => { const signature = Buffer.from([137,80,78,71,13,10,26,10]); const ihdr = Buffer.alloc(25); ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4); const iend = Buffer.alloc(12); iend.write("IEND", 4); return Buffer.concat([signature, ihdr, iend]); };

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-ban-media-"));
  const repository = createMemberExperienceRepository({ filePath: path.join(root, "experience.json") });
  const mediaRepository = createMemberMediaRepository({ filePath: path.join(root, "media.json") });
  const library = createMemberMediaLibraryService({ repository: mediaRepository, mediaRoot: path.join(root, "files"), random: () => 0, log: () => undefined });
  const sent = [];
  const client = { sendMessage: async (_group, content, options = {}) => { sent.push({ content, options }); return { fromMe: true, id: { _serialized: `m${sent.length}` }, delete: async () => undefined }; } };
  const service = createMemberExperienceService({ repository, memberMediaLibraryService: library, registrationService: { getRegistrationByIdentity: async () => null }, memberJourneyService: { grant: async () => ({}) }, identityService: { normalizeUserId: value => String(value || ""), collectCanonicalIdentityCandidates: value => [value] }, mediaFactory: file => ({ path: file }), log: () => undefined });
  return { root, repository, mediaRepository, library, service, client, sent, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

test("categoria ban aceita upload homologado, persiste e evita repetição", async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (let index = 0; index < 2; index += 1) await f.library.importWhatsAppMedia({ hasMedia: true, type: "document", downloadMedia: async () => ({ data: png().toString("base64"), mimetype: "image/png", filename: `${index}.png` }) }, "ban");
  const items = await f.library.listMedia("ban"); assert.equal(items.length, 1);
  assert.equal(items[0].internalPath.includes(path.join("ban", "images")), true);
});

test("banimento confirmado envia mídia e texto; group_leave posterior não duplica removal", async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.library.importBuffer({ buffer: png(), category: "ban", mediaType: "image" });
  await f.service.announceBan(f.client, { groupId: "g@g.us", memberId: "u@lid", reason: "Spam", duration: "7 dias" });
  assert.equal(f.sent.length, 2); assert.match(String(f.sent[1].content), /Motivo: Spam/); assert.match(String(f.sent[1].content), /Duração: 7 dias/);
  await f.service.handleLeave(f.client, { chatId: "g@g.us", type: "remove", recipientIds: ["u@lid"] });
  assert.equal(f.sent.length, 2);
});

test("motivo e duração podem ser ocultados e permanente é formatado", async t => {
  const f = await fixture(); t.after(f.cleanup);
  let config = (await f.repository.getGroupConfig("g@g.us")).ban;
  assert.match(f.service.renderBanText(config, { reason: "Spam", duration: "permanent" }), /Permanente/);
  await f.repository.updateGroupConfig("g@g.us", { ban: { showReason: false, showDuration: false } });
  config = (await f.repository.getGroupConfig("g@g.us")).ban;
  const text = f.service.renderBanText(config, { reason: "Privado", duration: "7 dias" });
  assert.doesNotMatch(text, /Privado|7 dias|Motivo:|Duração:/);
});

test("teste administrativo não altera disciplina e fluxo aceita upload direto", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const flows = createGuidedFlowService({ filePath: path.join(f.root, "flows.json") });
  const admin = createBanExperienceAdministrationService({ repository: f.repository, guidedFlowService: flows, memberMediaLibraryService: f.library, memberExperienceService: f.service });
  const replies = [], context = { platform: "whatsapp", conversationId: "g@g.us", groupId: "g@g.us", userId: "admin@lid", isGroup: true, client: f.client, replyText: async value => replies.push(value), message: null };
  await admin.start(context); await admin.handleAnswer(context, "1"); await admin.handleAnswer(context, "1");
  context.message = { hasMedia: true, type: "document", downloadMedia: async () => ({ data: png().toString("base64"), mimetype: "image/png" }) };
  assert.equal((await admin.handleAnswer(context, "arquivo")).status, "library");
  await admin.handleAnswer(context, "0"); assert.equal((await admin.handleAnswer(context, "8")).status, "tested");
  assert.equal(replies.some(value => /Teste de banimento enviado/.test(value)), true);
});

test("biblioteca vazia e falha de mídia não bloqueiam a mensagem", async t => {
  const f = await fixture(); t.after(f.cleanup);
  assert.equal((await f.service.announceBan(f.client, { groupId: "g@g.us", memberId: "u@lid" })).textSent, true);
  assert.equal(f.sent.length, 1);
});

test("biblioteca de ban pré-visualiza no privado e mantém toggle contínuo", async t => {
  const f = await fixture(); t.after(f.cleanup); const flows = createGuidedFlowService({ filePath: path.join(f.root, "preview-flows.json") });
  const item = { mediaId: "ME000001", category: "ban", enabled: true, mediaType: "image", size: 10 }, previews = [], replies = [];
  const library = { listMedia: async () => [item], setEnabled: async (_id, enabled) => ({ ...item, enabled }), repository: { getMedia: async () => item } };
  const experience = { previewMedia: async (_client, userId, category) => { previews.push({ userId, category }); return { sent: true }; }, testBan: async () => ({}) };
  const admin = createBanExperienceAdministrationService({ repository: f.repository, guidedFlowService: flows, memberMediaLibraryService: library, memberExperienceService: experience });
  const context = { platform: "whatsapp", conversationId: "group@g.us", groupId: "group@g.us", userId: "admin@lid", isGroup: true, client: f.client, replyText: async value => replies.push(value) };
  await admin.start(context); await admin.handleAnswer(context, "1"); assert.equal((await admin.handleAnswer(context, "6")).status, "previewed"); assert.deepEqual(previews, [{ userId: "admin@lid", category: "ban" }]);
  assert.equal((await admin.handleAnswer(context, "3")).status, "awaiting_id"); assert.equal((await admin.handleAnswer(context, "ME000001")).status, "updated"); assert.equal((await admin.handleAnswer(context, "2")).status, "listed"); assert.equal((await admin.handleAnswer(context, "ME000001")).status, "invalid"); assert.match(admin.libraryMenu(), /Pré-visualizar no privado/);
});
