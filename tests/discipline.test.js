"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("fs").promises;
const os = require("os");
const path = require("path");
const { createDisciplineRepository } = require("../src/repositories/disciplineRepository");
const { createDisciplineService } = require("../src/services/disciplineService");

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mikabot-discipline-"));
  const repository = createDisciplineRepository({ filePath: path.join(root, "state.json") });
  const notifications = [], logs = [];
  const service = createDisciplineService({
    repository,
    permissionService: { isProtectedOwner: identity => identity === "owner@lid" },
    notifyAdministrators: async notice => { notifications.push(notice); return true; },
    logger: line => logs.push(line)
  });
  return { root, repository, service, notifications, logs };
}

const ban = (service, identity = "member@lid", overrides = {}) => service.recordBan({
  identity, administrator: "admin@lid", platform: "whatsapp",
  groupId: "group@g.us", scope: "group", reason: "Teste", ...overrides
});

test("saída voluntária e remoção administrativa não criam banimento", async () => {
  const f = await fixture();
  assert.equal((await f.service.getMemberStatus("member@lid")).activeBanCount, 0);
  assert.equal(Object.keys((await f.repository.loadDatabase()).members).length, 0);
});

test("primeiro, segundo e terceiro banimentos ativam reincidência comunitária", async () => {
  const f = await fixture();
  assert.equal((await ban(f.service)).member.activeBanCount, 1);
  assert.equal((await ban(f.service, "member@lid", { groupId: "other@g.us" })).member.activeBanCount, 2);
  const third = await ban(f.service, "member@lid", { platform: "telegram", groupId: "tg", scope: "platform" });
  assert.equal(third.member.activeBanCount, 3);
  assert.equal(third.member.communityBan, true);
  assert.equal(third.member.platformBlocks.whatsapp, true);
  assert.equal(third.member.platformBlocks.telegram, true);
  assert.equal(f.notifications.length, 1);
});

test("escopos grupo, plataforma e comunidade são aplicados corretamente", async () => {
  const f = await fixture();
  await ban(f.service);
  assert.equal((await f.service.isBlocked({ identity: "member@lid", platform: "whatsapp", groupId: "group@g.us" })).blocked, true);
  assert.equal((await f.service.isBlocked({ identity: "member@lid", platform: "whatsapp", groupId: "other@g.us" })).blocked, false);
  await ban(f.service, "platform@lid", { scope: "platform" });
  assert.equal((await f.service.isBlocked({ identity: "platform@lid", platform: "whatsapp", groupId: "other@g.us" })).blocked, true);
  await ban(f.service, "community@lid", { scope: "community" });
  assert.equal((await f.service.isBlocked({ identity: "community@lid", platform: "telegram", groupId: "any" })).blocked, true);
});

test("liberação por plataforma, ambas e último ban preserva histórico", async () => {
  const f = await fixture();
  await ban(f.service);
  await ban(f.service, "member@lid", { platform: "telegram", groupId: "tg", scope: "platform" });
  const kept = await f.service.revoke({ identity: "member@lid", platforms: "whatsapp", mode: "keep", administrator: "admin@lid" });
  assert.equal(kept.bans.length, 2);
  assert.equal((await f.service.isBlocked({ identity: "member@lid", platform: "whatsapp", groupId: "group@g.us" })).blocked, false);
  assert.equal((await f.service.isBlocked({ identity: "member@lid", platform: "telegram", groupId: "tg" })).blocked, true);
  const last = await f.service.revoke({ identity: "member@lid", platforms: "telegram", mode: "last" });
  assert.equal(last.bans.filter(item => item.status === "revoked").length, 1);
  const reset = await f.service.revoke({ identity: "member@lid", platforms: "both", mode: "reset" });
  assert.equal(reset.activeBanCount, 0);
  assert.equal(reset.bans.length, 2);
});

test("novo banimento após liberação volta a bloquear", async () => {
  const f = await fixture();
  await ban(f.service);
  await f.service.revoke({ identity: "member@lid", platforms: "whatsapp", mode: "reset" });
  await ban(f.service);
  const status = await f.service.getMemberStatus("member@lid");
  assert.equal(status.activeBanCount, 1);
  assert.equal(status.bans.length, 2);
});

test("aliases exatos reconciliam LID e telefone sem comparação parcial", async () => {
  const f = await fixture();
  await ban(f.service, { id: "abc@lid", candidates: ["abc@lid", "5511999999999@c.us"] });
  assert.equal((await f.service.isBlocked({ identity: "5511999999999@s.whatsapp.net", platform: "whatsapp", groupId: "group@g.us" })).blocked, true);
  assert.equal((await f.service.isBlocked({ identity: "99999999@c.us", platform: "whatsapp", groupId: "group@g.us" })).blocked, false);
});

test("ausência de identidade Telegram não causa erro", async () => {
  const f = await fixture();
  await ban(f.service);
  assert.equal((await f.service.isBlocked({ identity: "member@lid", platform: "telegram" })).blocked, false);
});

test("owner protegida nunca pode ser alvo", async () => {
  const f = await fixture();
  await assert.rejects(() => ban(f.service, "owner@lid"), error => error.code === "protected_owner");
});

test("pedido administrativo para outra plataforma é persistido", async () => {
  const f = await fixture();
  const request = await f.service.requestOtherPlatformRelease({ identity: "member@lid", platform: "telegram" });
  assert.equal(request.status, "pending");
  assert.equal((await f.service.getMemberStatus("member@lid")).releaseRequests.length, 1);
});

test("logs disciplinares são sanitizados e não contêm identidades", async () => {
  const f = await fixture();
  await ban(f.service, "5511999999999@c.us");
  assert.match(f.logs[0], /action=ban.*activeBanCount=1/);
  assert.doesNotMatch(f.logs[0], /5511999999999|@c\.us|group@g\.us|admin@lid/);
});

test("escrita persiste em nova instância sem temporários", async () => {
  const f = await fixture();
  await ban(f.service);
  const reloaded = createDisciplineRepository({ filePath: f.repository.filePath });
  assert.equal(Object.values((await reloaded.loadDatabase()).members)[0].bans.length, 1);
  assert.equal((await fs.readdir(f.root)).some(name => name.endsWith(".tmp")), false);
});
