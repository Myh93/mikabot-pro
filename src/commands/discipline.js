"use strict";

const disciplineDefault = require("../services/disciplineService");
const registrationRepositoryDefault = require("../repositories/registrationRepository");
const identityDefault = require("../services/identityService");
const { ensureMessageIdSerialized } = require("../services/whatsappClientHealthService");
const memberExperienceDefault = require("../services/memberExperienceService");

function createDisciplineCommands(options = {}) {
  const discipline = options.disciplineService || disciplineDefault;
  const registrations = options.registrationRepository || registrationRepositoryDefault;
  const identities = options.identityService || identityDefault;
  const memberExperience = options.memberExperienceService || memberExperienceDefault;
  const confirmations = new Map();
  const key = (msg, context) => `${context.role?.identity?.id || msg.author || msg.from}|${msg.from}`;
  const display = (identity, msg) => identities.resolveDisplayName(identity, { msg });

  async function resolveTarget(msg, args) {
    let raw = msg.mentionedIds?.[0] || msg._data?.mentionedJidList?.[0] || null;
    let consumed = 0;
    if (!raw && msg.hasQuotedMsg && typeof msg.getQuotedMessage === "function") {
      if (!ensureMessageIdSerialized(msg).ok) throw Object.assign(new Error("Mensagem citada indisponível."), { code: "quoted_unavailable" });
      const quoted = await msg.getQuotedMessage();
      raw = quoted?.author || quoted?.from || null;
    }
    if (!raw && /^\d{12}$/.test(String(args[0] || "").replace(/\D/g, ""))) {
      const registration = await registrations.findByFriendCode(args[0]);
      raw = registration ? { id: registration.primaryIdentity, candidates: registration.identityAliases } : null;
      consumed = 1;
    }
    if (!raw && args[0] && /@(lid|c\.us|s\.whatsapp\.net)$/i.test(args[0])) {
      raw = args[0];
      consumed = 1;
    }
    if (!raw) throw Object.assign(new Error("Responda a uma mensagem, mencione o membro ou informe Friend Code/identidade canônica."), { code: "target_required" });
    return { identity: raw, consumed };
  }

  async function banir(client, msg, args, context = {}) {
    const confirmationKey = key(msg, context);
    if (String(args[0] || "").toLowerCase() === "confirmar") {
      const pending = confirmations.get(confirmationKey);
      if (!pending || pending.expiresAt < Date.now()) return msg.reply("❌ Não há banimento pendente para confirmar.");
      confirmations.delete(confirmationKey);
      const result = await discipline.recordBan(pending);
      let removal = "não aplicável";
      if (context.chat?.isGroup && typeof context.chat.removeParticipants === "function" && pending.removalTarget) {
        try {
          await context.chat.removeParticipants([pending.removalTarget]);
          removal = "concluída";
        } catch (_) { removal = "pendente de ação administrativa"; }
      }
      try { await memberExperience.announceBan(client, { groupId: pending.groupId, memberId: pending.removalTarget, reason: pending.reason }); } catch (_) { /* mídia nunca bloqueia o banimento */ }
      return msg.reply(`✅ Banimento registrado.\n\nEscopo: ${pending.scope}\nBanimentos ativos: ${result.member.activeBanCount}\nRemoção: ${removal}`);
    }
    const target = await resolveTarget(msg, args);
    const rest = args.slice(target.consumed);
    const scope = ["group", "platform", "community"].includes(rest[0]) ? rest.shift() : "group";
    const reason = rest.join(" ").trim();
    if (!reason) return msg.reply("❌ Informe o motivo do banimento.");
    const name = await display(target.identity, msg);
    confirmations.set(confirmationKey, {
      identity: target.identity, administrator: context.role?.identity || msg.author,
      platform: "whatsapp", groupId: msg.from, scope, reason,
      removalTarget: typeof target.identity === "string" ? target.identity : target.identity?.id,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    return msg.reply(`⚠️ Confirme o banimento de ${name}.\n\nEscopo: ${scope}\nMotivo: ${reason}\n\nUse: !banir confirmar`);
  }

  async function desbanir(client, msg, args, context = {}) {
    const confirmationKey = key(msg, context);
    if (String(args[0] || "").toLowerCase() === "confirmar") {
      const pending = confirmations.get(confirmationKey);
      if (!pending || pending.type !== "revoke" || pending.expiresAt < Date.now()) return msg.reply("❌ Não há liberação pendente para confirmar.");
      confirmations.delete(confirmationKey);
      await discipline.revoke(pending);
      return msg.reply("✅ Liberação registrada. O histórico disciplinar foi preservado.");
    }
    const target = await resolveTarget(msg, args);
    const mode = args.includes("ultimo") || args.includes("último") ? "last" : args.includes("manter") ? "keep" : "reset";
    const platform = args.includes("telegram") ? "telegram" : args.includes("ambos") ? "both" : "whatsapp";
    const name = await display(target.identity, msg);
    confirmations.set(confirmationKey, {
      type: "revoke", identity: target.identity, administrator: context.role?.identity || msg.author,
      platforms: platform, mode, expiresAt: Date.now() + 5 * 60 * 1000
    });
    return msg.reply(`⚠️ Confirme a liberação de ${name}.\n\nUse: !desbanir confirmar`);
  }

  async function historico(client, msg, args) {
    const target = await resolveTarget(msg, args);
    const status = await discipline.getMemberStatus(target.identity);
    if (!status.bans?.length) return msg.reply("✅ Nenhum histórico disciplinar localizado.");
    const lines = status.bans.map((ban, index) =>
      `${index + 1}. ${ban.scope} • ${ban.platform} • ${ban.status}\nMotivo: ${ban.reason}`
    );
    return msg.reply(`📚 HISTÓRICO DISCIPLINAR\n\n${lines.join("\n\n")}`);
  }

  async function status(client, msg, args) {
    const target = await resolveTarget(msg, args);
    const value = await discipline.getMemberStatus(target.identity);
    return msg.reply([
      "📋 STATUS DO MEMBRO", "",
      `Banimentos ativos: ${value.activeBanCount}`,
      `Bloqueio comunitário: ${value.communityBan ? "Sim" : "Não"}`,
      `WhatsApp: ${value.platformBlocks?.whatsapp ? "Bloqueado" : "Liberado"}`,
      `Telegram: ${value.platformBlocks?.telegram ? "Bloqueado" : "Liberado"}`
    ].join("\n"));
  }

  return [
    { name: "banir", aliases: [], groupOnly: true, adminOnly: true, execute: banir },
    { name: "desbanir", aliases: ["desbanir membro", "liberar membro"], adminOnly: true, execute: desbanir },
    { name: "historico ban", aliases: ["historicoban"], adminOnly: true, execute: historico },
    { name: "status membro", aliases: ["statusmembro"], adminOnly: true, execute: status }
  ];
}

module.exports = createDisciplineCommands();
module.exports.createDisciplineCommands = createDisciplineCommands;
