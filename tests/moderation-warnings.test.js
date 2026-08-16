"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fsp = require("fs").promises;
const os = require("os");
const path = require("path");
const identityBase = require("../src/services/identityService");
const { createModerationRepository } = require("../src/repositories/moderationRepository");
const { createModerationService } = require("../src/services/moderationService");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createModerationWarningFlowService } = require("../src/services/moderationWarningFlowService");
const { createModerationWarningCommands, GROUP_ONLY } = require("../src/commands/moderationWarnings");
const { createModerationAntiLinkCommands } = require("../src/commands/moderationAntiLink");
const { createGuidedFlowAnswer } = require("../src/events/guidedFlowAnswer");

const roles = {
  member: { name: "member", rank: 0, isModerator: false, isAdmin: false, isOwner: false },
  moderator: { name: "moderator", rank: 1, isModerator: true, isAdmin: false, isOwner: false },
  admin: { name: "admin", rank: 2, isModerator: true, isAdmin: true, isOwner: false },
  owner: { name: "owner", rank: 4, isModerator: true, isAdmin: true, isOwner: true }
};
const names = { "actor@lid": "Moderador", "member@lid": "Membro Alvo", "other@lid": "Outro Membro", "admin@lid": "Administrador", "owner@lid": "Dono", "bot@lid": "MikaBot" };

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-warning-"));
  const repository = createModerationRepository({ dataDir: path.join(root, "moderation"), backupRoot: path.join(root, "backups") });
  const identity = { ...identityBase, resolveDisplayName: async id => names[identityBase.normalizeUserId(id)] || "Treinador" };
  const moderation = createModerationService({ repository, identityService: identity });
  const guided = createGuidedFlowService({ filePath: path.join(root, "flows.json") });
  const warningFlow = createModerationWarningFlowService({ guidedFlowService: guided, moderationService: moderation });
  const commands = createModerationWarningCommands({ moderationService: moderation, moderationWarningFlowService: warningFlow, identityService: identity });
  const byName = Object.fromEntries(commands.map(command => [command.name, command]));
  const participants = [
    { id: "actor@lid", isAdmin: false, isSuperAdmin: false }, { id: "member@lid", isAdmin: false, isSuperAdmin: false }, { id: "other@lid", isAdmin: false, isSuperAdmin: false },
    { id: "admin@lid", isAdmin: true, isSuperAdmin: false }, { id: "owner@lid", isAdmin: true, isSuperAdmin: true }, { id: "bot@lid", isAdmin: true, isSuperAdmin: false }
  ];
  const removed = [];
  const chat = { isGroup: true, participants, removeParticipants: async ids => {
    removed.push(...ids);
    for (const id of ids) {
      const index = participants.findIndex(item => identity.identitiesMatch(item, id));
      if (index >= 0) participants.splice(index, 1);
    }
  } }, client = { info: { wid: "bot@lid" } }, replies = [];
  function message(options = {}) { const target = options.target || "member@lid"; return { from: options.private ? "actor@lid" : "group@g.us", author: "actor@lid", body: options.body || "", id: { _serialized: options.messageId || `MSG-${replies.length + 1}` }, mentionedIds: options.mention === false ? [] : [target], hasQuotedMsg: Boolean(options.quoted), getQuotedMessage: async () => ({ author: options.quoted }), reply: async text => replies.push(String(text)) }; }
  const loader = (role = roles.admin, override = {}) => ({ chat: override.private ? { isGroup: false, participants: [] } : chat, role: { ...role, identity: { id: "actor@lid", candidates: ["actor@lid"] } }, identity: { id: "actor@lid" } });
  async function execute(name, msg, args, role = roles.admin, loaderOverride = {}) { return byName[name].execute(client, msg, args, loader(role, loaderOverride)); }
  return { root, repository, moderation, guided, warningFlow, commands, byName, participants, chat, client, replies, removed, message, loader, execute, identity };
}

test("comandos e aliases são registrados sem remover comandos separados", async () => {
  const f = await fixture(); assert.deepEqual(Object.keys(f.byName), ["warn", "warnings", "resetwarn", "clearwarns"]);
  assert.deepEqual(f.byName.warn.aliases, ["avisar", "advertir", "advertencia"]); assert.deepEqual(f.byName.warnings.aliases, ["advertências", "avisos"]);
  assert.deepEqual(f.byName.resetwarn.aliases, ["limparavisos", "zeraravisos"]); assert.equal(f.byName.clearwarns.aliases.length, 0);
});

test("Loader prioriza !warn canônico sobre alias legado de outro comando", async () => {
  const source = await fsp.readFile(path.join(__dirname, "..", "src", "loader.js"), "utf8");
  assert.match(source, /Number\(b\.canonical\) - Number\(a\.canonical\)/);
});

test("comandos recusam privado sem expor dados", async () => {
  const f = await fixture(); const msg = f.message({ private: true, mention: false }); await f.execute("warnings", msg, [], roles.member, { private: true }); assert.equal(f.replies.at(-1), GROUP_ONLY); assert.doesNotMatch(f.replies.at(-1), /group@g\.us|member@lid|telefone/i);
});

test("!warn válido por administrador usa menção, motivo normalizado e histórico", async () => {
  const f = await fixture(), msg = f.message({ body: "!warn @membro   Spam", messageId: "MSG-ADMIN" }); await f.execute("warn", msg, ["@membro", "Spam"], roles.admin);
  assert.match(f.replies.at(-1), /ADVERTÊNCIA REGISTRADA/); assert.match(f.replies.at(-1), /Membro Alvo/); assert.match(f.replies.at(-1), /1\/3/); assert.match(f.replies.at(-1), /Spam/);
  const records = await f.repository.getWarningRecords("group@g.us", "member@lid"); assert.equal(records.length, 1); assert.equal(records[0].source, "manual"); assert.equal(records[0].reason, "Spam"); assert.equal(records[0].active, true); assert.equal(records[0].receipt.length, 64);
  assert.equal((await f.repository.listHistory({ action: "warning_created" })).total, 1);
});

test("!acaoavisos banir persiste, pune em 3/3 e remove reincidente readicionado", async () => {
  const f = await fixture();
  const adminCommands = createModerationAntiLinkCommands({ moderationService: f.moderation });
  const adminLoader = f.loader(roles.admin);
  const configMessage = f.message();
  await adminCommands.find(command => command.name === "acaoavisos").execute(f.client, configMessage, ["banir"], adminLoader);
  await adminCommands.find(command => command.name === "limiteavisos").execute(f.client, configMessage, ["3"], adminLoader);
  await adminCommands.find(command => command.name === "banreentrada").execute(f.client, configMessage, ["on"], adminLoader);

  const reloadedRepository = createModerationRepository({
    dataDir: path.join(f.root, "moderation"),
    backupRoot: path.join(f.root, "backups")
  });
  const reloadedModeration = createModerationService({ repository: reloadedRepository, identityService: f.identity });
  const persisted = await reloadedModeration.getGroupConfig("group@g.us");
  assert.equal(persisted.settings.warnings.finalAction, "ban_and_remove");
  assert.equal(persisted.settings.warnings.limit, 3);
  assert.equal(persisted.settings.ban.enabled, true);
  assert.equal(persisted.settings.ban.blockReentry, true);

  for (let index = 1; index <= 3; index += 1) {
    await f.execute("warn", f.message({ messageId: `BAN-MANUAL-${index}` }), ["@membro", `Aviso ${index}`], roles.admin);
    if (index < 3) assert.equal(await f.repository.countActiveBans("group@g.us"), 0);
  }
  assert.equal(await f.repository.countActiveBans("group@g.us"), 1);
  assert.equal(f.removed.length, 1);
  assert.match(f.replies.find(text => /Membro banido e removido/.test(text)), /Membro banido e removido/);

  const outsideResult = await f.moderation.applyWarningFinalAction({
    groupId: "group@g.us", targetId: "member@lid", actorId: "actor@lid", botId: "bot@lid",
    targetParticipant: null, botParticipant: f.participants.find(item => item.id === "bot@lid"),
    chat: f.chat, receiptId: "OUTSIDE-4", warningCount: 4, warningLimit: 3, crossedLimit: false
  });
  assert.equal(outsideResult.action, "none");
  assert.equal(f.removed.length, 1);

  f.participants.splice(1, 0, { id: "member@lid", isAdmin: false, isSuperAdmin: false });
  await f.execute("warn", f.message({ messageId: "BAN-MANUAL-4" }), ["@membro", "Aviso 4"], roles.admin);
  assert.equal(await f.repository.countActiveBans("group@g.us"), 1);
  assert.equal(f.removed.length, 2);
  assert.match(f.replies.at(-1), /Advertências ativas: 4/);
  assert.match(f.replies.at(-1), /Limite configurado: 3/);
  assert.match(f.replies.at(-1), /Status: reincidência acima do limite/);
  assert.match(f.replies.at(-1), /Membro banido e removido novamente/);
  assert.doesNotMatch(f.replies.at(-1), /4\/3/);
  assert.equal((await f.repository.listHistory({ action: "member_removed" })).total, 1);
  assert.equal((await f.repository.listHistory({ action: "ban_created" })).total, 1);
  assert.equal((await f.repository.listHistory({ action: "warning_reentry_reoffense" })).total, 1);
  assert.equal((await f.repository.listHistory({ action: "warning_reoffense_removed" })).total, 1);

  await f.moderation.clearWarnings("group@g.us", "member@lid", "actor@lid");
  f.participants.splice(1, 0, { id: "member@lid", isAdmin: false, isSuperAdmin: false });
  await f.execute("warn", f.message({ messageId: "NEW-CHANCE-1" }), ["@membro", "Nova chance"], roles.admin);
  assert.equal(await f.moderation.getWarningCount("group@g.us", "member@lid"), 1);
  assert.equal(f.removed.length, 2);
  assert.match(f.replies.at(-1), /1\/3/);
});

test("reincidência falha com segurança sem permissão, com falha de remoção e para protegidos", async () => {
  const f = await fixture();
  await f.moderation.updateGroupConfig("group@g.us", { settings: { warnings: { enabled: true, limit: 3, finalAction: "ban_and_remove" }, ban: { enabled: true } } });
  const member = f.participants.find(item => item.id === "member@lid");
  const bot = f.participants.find(item => item.id === "bot@lid");
  await f.moderation.banPlayer({ groupId: "group@g.us", targetId: member.id, actorId: "actor@lid", receiptId: "PREVIOUS-BAN" });
  const base = { groupId: "group@g.us", targetId: member.id, actorId: "actor@lid", botId: bot.id, targetParticipant: member, warningCount: 4, warningLimit: 3, crossedLimit: false };

  const failed = await f.moderation.applyWarningFinalAction({ ...base, botParticipant: bot, chat: { removeParticipants: async () => { throw new Error("unavailable"); } }, receiptId: "REOFFENSE-FAIL" });
  assert.equal(failed.reoffense, true);
  assert.equal(failed.removed, false);
  assert.equal(failed.failureCode, "remove_failed");

  const noPermission = await f.moderation.applyWarningFinalAction({ ...base, botParticipant: { ...bot, isAdmin: false }, chat: f.chat, receiptId: "REOFFENSE-NO-PERMISSION", warningCount: 5 });
  assert.equal(noPermission.reoffense, true);
  assert.equal(noPermission.removed, false);
  assert.equal(noPermission.failureCode, "permission_or_protection");

  for (const protectedId of ["admin@lid", "owner@lid", "bot@lid"]) {
    const participant = f.participants.find(item => item.id === protectedId);
    await f.moderation.banPlayer({ groupId: "group@g.us", targetId: protectedId, actorId: "actor@lid", receiptId: `BAN-${protectedId}` });
    const result = await f.moderation.applyWarningFinalAction({ ...base, targetId: protectedId, targetParticipant: participant, botParticipant: bot, chat: f.chat, receiptId: `PROTECTED-${protectedId}` });
    assert.equal(result.removed, false);
    assert.equal(result.failureCode, "permission_or_protection");
  }
  assert.equal(f.removed.length, 0);
});

test("trava remoções repetidas até o WhatsApp fornecer a nova geração do participante", async () => {
  const f = await fixture();
  await f.moderation.updateGroupConfig("group@g.us", { settings: { warnings: { enabled: true, limit: 3, finalAction: "ban_and_remove" }, ban: { enabled: true } } });
  const bot = f.participants.find(item => item.id === "bot@lid");
  const firstGeneration = f.participants.find(item => item.id === "member@lid");
  await f.moderation.banPlayer({ groupId: "group@g.us", targetId: firstGeneration.id, actorId: "actor@lid", receiptId: "LOCK-BAN" });
  const removals = [];
  const delayedChat = { isGroup: true, participants: f.participants, removeParticipants: async ids => removals.push(...ids) };
  const base = {
    groupId: "group@g.us", targetId: firstGeneration.id, actorId: "actor@lid", botId: bot.id,
    botParticipant: bot, chat: delayedChat, warningLimit: 3, crossedLimit: false
  };

  const first = await f.moderation.applyWarningFinalAction({ ...base, targetParticipant: firstGeneration, receiptId: "LOCK-5", warningCount: 5 });
  assert.equal(first.removed, true);
  assert.equal(removals.length, 1);

  const repeated = await f.moderation.applyWarningFinalAction({ ...base, targetParticipant: firstGeneration, receiptId: "LOCK-6", warningCount: 6 });
  assert.equal(repeated.removed, false);
  assert.equal(repeated.removalPending, true);
  assert.equal(repeated.failureCode, "removal_pending");
  assert.equal(removals.length, 1);

  const index = f.participants.indexOf(firstGeneration);
  assert.notEqual(index, -1);
  f.participants.splice(index, 1);
  const secondGeneration = { id: "member@lid", isAdmin: false, isSuperAdmin: false };
  f.participants.push(secondGeneration);

  const afterReentry = await f.moderation.applyWarningFinalAction({ ...base, targetParticipant: secondGeneration, receiptId: "LOCK-7", warningCount: 7 });
  assert.equal(afterReentry.removed, true);
  assert.equal(afterReentry.reoffense, true);
  assert.equal(removals.length, 2);
});

test("falha de remoção libera a trava para nova tentativa", async () => {
  const f = await fixture();
  await f.moderation.updateGroupConfig("group@g.us", { settings: { warnings: { enabled: true, limit: 3, finalAction: "ban_and_remove" }, ban: { enabled: true } } });
  const member = f.participants.find(item => item.id === "member@lid");
  const bot = f.participants.find(item => item.id === "bot@lid");
  await f.moderation.banPlayer({ groupId: "group@g.us", targetId: member.id, actorId: "actor@lid", receiptId: "LOCK-FAIL-BAN" });
  let attempts = 0;
  const chat = { removeParticipants: async () => { attempts += 1; throw new Error("unavailable"); } };
  const base = { groupId: "group@g.us", targetId: member.id, actorId: "actor@lid", botId: bot.id, targetParticipant: member, botParticipant: bot, chat, warningLimit: 3, crossedLimit: false };

  const first = await f.moderation.applyWarningFinalAction({ ...base, receiptId: "LOCK-FAIL-1", warningCount: 4 });
  const second = await f.moderation.applyWarningFinalAction({ ...base, receiptId: "LOCK-FAIL-2", warningCount: 5 });
  assert.equal(first.failureCode, "remove_failed");
  assert.equal(second.failureCode, "remove_failed");
  assert.equal(attempts, 2);
});

test("moderador cadastrado pode advertir e membro comum não pode", async () => {
  const f = await fixture(); await f.execute("warn", f.message({ messageId: "M1" }), ["@membro", "Teste"], roles.moderator); assert.equal(await f.moderation.getWarningCount("group@g.us", "member@lid"), 1);
  await f.execute("warn", f.message({ messageId: "M2" }), ["@membro", "Teste"], roles.member); assert.match(f.replies.at(-1), /não possui permissão/); assert.equal(await f.moderation.getWarningCount("group@g.us", "member@lid"), 1);
});

test("alvo por resposta funciona e menção tem prioridade", async () => {
  const f = await fixture(); const replyOnly = f.message({ mention: false, quoted: "member@lid", messageId: "R1" }); await f.execute("warn", replyOnly, ["Motivo", "respondido"], roles.admin); assert.equal((await f.repository.getWarningRecords("group@g.us", "member@lid")).length, 1);
  const both = f.message({ target: "other@lid", quoted: "member@lid", messageId: "R2" }); await f.execute("warn", both, ["@outro", "Prioridade"], roles.admin); assert.equal((await f.repository.getWarningRecords("group@g.us", "other@lid")).length, 1); assert.equal((await f.repository.getWarningRecords("group@g.us", "member@lid")).length, 1);
});

test("resetwarn resolve resposta @lid mesmo quando id do comando não possui _serialized", async () => {
  const f = await fixture();
  await f.execute("warn", f.message({ messageId: "PREP-RESET" }), ["@membro"], roles.admin);
  const message = f.message({ mention: false, quoted: "member@lid" });
  message.id = { toString: () => "RESET-QUOTED" };
  await f.execute("resetwarn", message, [], roles.admin);
  assert.match(f.replies.at(-1), /Confirmar limpeza/);
  assert.equal(message.id._serialized, "RESET-QUOTED");
});

test("falha de participantes não é apresentada como membro fora do grupo", async () => {
  const f = await fixture();
  const message = f.message({ target: "member@lid" });
  message.from = "unavailable@g.us";
  await f.byName.warn.execute(f.client, message, ["@membro"], {
    chat: { isGroup: true, participants: [] },
    role: { ...roles.admin, identity: { id: "actor@lid" } },
    identity: { id: "actor@lid" }
  });
  assert.match(f.replies.at(-1), /consultar os participantes/);
  assert.doesNotMatch(f.replies.at(-1), /não pertence/);
});

test("motivo é opcional, normalizado e limitado a 300 caracteres", async () => {
  const f = await fixture(); await f.execute("warn", f.message({ messageId: "E1" }), ["@membro"], roles.admin); assert.match(f.replies.at(-1), /Advertência manual/);
  await f.execute("warn", f.message({ messageId: "E2" }), ["@membro", "x".repeat(301)], roles.admin); assert.match(f.replies.at(-1), /300/);
  await f.execute("warn", f.message({ messageId: "E3" }), ["@membro", "x".repeat(300)], roles.admin); assert.equal((await f.repository.getWarningRecords("group@g.us", "member@lid")).at(-1).reason.length, 300);
});

test("rejeita alvo ausente, escrito manualmente, inexistente e fora do grupo", async () => {
  const f = await fixture(); await f.execute("warn", f.message({ mention: false, messageId: "T1" }), ["5511999999999", "motivo"], roles.admin); assert.match(f.replies.at(-1), /Mencione/);
  await f.execute("warn", f.message({ target: "missing@lid", messageId: "T2" }), ["@missing", "motivo"], roles.admin); assert.match(f.replies.at(-1), /não pertence/); assert.equal(Object.keys((await f.repository.getDatabase()).warnings).length, 0);
});

test("bot, próprio ator, dono e administradores são protegidos", async () => {
  const f = await fixture(); for (const [target, expected] of [["bot@lid", /protegido/], ["actor@lid", /protegido/], ["owner@lid", /protegido/], ["admin@lid", /protegido/]]) { await f.execute("warn", f.message({ target, messageId: `P-${target}` }), [`@${target}`, "motivo"], roles.owner); assert.match(f.replies.at(-1), expected); }
  assert.equal(Object.keys((await f.repository.getDatabase()).warnings).length, 0);
});

test("mesma mensagem é idempotente e motivos repetidos em mensagens distintas são aceitos", async () => {
  const f = await fixture(); const same = f.message({ messageId: "SAME" }); await f.execute("warn", same, ["@membro", "Spam"], roles.admin); await f.execute("warn", same, ["@membro", "Spam"], roles.admin); assert.equal(await f.moderation.getWarningCount("group@g.us", "member@lid"), 1); assert.equal((await f.repository.listHistory({ action: "warning_created" })).total, 1);
  await f.execute("warn", f.message({ messageId: "OTHER" }), ["@membro", "Spam"], roles.admin); assert.equal(await f.moderation.getWarningCount("group@g.us", "member@lid"), 2);
});

test("limite padrão cruza uma vez, não pune e pode cruzar novamente após reset", async () => {
  const f = await fixture(); for (let index = 1; index <= 4; index += 1) await f.execute("warn", f.message({ messageId: `L${index}` }), ["@membro", `Motivo ${index}`], roles.admin);
  assert.equal(await f.moderation.getWarningCount("group@g.us", "member@lid"), 4); assert.equal((await f.repository.listHistory({ action: "warning_limit_reached" })).total, 1); assert.match(f.replies.at(-2), /atingiu o limite|ADVERTÊNCIA/);
  await f.moderation.resetWarnings({ groupId: "group@g.us", targetId: "member@lid", actorId: "actor@lid", actorRole: roles.admin });
  for (let index = 5; index <= 7; index += 1) await f.execute("warn", f.message({ messageId: `L${index}` }), ["@membro", `Motivo ${index}`], roles.admin);
  assert.equal((await f.repository.listHistory({ action: "warning_limit_reached" })).total, 2);
  const history = await f.repository.listHistory({ action: "member_removed" }); assert.equal(history.total, 0);
});

test("!warnings permite consulta própria e bloqueia terceiro para membro comum", async () => {
  const f = await fixture(); await f.moderation.warnPlayer({ groupId: "group@g.us", targetId: "actor@lid", targetParticipant: f.participants[0], actorId: "admin@lid", actorRole: roles.admin, botId: "bot@lid", reason: "Meu aviso", receiptId: "SELF-W" });
  await f.execute("warnings", f.message({ mention: false }), [], roles.member); assert.match(f.replies.at(-1), /Meu aviso/); assert.match(f.replies.at(-1), /Moderador/);
  await f.execute("warnings", f.message(), ["@membro"], roles.member); assert.match(f.replies.at(-1), /apenas as próprias/);
});

test("administrador consulta terceiro, histórico vazio é amigável e não expõe IDs", async () => {
  const f = await fixture(); await f.execute("warnings", f.message(), ["@membro"], roles.admin); assert.equal(f.replies.at(-1), "✅ Este membro não possui advertências ativas.");
  await f.execute("warn", f.message({ messageId: "V1" }), ["@membro", "Conduta"], roles.admin); await f.execute("warnings", f.message(), ["@membro"], roles.admin); const output = f.replies.at(-1); assert.match(output, /HISTÓRICO ATIVO/); assert.match(output, /Conduta/); for (const forbidden of ["WARN-", "actor@lid", "member@lid", "group@g.us", "@c.us", "telefone"]) assert.doesNotMatch(output, new RegExp(forbidden, "i"));
});

test("paginação usa cinco itens e número nunca vira usuário", async () => {
  const f = await fixture(); for (let index = 1; index <= 7; index += 1) await f.moderation.warnPlayer({ groupId: "group@g.us", targetId: "member@lid", targetParticipant: f.participants[1], actorId: "actor@lid", actorRole: roles.admin, botId: "bot@lid", reason: `Aviso ${index}`, receiptId: `PAGE-${index}` });
  await f.execute("warnings", f.message(), ["@membro", "2"], roles.admin); assert.match(f.replies.at(-1), /Página 2 de 2/); assert.match(f.replies.at(-1), /Aviso [12]/); assert.doesNotMatch(f.replies.at(-1), /Aviso 7/);
  await f.execute("warnings", f.message({ mention: false }), ["2"], roles.member); assert.doesNotMatch(f.replies.at(-1), /não pertence|alvo/i);
});

test("reset pede confirmação, aceita Sim e preserva registros com clearedAt/clearedBy", async () => {
  const f = await fixture(); await f.execute("warn", f.message({ messageId: "RESET-W" }), ["@membro", "Resetar"], roles.admin); await f.execute("resetwarn", f.message(), ["@membro"], roles.admin); assert.match(f.replies.at(-1), /Confirmar limpeza/); assert.equal(await f.warningFlow.hasActiveFlow({ platform: "whatsapp", groupId: "group@g.us", userId: "actor@lid", isGroup: true }), true);
  const result = await f.warningFlow.handleAnswer({ platform: "whatsapp", groupId: "group@g.us", userId: "actor@lid", isGroup: true, role: roles.admin, replyText: text => f.replies.push(String(text)) }, "sim"); assert.equal(result.status, "reset"); assert.equal(await f.moderation.getWarningCount("group@g.us", "member@lid"), 0);
  const records = await f.repository.getWarningRecords("group@g.us", "member@lid"); assert.equal(records.length, 1); assert.equal(records[0].active, false); assert.ok(records[0].clearedAt); assert.equal(records[0].clearedBy, "actor@lid"); assert.equal((await f.repository.listHistory({ action: "warning_reset" })).total, 1);
});

test("clearwarns tem o mesmo fluxo; cancelar e voltar não limpam", async () => {
  const f = await fixture(); await f.execute("warn", f.message({ messageId: "C1" }), ["@membro", "Manter"], roles.admin);
  await f.execute("clearwarns", f.message(), ["@membro"], roles.admin); await f.warningFlow.handleAnswer({ platform: "whatsapp", groupId: "group@g.us", userId: "actor@lid", isGroup: true, replyText: text => f.replies.push(String(text)) }, "cancelar"); assert.equal(await f.moderation.getWarningCount("group@g.us", "member@lid"), 1);
  await f.execute("resetwarn", f.message(), ["@membro"], roles.admin); await f.warningFlow.handleAnswer({ platform: "whatsapp", groupId: "group@g.us", userId: "actor@lid", isGroup: true, replyText: text => f.replies.push(String(text)) }, "voltar"); assert.equal(await f.moderation.getWarningCount("group@g.us", "member@lid"), 1);
});

test("reset sem ativas não cria sessão e membro comum é recusado", async () => {
  const f = await fixture(); await f.execute("resetwarn", f.message(), ["@membro"], roles.admin); assert.equal(f.replies.at(-1), "✅ Este membro não possui advertências ativas.");
  await f.execute("resetwarn", f.message(), ["@membro"], roles.member); assert.match(f.replies.at(-1), /não possui permissão/);
});

test("falha de identidade e persistência falham de modo seguro", async () => {
  const f = await fixture(); const brokenQuote = f.message({ mention: false, quoted: "member@lid" }); brokenQuote.getQuotedMessage = async () => { throw new Error("WhatsApp indisponível"); }; await f.execute("warn", brokenQuote, ["motivo"], roles.admin); assert.match(f.replies.at(-1), /consultar a mensagem respondida/);
  const failingCommands = createModerationWarningCommands({ moderationService: { ...f.moderation, warnPlayer: async () => { throw new Error("C:\\session\\token=secret"); } }, moderationWarningFlowService: f.warningFlow, identityService: f.identity }); const warn = failingCommands.find(command => command.name === "warn"), replies = [], msg = { ...f.message(), reply: async text => replies.push(String(text)) }; await warn.execute(f.client, msg, ["@membro", "motivo"], f.loader(roles.admin)); assert.equal(replies[0], "❌ Não foi possível concluir a operação de advertências agora.");
});

test("roteador central encaminha confirmação em grupo sem alterar Eventos", async () => {
  let handled = 0; const moderationFlow = { hasActiveFlow: async context => context.isGroup, handleAnswer: async () => (++handled, { status: "reset" }) }, eventFlow = { hasActiveFlow: async () => false, handleAnswer: async () => ({ status: "event" }) };
  const handler = createGuidedFlowAnswer({ moderationWarningFlow: moderationFlow, eventGuidedFlow: eventFlow }); const context = { platform: "whatsapp", conversationId: "group@g.us", groupId: "group@g.us", userId: "actor@lid", isGroup: true, replyText: async () => undefined };
  assert.equal(await handler.hasActiveFlow(context), true); assert.equal((await handler.handleGuidedFlowAnswer({ context, text: "1" })).status, "reset"); assert.equal(handled, 1);
});

test("nenhum listener, punição, antilink ou menu de segurança foi criado", async () => {
  const files = ["src/commands/moderationWarnings.js", "src/services/moderationService.js", "src/services/moderationWarningFlowService.js", "src/events/guidedFlowAnswer.js"], sources = await Promise.all(files.map(file => fsp.readFile(path.join(__dirname, "..", file), "utf8"))), source = sources.join("\n");
  assert.equal(/client\.on\s*\(/.test(source), false); assert.equal(/setInterval\s*\(|removeParticipant\s*\(|\.kick\s*\(|\.ban\s*\(|\.mute\s*\(/.test(source), false); assert.equal(/name:\s*"seguranca"|name:\s*"segurança"/.test(source), false);
});
