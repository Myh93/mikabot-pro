"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const { createMemberMediaRepository } = require("../src/repositories/memberMediaRepository");
const validation = require("../src/services/memberMediaValidationService");
const { createExternalMediaAdapterRegistry } = require("../src/services/externalMediaAdapterRegistry");
const { createMemberMediaLibraryService } = require("../src/services/memberMediaLibraryService");
const { createMemberExperienceService } = require("../src/services/memberExperienceService");
const { createMemberExperienceRepository } = require("../src/repositories/memberExperienceRepository");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createMemberExperienceAdministrationService } = require("../src/services/memberExperienceAdministrationService");

function png(seed = 0) {
  const signature = Buffer.from([137,80,78,71,13,10,26,10]); const ihdr = Buffer.alloc(25); ihdr.writeUInt32BE(13, 0); ihdr.write("IHDR", 4); ihdr[8] = seed; const iend = Buffer.alloc(12); iend.write("IEND", 4); return Buffer.concat([signature, ihdr, iend]);
}
const gif = () => Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(7), Buffer.from([59])]);
const webp = () => { const value = Buffer.alloc(20); value.write("RIFF", 0); value.writeUInt32LE(12, 4); value.write("WEBP", 8); value.write("VP8 ", 12); return value; };
const jpg = () => Buffer.from([255,216,255,0,255,217]);
const mp4 = () => { const value = Buffer.alloc(24); value.writeUInt32BE(24, 0); value.write("ftyp", 4); value.write("isom", 8); return value; };
const webm = () => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(12)]);

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-media-")); const mediaRoot = path.join(root, "media");
  const repository = createMemberMediaRepository({ filePath: path.join(root, "library.json") });
  const registry = createExternalMediaAdapterRegistry();
  const library = createMemberMediaLibraryService({ mediaRoot, repository, adapterRegistry: registry, random: () => 0, log: () => undefined });
  return { root, mediaRoot, repository, registry, library, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

test("validação reconhece conteúdo real e rejeita extensão falsa, corrupção e excesso", () => {
  assert.equal(validation.validateBuffer(png(), "image").mimeType, "image/png");
  assert.equal(validation.validateBuffer(jpg(), "image").mimeType, "image/jpeg");
  assert.equal(validation.validateBuffer(gif(), "gif").valid, true);
  assert.equal(validation.validateBuffer(webp(), "sticker").valid, true);
  assert.equal(validation.validateBuffer(mp4(), "video").mimeType, "video/mp4");
  assert.equal(validation.validateBuffer(webm(), "video").mimeType, "video/webm");
  assert.equal(validation.validateBuffer(mp4(), "gif").valid, true);
  assert.equal(validation.validateBuffer(Buffer.from("<html><script>"), "image").valid, false);
  assert.equal(validation.validateBuffer(Buffer.from([137,80,78,71,13,10,26,10]), "image").code, "corrupt_media");
  assert.equal(validation.validateBuffer(png(), "image", { limits: { image: 10 } }).code, "file_too_large");
  assert.equal(validation.validateBuffer(gif(), "image").code, "type_mismatch");
});

test("segurança bloqueia traversal, HTTP, localhost, IP privado e DNS privado", async t => {
  const f = await fixture(); t.after(f.cleanup);
  assert.equal(validation.controlledPath(f.mediaRoot, path.join(f.mediaRoot, "..", "escape.png")), null);
  assert.equal((await validation.validateExternalUrl("http://cdn.example/a", ["cdn.example"], { lookup: async () => [{ address: "8.8.8.8" }] })).code, "scheme_not_allowed");
  assert.equal((await validation.validateExternalUrl("https://localhost/a", ["localhost"], { lookup: async () => [{ address: "127.0.0.1" }] })).valid, false);
  assert.equal((await validation.validateExternalUrl("https://cdn.example/a", ["cdn.example"], { lookup: async () => [{ address: "10.0.0.1" }] })).code, "private_address");
  assert.equal((await validation.validateExternalUrl("https://evil.example/a", ["cdn.example"], { lookup: async () => [{ address: "8.8.8.8" }] })).code, "domain_not_allowed");
});

test("biblioteca local descobre imagens, GIFs e stickers, ignora inválidos e não repete", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const imageDir = path.join(f.mediaRoot, "welcome", "images"), gifDir = path.join(f.mediaRoot, "welcome", "gifs"), stickerDir = path.join(f.mediaRoot, "welcome", "stickers");
  await Promise.all([fsp.mkdir(imageDir, { recursive: true }), fsp.mkdir(gifDir, { recursive: true }), fsp.mkdir(stickerDir, { recursive: true })]);
  await fsp.writeFile(path.join(imageDir, "one.png"), png(1)); await fsp.writeFile(path.join(imageDir, "two.png"), png(2)); await fsp.writeFile(path.join(imageDir, "fake.png"), Buffer.from("bad"));
  await fsp.writeFile(path.join(gifDir, "one.gif"), gif()); await fsp.writeFile(path.join(stickerDir, "one.webp"), webp());
  const first = await f.library.selectMedia("g1", "welcome", "image", { fetchExternal: false }); await f.library.markUsed("g1", first);
  const second = await f.library.selectMedia("g1", "welcome", "image", { fetchExternal: false });
  assert.notEqual(first.mediaId, second.mediaId); assert.equal((await f.library.discoverLocal("welcome", "gif")).length, 1); assert.equal((await f.library.discoverLocal("welcome", "sticker")).length, 1);
  await f.library.setEnabled(second.mediaId, false); assert.equal((await f.library.selectMedia("g2", "welcome", "image", { fetchExternal: false })).mediaId, first.mediaId);
  assert.equal(await f.library.selectMedia("g1", "farewell", "image", { fetchExternal: false }), null);
});

test("return e removal usam fallbacks oficiais", async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.library.importBuffer({ buffer: png(1), category: "welcome", mediaType: "image", fileName: "welcome.png" });
  await f.library.importBuffer({ buffer: webp(), category: "farewell", mediaType: "sticker", fileName: "bye.webp" });
  assert.equal((await f.library.selectMedia("g", "return", "image", { fetchExternal: false })).category, "welcome");
  assert.equal((await f.library.selectMedia("g", "removal", "sticker", { fetchExternal: false })).category, "farewell");
});

test("adaptador exige contrato completo e nenhuma fonte vem ativada", async t => {
  const f = await fixture(); t.after(f.cleanup);
  assert.throws(() => f.registry.register({ sourceId: "incompleto" }), /searchMedia/);
  assert.deepEqual(f.registry.list(), []); assert.deepEqual(await f.repository.listSources(), []);
});

test("fonte autorizada baixa para cache, valida domínio, evita duplicata e funciona offline", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const safeValidation = { ...validation, validateExternalUrl: async url => ({ valid: String(url).startsWith("https://cdn.authorized.test/"), url: new URL(url) }) };
  const registry = createExternalMediaAdapterRegistry(); let offline = false;
  registry.register({ sourceId: "authorized_test", supportedTypes: ["image"], supportedCategories: ["welcome"], licensePolicy: "admin_authorized_test", rateLimit: 10, timeoutMs: 1000, maxSize: 100000, allowedDomains: ["cdn.authorized.test"], searchMedia: async () => { if (offline) throw new Error("offline"); return [{ url: "https://cdn.authorized.test/a.png" }]; }, downloadMedia: async () => ({ buffer: png(4), finalUrl: "https://cdn.authorized.test/a.png" }), validateResult: result => Boolean(result.url), normalizeMetadata: result => ({ url: result.url, licenseMetadata: { policy: "test" } }) });
  const library = createMemberMediaLibraryService({ mediaRoot: f.mediaRoot, repository: f.repository, adapterRegistry: registry, validationService: safeValidation, log: () => undefined });
  await f.repository.updateCacheSettings({ localOnly: false }); await library.configureSource("authorized_test", { enabled: true, categories: ["welcome"], types: ["image"], maxDownloadsPerDay: 2 });
  assert.equal((await library.refreshCache({ category: "welcome", mediaType: "image" })).downloaded, 1);
  assert.equal((await library.refreshCache({ category: "welcome", mediaType: "image" })).downloaded, 0);
  offline = true; const selected = await library.selectMedia("g", "welcome", "image"); assert.equal(selected.origin, "external"); assert.ok(selected.sourceUrlHash); assert.equal(JSON.stringify(await f.repository.load()).includes("https://"), false);
});

test("fonte externa trata timeout, erro HTTP e redirecionamento não autorizado sem quebrar", async t => {
  const f = await fixture(); t.after(f.cleanup); const registry = createExternalMediaAdapterRegistry(); let mode = "timeout";
  const safeValidation = { ...validation, validateExternalUrl: async url => ({ valid: String(url).startsWith("https://cdn.authorized.test/"), code: "domain_not_allowed", url: new URL(url) }) };
  registry.register({ sourceId: "unstable", supportedTypes: ["image"], supportedCategories: ["welcome"], licensePolicy: "test", rateLimit: 2, timeoutMs: 20, maxSize: 100000, allowedDomains: ["cdn.authorized.test"], searchMedia: async () => [{ url: "https://cdn.authorized.test/a" }], downloadMedia: async () => { if (mode === "timeout") return new Promise(() => undefined); if (mode === "http") throw Object.assign(new Error("http"), { code: "HTTP_500" }); return { buffer: png(), finalUrl: "https://redirect.evil.test/a" }; }, validateResult: () => true, normalizeMetadata: result => result });
  const library = createMemberMediaLibraryService({ mediaRoot: f.mediaRoot, repository: f.repository, adapterRegistry: registry, validationService: safeValidation, log: () => undefined });
  await f.repository.updateCacheSettings({ localOnly: false, maxAttempts: 1 }); await library.configureSource("unstable", { enabled: true, maxDownloadsPerDay: 5 });
  assert.equal((await library.refreshCache({ category: "welcome", mediaType: "image" })).downloaded, 0);
  mode = "http"; assert.equal((await library.refreshCache({ category: "welcome", mediaType: "image" })).downloaded, 0);
  mode = "redirect"; assert.equal((await library.refreshCache({ category: "welcome", mediaType: "image" })).downloaded, 0);
  assert.equal((await f.repository.listMedia()).length, 0);
});

test("cache remove primeiro externos inativos menos usados e preserva local e ativo", async t => {
  const f = await fixture(); t.after(f.cleanup); await f.repository.updateCacheSettings({ maxItems: 1, maxBytes: 100000 });
  const local = await f.library.importBuffer({ buffer: png(1), category: "welcome", mediaType: "image" });
  const externalA = await f.library.importBuffer({ buffer: png(2), category: "welcome", mediaType: "image", origin: "external", sourceId: "s", sourceUrlHash: "h1" });
  await f.library.setEnabled(externalA.item.mediaId, false);
  const externalB = await f.library.importBuffer({ buffer: png(3), category: "welcome", mediaType: "image", origin: "external", sourceId: "s", sourceUrlHash: "h2" });
  assert.equal(externalB.created, true); assert.ok(await f.repository.getMedia(local.item.mediaId)); assert.equal(await f.repository.getMedia(externalA.item.mediaId), null); assert.ok(await f.repository.getMedia(externalB.item.mediaId));
});

test("upload do WhatsApp persiste arquivo local, lista sanitizada, alterna e remove", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const message = { hasMedia: true, type: "document", downloadMedia: async () => ({ data: png(8).toString("base64"), mimetype: "image/png", filename: "trainer.bin" }) };
  const uploaded = await f.library.importWhatsAppMedia(message, "return"); assert.equal(uploaded.created, true); assert.equal(uploaded.item.mediaType, "image");
  assert.equal((await f.library.listMedia("return")).length, 1); await f.library.setEnabled(uploaded.item.mediaId, false); assert.equal((await f.repository.getMedia(uploaded.item.mediaId)).enabled, false);
  await f.library.removeMedia(uploaded.item.mediaId); assert.equal(await f.repository.getMedia(uploaded.item.mediaId), null); await assert.rejects(fsp.stat(uploaded.item.internalPath));
});

test("envio automático usa visual, sticker e texto; falha de mídia mantém texto", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-media-integration-")); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = createMemberExperienceRepository({ filePath: path.join(root, "experience.json") }); const calls = [];
  const library = { selectVisual: async () => ({ mediaId: "ME1", internalPath: "visual.png", mediaType: "image" }), selectMedia: async () => ({ mediaId: "ME2", internalPath: "sticker.webp", mediaType: "sticker" }), markUsed: async (_group, item) => calls.push(`used:${item.mediaId}`) };
  const client = { sendMessage: async (_group, content) => { calls.push(typeof content === "string" ? "text" : content.path); if (content.path === "visual.png") throw new Error("media fail"); return { fromMe: true, id: { _serialized: cryptoRandom() }, delete: async () => undefined }; } };
  const service = createMemberExperienceService({ repository, memberMediaLibraryService: library, registrationService: { getRegistrationByIdentity: async () => null }, memberJourneyService: { grant: async () => ({ granted: false }) }, identityService: { normalizeUserId: value => value, collectCanonicalIdentityCandidates: value => [value] }, mediaFactory: file => ({ path: file }), log: () => undefined });
  await service.handleJoin(client, { chatId: "g", recipientIds: ["u"] }); assert.deepEqual(calls, ["visual.png", "sticker.webp", "used:ME2", "text"]);
});

test("admin abre biblioteca, recebe upload e não aceita caminho digitado", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-media-admin-")); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = createMemberExperienceRepository({ filePath: path.join(root, "experience.json") }); const flows = createGuidedFlowService({ filePath: path.join(root, "flows.json") }); const imported = [];
  const library = { importWhatsAppMedia: async (input, category, mediaType) => { const message = input?.originalMessage || input?.message || input; imported.push({ message, category, mediaType }); return message?.hasMedia ? { created: true, item: { mediaId: "ME000001" } } : { created: false, errorCode: "no_media" }; }, listMedia: async () => [], repository: { getCacheSettings: async () => ({ localOnly: true }), updateCacheSettings: async () => ({}), getMedia: async () => null }, refreshCache: async () => ({ downloaded: 0 }), listAdapters: () => [] };
  const service = createMemberExperienceAdministrationService({ repository, guidedFlowService: flows, memberExperienceService: { testMedia: async () => ({ visualSent: false, stickerSent: false }) }, memberMediaLibraryService: library }); const replies = [];
  const context = { platform: "whatsapp", conversationId: "g", groupId: "g", userId: "admin", isGroup: true, replyText: async value => replies.push(value), message: null, client: {} };
  await service.start(context, "welcome"); await service.handleAnswer(context, "1"); await service.handleAnswer(context, "1");
  assert.equal((await service.handleAnswer(context, "C:\\unsafe\\file.png")).status, "invalid_media");
  context.message = { hasMedia: true }; assert.equal((await service.handleAnswer(context, "arquivo")).status, "uploaded"); assert.equal(imported.at(-1).category, "welcome");
  assert.equal(replies.some(value => /caminho absoluto/i.test(value)), false);
});

test("upload detecta sticker, GIF, GIF em MP4, vídeo e documentos pelo conteúdo real", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const cases = [
    [{ type: "sticker" }, webp(), "image/webp", "sticker", false],
    [{ type: "document" }, gif(), "image/gif", "gif", true],
    [{ type: "video", isGif: true }, mp4(), "video/mp4", "gif", true],
    [{ type: "video" }, mp4(), "video/mp4", "video", false],
    [{ type: "document" }, webm(), "video/webm", "video", false]
  ];
  for (const [shape, buffer, mimetype, mediaType, animated] of cases) {
    const result = await f.library.importWhatsAppMedia({ ...shape, hasMedia: true, downloadMedia: async () => ({ data: buffer.toString("base64"), mimetype }) }, "welcome");
    assert.equal(result.created, true); assert.equal(result.item.mediaType, mediaType); assert.equal(result.item.animated, animated);
  }
});

test("upload retorna erros controlados e não confia no MIME declarado", async t => {
  const f = await fixture(); t.after(f.cleanup);
  assert.equal((await f.library.importWhatsAppMedia({}, "welcome")).errorCode, "no_media");
  assert.equal((await f.library.importWhatsAppMedia({ hasMedia: true }, "welcome")).errorCode, "download_unavailable");
  assert.equal((await f.library.importWhatsAppMedia({ hasMedia: true, downloadMedia: async () => { throw new Error("private"); } }, "welcome")).errorCode, "download_failed");
  assert.equal((await f.library.importWhatsAppMedia({ hasMedia: true, downloadMedia: async () => null }, "welcome")).errorCode, "download_returned_empty");
  assert.equal((await f.library.importWhatsAppMedia({ hasMedia: true, downloadMedia: async () => ({ data: "%%%", mimetype: "image/png" }) }, "welcome")).errorCode, "invalid_base64");
  assert.equal((await f.library.importWhatsAppMedia({ hasMedia: true, downloadMedia: async () => ({ data: png().toString("base64"), mimetype: "application/octet-stream" }) }, "welcome")).errorCode, "unsupported_mime");
  assert.equal((await f.library.importWhatsAppMedia({ hasMedia: true, downloadMedia: async () => ({ data: png().toString("base64"), mimetype: "video/mp4" }) }, "welcome")).errorCode, "invalid_file_signature");
});

test("download real normaliza id, preserva binding e processa a Message original uma vez", async t => {
  const f = await fixture(); t.after(f.cleanup); let downloads = 0;
  const message = {
    hasMedia: true, type: "image", id: { toString() { return "false_group@g.us_A1B2C3_member@lid"; } },
    async downloadMedia() { downloads += 1; assert.equal(this, message); assert.equal(this.id._serialized, "false_group@g.us_A1B2C3_member@lid"); return { data: png(9).toString("base64"), mimetype: "image/png" }; }
  };
  const first = await f.library.importWhatsAppMedia({ originalMessage: message }, "welcome");
  const duplicate = await f.library.importWhatsAppMedia({ message }, "welcome");
  assert.equal(first.created, true); assert.equal(duplicate.errorCode, "duplicate_message"); assert.equal(duplicate.ignored, true); assert.equal(downloads, 1);
});

test("correlação por objeto bloqueia duplicidade quando não existe id oficial", async t => {
  const f = await fixture(); t.after(f.cleanup); let downloads = 0;
  const message = { hasMedia: true, type: "image", downloadMedia: async () => { downloads += 1; throw new Error("real failure"); } };
  assert.equal((await f.library.importWhatsAppMedia(message, "farewell")).errorCode, "download_failed");
  assert.equal((await f.library.importWhatsAppMedia(message, "farewell")).errorCode, "duplicate_message");
  assert.equal(downloads, 1);
});

test("falha ao persistir retorna save_failed sem expor exceção", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const library = createMemberMediaLibraryService({ mediaRoot: path.join(f.root, "save-fail"), repository: { ...f.repository, addMedia: async () => { throw new Error("sensitive path"); } }, adapterRegistry: f.registry, log: () => undefined });
  const result = await library.importWhatsAppMedia({ hasMedia: true, type: "image", downloadMedia: async () => ({ data: png().toString("base64"), mimetype: "image/png" }) }, "ban");
  assert.equal(result.errorCode, "save_failed");
});

test("duas instâncias Message com o mesmo ID oficial são correlacionadas antes do download", async t => {
  const f = await fixture(); t.after(f.cleanup); let downloads = 0;
  class RealMessage {
    constructor() { this.id = { _serialized: "false_group@g.us_D4E5F6_member@c.us" }; this.hasMedia = true; this.type = "image"; }
    async downloadMedia() { downloads += 1; return { data: png().toString("base64"), mimetype: "image/png" }; }
  }
  const first = new RealMessage(), second = new RealMessage();
  assert.equal((await f.library.importWhatsAppMedia({ message: first, originalMessage: first }, "return")).created, true);
  assert.equal((await f.library.importWhatsAppMedia({ message: second, originalMessage: second }, "return")).errorCode, "duplicate_message");
  assert.equal(downloads, 1); assert.equal(Object.getPrototypeOf(first), RealMessage.prototype);
});

test("download complementa _serialized por _data sem substituir a instÃ¢ncia id", async t => {
  const f = await fixture(); t.after(f.cleanup); let downloads = 0;
  class MessageId {}
  const id = new MessageId();
  const message = {
    id,
    _data: { id: { toString: () => "true_member@lid_F7A8B9" } },
    hasMedia: true,
    type: "sticker",
    async downloadMedia() {
      downloads += 1;
      assert.equal(this.id, id);
      assert.equal(Object.getPrototypeOf(this.id), MessageId.prototype);
      assert.equal(this.id._serialized, "true_member@lid_F7A8B9");
      return { data: webp().toString("base64"), mimetype: "image/webp" };
    }
  };
  assert.equal((await f.library.importWhatsAppMedia(message, "welcome")).created, true);
  assert.equal(downloads, 1);
});

test("download usa factory oficial para MessageKey plain e chama downloadMedia uma vez", async t => {
  const f = await fixture(); t.after(f.cleanup); let downloads = 0; let factoryCalls = 0;
  class PlainMessageKey {
    constructor() {
      this.fromMe = false;
      this.id = "stanza";
      this.remote = { user: "group", server: "g.us" };
      this.participant = { user: "member", server: "lid" };
    }
  }
  const id = new PlainMessageKey();
  const message = {
    id,
    hasMedia: true,
    type: "image",
    client: {
      pupPage: {
        async evaluate(_callback, input) {
          factoryCalls += 1;
          assert.equal(input.fromMe, false);
          assert.equal(input.id, "stanza");
          return { factoryAvailable: true, factoryName: "MsgKey", factoryAccepted: true, serialized: "false_group@g.us_C1D2E3_member@lid" };
        }
      }
    },
    async downloadMedia() {
      downloads += 1;
      assert.equal(this, message);
      assert.equal(this.id, id);
      assert.equal(Object.getPrototypeOf(this.id), PlainMessageKey.prototype);
      assert.equal(this.id._serialized, "false_group@g.us_C1D2E3_member@lid");
      return { data: png(7).toString("base64"), mimetype: "image/png" };
    }
  };
  const result = await f.library.importWhatsAppMedia(message, "welcome");
  assert.equal(result.created, true);
  assert.equal(factoryCalls, 1);
  assert.equal(downloads, 1);
});

test("payload normalizado sem método oficial é rejeitado antes de tentar download", async t => {
  const f = await fixture(); t.after(f.cleanup);
  const clone = { hasMedia: true, type: "image", id: { _serialized: "clone-id" } };
  assert.equal((await f.library.importWhatsAppMedia({ message: clone, originalMessage: clone }, "removal")).errorCode, "download_unavailable");
});

function cryptoRandom() { return Math.random().toString(36).slice(2); }

test("pré-visualização privada preserva formatos sem registrar uso", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-private-preview-")); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = createMemberExperienceRepository({ filePath: path.join(root, "experience.json") });
  const formats = [
    { mediaType: "image", mimeType: "image/png", internalPath: "image.png", expected: {} },
    { mediaType: "sticker", mimeType: "image/webp", internalPath: "sticker.webp", expected: { sendMediaAsSticker: true } },
    { mediaType: "gif", mimeType: "video/mp4", internalPath: "animated.mp4", expected: { sendVideoAsGif: true } },
    { mediaType: "video", mimeType: "video/mp4", internalPath: "video.mp4", expected: {} }
  ];
  for (const item of formats) {
    let marked = 0; const sent = [];
    const service = createMemberExperienceService({ repository, memberMediaLibraryService: { selectPreview: async () => item, markUsed: async () => { marked += 1; } }, registrationService: { getRegistrationByIdentity: async () => null }, memberJourneyService: { grant: async () => ({}) }, identityService: { normalizeUserId: value => value, collectCanonicalIdentityCandidates: value => [value] }, mediaFactory: file => ({ path: file }), log: () => undefined });
    const result = await service.previewMedia({ sendMessage: async (target, content, options = {}) => { sent.push({ target, content, options }); return {}; } }, "admin@lid", "welcome");
    assert.equal(result.sent, true); assert.equal(marked, 0); assert.equal(sent.length, 2); assert.equal(sent.every(call => call.target === "admin@lid"), true); assert.deepEqual(sent[1].options, item.expected); assert.match(sent[0].content, /Nenhuma ação real foi executada/);
  }
});

test("prévia vazia avisa somente no privado e seleção não altera lastUsed", async t => {
  const f = await fixture(); t.after(f.cleanup); const sent = [];
  const service = createMemberExperienceService({ repository: createMemberExperienceRepository({ filePath: path.join(f.root, "preview-experience.json") }), memberMediaLibraryService: f.library, registrationService: { getRegistrationByIdentity: async () => null }, memberJourneyService: { grant: async () => ({}) }, identityService: { normalizeUserId: value => value, collectCanonicalIdentityCandidates: value => [value] }, mediaFactory: file => ({ path: file }), log: () => undefined });
  const empty = await service.previewMedia({ sendMessage: async (target, content) => sent.push({ target, content }) }, "admin@lid", "return");
  assert.equal(empty.empty, true); assert.equal(sent[0].target, "admin@lid"); assert.match(sent[0].content, /Nenhuma mídia ativa/);
  await f.library.importBuffer({ buffer: png(), category: "welcome", mediaType: "image" }); const selected = await f.library.selectPreview("welcome"); assert.ok(selected); assert.equal((await f.repository.getMedia(selected.mediaId)).lastUsedAt, null);
});

test("menu de mídia pré-visualiza no PV e mantém toggle contínuo", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-preview-flow-")); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = createMemberExperienceRepository({ filePath: path.join(root, "experience.json") }), flows = createGuidedFlowService({ filePath: path.join(root, "flows.json") });
  const item = { mediaId: "ME000001", category: "welcome", enabled: true, mediaType: "image", size: 10 }; const previews = [], replies = [];
  const library = { listMedia: async () => [item], setEnabled: async (_id, enabled) => ({ ...item, enabled }), repository: { getMedia: async () => item }, listAdapters: () => [] };
  const experience = { previewMedia: async (_client, userId, category) => { previews.push({ userId, category }); return { sent: true }; }, testMedia: async () => ({ visualSent: true }) };
  const service = createMemberExperienceAdministrationService({ repository, guidedFlowService: flows, memberMediaLibraryService: library, memberExperienceService: experience });
  const context = { platform: "whatsapp", conversationId: "group@g.us", groupId: "group@g.us", userId: "admin@lid", isGroup: true, client: {}, replyText: async text => replies.push(text) };
  await service.start(context, "welcome"); await service.handleAnswer(context, "1"); assert.equal((await service.handleAnswer(context, "6")).status, "previewed"); assert.deepEqual(previews, [{ userId: "admin@lid", category: "welcome" }]);
  assert.equal((await service.handleAnswer(context, "3")).status, "awaiting_id"); assert.equal((await service.handleAnswer(context, "ME000001")).status, "updated"); assert.equal((await service.handleAnswer(context, "2")).status, "listed"); assert.equal((await service.handleAnswer(context, "ME000001")).status, "invalid"); assert.match(service.mediaMenu("welcome"), /Pré-visualizar no privado/);
});
