"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const crypto = require("crypto");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const { createModerationRepository } = require("../src/repositories/moderationRepository");
const { createModerationService } = require("../src/services/moderationService");

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-moderation-"));
  const dataDir = path.join(root, "data"), backupRoot = path.join(root, "backups");
  const repository = createModerationRepository({ dataDir, backupRoot });
  const service = createModerationService({ repository });
  return { root, dataDir, backupRoot, repository, service };
}
const digest = value => crypto.createHash("sha256").update(value).digest("hex");

test("cria automaticamente banco único, manifesto e schema inicial", async () => {
  const f = await fixture(), database = await f.repository.initialize();
  assert.deepEqual(Object.keys(database), ["schemaVersion", "revision", "updatedAt", "groups", "warnings", "bans", "history", "pendingLinks", "domainRules", "receipts"]);
  assert.equal(database.schemaVersion, 1); assert.equal(database.revision, 0); assert.equal(database.updatedAt, null);
  assert.deepEqual(database.domainRules, { whitelist: {}, blacklist: {}, reputation: {} });
  assert.deepEqual((await fsp.readdir(f.dataDir)).sort(), ["manifest.json", "moderation.json"]);
});

test("configuração padrão deixa todas as proteções desativadas", async () => {
  const f = await fixture(), config = f.service.getDefaultGroupConfig();
  assert.equal(config.enabled, false); assert.equal(config.settings.warnings.enabled, false); assert.equal(config.settings.antiLink.enabled, false); assert.equal(config.settings.antiFlood.enabled, false); assert.equal(config.settings.antiSpam.enabled, false);
  assert.equal(config.settings.warnings.limit, 3); assert.equal(config.settings.antiLink.requireApproval, true);
});

test("ensureGroupConfig cria uma vez e atualização parcial preserva campos", async () => {
  const f = await fixture(); const first = await f.repository.ensureGroupConfig("grupo@g.us"), revision = (await f.repository.getDatabase()).revision;
  const second = await f.repository.ensureGroupConfig("grupo@g.us"); assert.deepEqual(second, first); assert.equal((await f.repository.getDatabase()).revision, revision);
  const updated = await f.service.updateGroupConfig("grupo@g.us", { settings: { warnings: { enabled: true, limit: 5 } } });
  assert.equal(updated.settings.warnings.enabled, true); assert.equal(updated.settings.warnings.limit, 5); assert.equal(updated.settings.warnings.finalAction, "notify_admins");
  assert.equal(updated.settings.antiLink.deleteMessage, true); assert.equal(updated.settings.antiLink.enabled, false); assert.equal(await f.service.isModerationEnabled("grupo@g.us"), false);
});

test("revision incrementa em cada escrita e fila não perde atualizações", async () => {
  const f = await fixture(); await f.repository.initialize();
  await Promise.all(Array.from({ length: 20 }, (_, index) => f.repository.appendHistory({ action: `foundation_${index}`, createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString() })));
  const database = await f.repository.getDatabase(); assert.equal(database.revision, 20); assert.equal(database.history.length, 20); assert.equal(new Set(database.history.map(item => item.historyId)).size, 20);
  const leftovers = (await fsp.readdir(f.dataDir)).filter(name => name.endsWith(".tmp")); assert.deepEqual(leftovers, []);
});

test("manifesto e checksum acompanham escrita atômica", async () => {
  const f = await fixture(); await f.repository.ensureGroupConfig("g@g.us");
  const raw = await fsp.readFile(path.join(f.dataDir, "moderation.json")), manifest = JSON.parse(await fsp.readFile(path.join(f.dataDir, "manifest.json"), "utf8"));
  assert.equal(manifest.checksum.algorithm, "sha256"); assert.equal(manifest.checksum.value, digest(raw)); assert.equal(manifest.revision, 1);
});

test("backup é validado, deduplicado e permite recuperação segura", async () => {
  const f = await fixture(); await f.repository.ensureGroupConfig("g@g.us"); const first = await f.repository.createBackup(), second = await f.repository.createBackup();
  assert.equal(first.reused, false); assert.equal(second.reused, true);
  const raw = await fsp.readFile(path.join(first.directory, "moderation.json")), metadata = JSON.parse(await fsp.readFile(path.join(first.directory, "backup-manifest.json"), "utf8")); assert.equal(metadata.checksum.value, digest(raw));
  await fsp.writeFile(path.join(f.dataDir, "moderation.json"), "{corrompido", "utf8"); const recovered = await f.repository.getDatabase(); assert.ok(recovered.groups["g@g.us"]); assert.equal((await f.repository.getDatabase()).schemaVersion, 1);
});

test("arquivo ausente é recriado e corrupção sem backup falha de modo seguro", async () => {
  const f = await fixture(); assert.equal((await f.repository.getDatabase()).schemaVersion, 1);
  const isolated = await fixture(); await isolated.repository.initialize(); await fsp.writeFile(path.join(isolated.dataDir, "moderation.json"), "{}", "utf8");
  await assert.rejects(() => isolated.repository.getDatabase(), /Falha segura/);
});

test("advertências possuem IDs estáveis, contagem ativa e limpeza sem punição", async () => {
  const f = await fixture(); const one = await f.service.addWarning({ groupId: "grupo@g.us", userId: "user@lid", actorId: "admin@lid", reason: "Teste" }), two = await f.service.addWarning({ groupId: "grupo@g.us", userId: "user@lid", actorId: "admin@lid" });
  assert.equal(one.warningId, "WARN-000001"); assert.equal(two.warningId, "WARN-000002"); assert.equal(await f.service.getWarningCount("grupo@g.us", "user@lid"), 2);
  const cleared = await f.service.clearWarnings("grupo@g.us", "user@lid", "admin@lid"); assert.deepEqual(cleared, [one.warningId, two.warningId]); assert.equal(await f.service.getWarningCount("grupo@g.us", "user@lid"), 0);
  assert.ok((await f.repository.getWarningRecords("grupo@g.us", "user@lid")).every(item => item.active === false && item.clearedAt));
});

test("histórico seguro aceita filtros, período e paginação", async () => {
  const f = await fixture();
  for (let index = 1; index <= 7; index += 1) await f.service.registerHistory({ groupId: index < 6 ? "g1@g.us" : "g2@g.us", userId: "u@lid", actorId: "a@lid", action: index % 2 ? "odd" : "even", domain: "Example.COM.", createdAt: `2026-07-${String(index).padStart(2, "0")}T12:00:00.000Z`, metadata: { token: "segredo", safe: index } });
  const page = await f.repository.listHistory({ groupId: "g1@g.us", page: 2, pageSize: 2 }); assert.equal(page.total, 5); assert.equal(page.items.length, 2); assert.equal(page.totalPages, 3);
  assert.equal((await f.repository.listHistory({ action: "even" })).total, 3); assert.equal((await f.repository.listHistory({ domain: "example.com" })).total, 7); assert.equal((await f.repository.listHistory({ from: "2026-07-03", to: "2026-07-05T23:59:59Z" })).total, 3);
  assert.doesNotMatch(JSON.stringify(await f.repository.getDatabase()), /segredo/);
});

test("URL é sanitizada e credenciais de query nunca entram no histórico", () => {
  const f = createModerationService({ repository: { getDefaultGroupConfig: () => ({ enabled: false, settings: { warnings: { enabled: false, limit: 3, finalAction: "notify_admins" }, antiLink: { enabled: false, deleteMessage: true, warnUser: true, adminsBypass: true, requireApproval: true }, antiFlood: { enabled: false }, antiSpam: { enabled: false } } }) } });
  const entry = f.createModerationHistoryEntry({ action: "link_seen", url: "https://user:pass@example.com/path?token=SUPERSECRET#fragment", metadata: { password: "hidden", ok: true } });
  assert.equal(entry.domain, "example.com"); assert.equal(entry.metadata.sanitizedUrl, "https://example.com/path"); assert.equal(entry.metadata.urlHash.length, 64); assert.doesNotMatch(JSON.stringify(entry), /user:pass|SUPERSECRET|hidden|"token"|fragment/);
});

test("normaliza domínio efetivo sem confundir domínio falso", async () => {
  const f = await fixture();
  assert.equal(f.service.normalizeDomain(" WWW.YouTube.COM. "), "youtube.com"); assert.equal(f.service.extractEffectiveDomain("https://www.youtube.com/watch?v=1"), "youtube.com"); assert.equal(f.service.extractEffectiveDomain("https://youtube.com.evil.example/path"), "youtube.com.evil.example");
  assert.equal(f.service.classifyLink("https://youtube.com/watch?v=1"), "youtube"); assert.equal(f.service.classifyLink("https://youtube.com.evil.example"), "other");
  for (const value of ["javascript:alert(1)", "file:///etc/passwd", "data:text/plain,x", ""]) assert.throws(() => f.service.extractEffectiveDomain(value));
});

test("classificação de links é inteiramente local", async () => {
  const f = await fixture(), cases = { "chat.whatsapp.com/a": "whatsapp", "t.me/a": "telegram", "discord.gg/a": "discord", "youtu.be/x": "youtube", "pokemongolive.com/post": "pokemon_go", "nianticcampfire.com": "campfire", "drive.google.com/file": "google_drive", "bit.ly/x": "shortened", "example.org": "other" };
  for (const [url, expected] of Object.entries(cases)) assert.equal(f.service.classifyLink(url), expected);
  const source = await fsp.readFile(path.join(__dirname, "..", "src", "services", "moderationService.js"), "utf8"); assert.equal(/\b(fetch|axios|request)\s*\(/.test(source), false);
});

test("link pendente possui modelo seguro e transições controladas", async () => {
  const f = await fixture(); const pending = await f.service.createPendingLinkRequest({ groupId: "g@g.us", requesterId: "u@lid", url: "https://example.com/path?credential=secret" });
  assert.equal(pending.requestId, "LINK-000001"); assert.equal(pending.status, "pending"); assert.equal(pending.sanitizedUrl, "https://example.com/path"); assert.doesNotMatch(JSON.stringify(pending), /credential|secret/);
  const approved = await f.service.updatePendingLinkStatus(pending.requestId, "approved", { reviewedBy: "admin@lid", reason: "ok" }); assert.equal(approved.status, "approved");
  const published = await f.service.updatePendingLinkStatus(pending.requestId, "published"); assert.equal(published.status, "published"); await assert.rejects(() => f.service.updatePendingLinkStatus(pending.requestId, "rejected"), /Transição inválida/); await assert.rejects(() => f.service.updatePendingLinkStatus(pending.requestId, "desconhecido"), /Status/);
});

test("whitelist, blacklist e reputação suportam escopo sem ativar proteção", async () => {
  const f = await fixture(), createdAt = new Date().toISOString();
  await f.repository.addDomainRule("whitelist", "youtube.com", { scope: "global", groupId: null, reason: "teste", createdBy: "admin", createdAt });
  await f.repository.addDomainRule("blacklist", "evil.example", { scope: "group", groupId: "g@g.us", reason: "teste", createdBy: "admin", createdAt });
  assert.equal(await f.service.isDomainWhitelisted("www.youtube.com"), true); assert.equal(await f.service.isDomainBlacklisted("evil.example", "g@g.us"), true); assert.equal(await f.service.isDomainBlacklisted("evil.example", "outro@g.us"), false);
  assert.ok(await f.repository.removeDomainRule("whitelist", "youtube.com", { scope: "global" })); assert.equal(await f.service.isDomainWhitelisted("youtube.com"), false);
  const reputation = await f.repository.updateDomainReputation("example.com", { score: 7, observations: 2 }); assert.equal(reputation.score, 7); assert.equal((await f.repository.getDomainReputation("example.com")).observations, 2);
  assert.equal(await f.service.isModerationEnabled("g@g.us"), false);
});

test("fundação não cria listener, comando ou integração com Loader", async () => {
  const sources = await Promise.all(["src/repositories/moderationRepository.js", "src/services/moderationService.js"].map(file => fsp.readFile(path.join(__dirname, "..", file), "utf8")));
  assert.equal(/client\.on\s*\(/.test(sources.join("\n")), false); assert.equal(/\.sendMessage\s*\(|msg\.reply\s*\(|\.removeParticipant\s*\(|\.deleteMessage\s*\(/.test(sources.join("\n")), false);
  await assert.rejects(() => fsp.access(path.join(__dirname, "..", "src", "commands", "moderation.js")));
});
