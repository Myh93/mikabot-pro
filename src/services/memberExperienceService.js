"use strict";

const fs = require("node:fs");
const path = require("node:path");
const experienceDefault = require("../repositories/memberExperienceRepository");
const registrationsDefault = require("./registrationService");
const flowsDefault = require("./guidedFlowService");
const journeyDefault = require("./memberJourneyService");
const identityDefault = require("./identityService");
const mediaLibraryDefault = require("./memberMediaLibraryService");
const moderationRepositoryDefault = require("../repositories/moderationRepository");
const disciplineDefault = require("./disciplineService");

const WEEK_MS = 7 * 86400000;
const SUPPORTED_IMAGE = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const SUPPORTED_STICKER = new Set([".webp", ".png", ".jpg", ".jpeg"]);
const timers = new Map();
const pendingBanLeaves = new Map();

const WELCOME_FIRST = "🎉 Bem-vindo, @Treinador!\n\nSeu cadastro foi concluído e sua entrada foi aprovada.\n\nBoa jornada na comunidade! ✨";
const WELCOME_RETURN = "🎉 Bem-vindo de volta, @Treinador!\n\nQue bom ter você novamente com a gente.\n\n✅ Seu cadastro e progresso foram preservados.";
const WELCOME_AFTER_BAN = "🎉 Bem-vindo de volta, @Treinador!\n\nVocê foi readicionado pela administração.\n\n✅ Seu cadastro e progresso foram preservados.\n\n⚠️ Evite novas infrações e siga as regras da comunidade.";
const WELCOME_AFTER_REMOVAL = "🎉 Bem-vindo de volta, @Treinador!\n\nVocê foi readicionado à comunidade.\n\n✅ Seu cadastro e progresso foram preservados.";
const FAREWELL_LEAVE = "👋 @Treinador deixou nossa comunidade.\n\nEsperamos te ver novamente em breve.";
const FAREWELL_REMOVED = "👋 @Treinador não faz mais parte da comunidade.\n\nEsperamos que esteja tudo bem.";
const BAN_MESSAGE = "🚫 MEMBRO BANIDO\n\n@Treinador foi removido da comunidade por descumprimento das regras.\n\nMotivo: {motivo}\nDuração: {duracao}\n\nConsulte:\n!regras";
const REMINDER = "━━━━━━━━━━━━━━━━━━━━━━\n👋 OLÁ, TREINADOR!\n━━━━━━━━━━━━━━━━━━━━━━\n\nVocê já faz parte da nossa comunidade Pokémon GO, mas ainda não possui cadastro no MikaBot.\n\nO cadastro é gratuito, leva cerca de 2 minutos e libera os recursos da comunidade.\n\nCom o cadastro você poderá:\n\n⚔️ Participar das Raids\n🧠 Jogar o Quiz Pokémon\n🏆 Ganhar XP e subir de nível\n🥇 Entrar nos Rankings\n🎖️ Desbloquear Conquistas\n📅 Participar dos Eventos\n👤 Criar seu Perfil de Treinador\n\n━━━━━━━━━━━━━━\n🎁 BÔNUS DE CADASTRO\n━━━━━━━━━━━━━━\n\n⭐ +100 XP interno do MikaBot\n🏅 Conquista: Primeiro Passo\n\nPara começar, responda:\n\ncadastro\n\nEsta é uma mensagem oficial da comunidade Pokémon GO enviada pelo MikaBot.\n\nSe já concluiu o cadastro, ignore esta mensagem.\n\n🤖 MikaBot PRO\n━━━━━━━━━━━━━━━━━━━━━━";
const REGISTRATION_REQUIRED = "❌ Você ainda não possui cadastro no MikaBot.\n\nO cadastro libera Raids, Quiz, Eventos, Perfil, XP e Rankings.\n\nEnvie no privado:\n\ncadastro\n\n🎁 No primeiro cadastro você recebe +100 XP interno e a conquista Primeiro Passo.";
const REGISTRATION_COMPLETED = "━━━━━━━━━━━━━━━━━━━━━━\n🎉 CADASTRO CONCLUÍDO!\n━━━━━━━━━━━━━━━━━━━━━━\n\nSeu cadastro foi salvo com sucesso.\n\n🏅 Conquista desbloqueada:\nPrimeiro Passo\n\n⭐ Bônus recebido:\n+100 XP interno do MikaBot\n\nAgora você pode:\n\n⚔️ Participar das Raids\n🧠 Jogar o Quiz\n🏆 Subir no Ranking\n📅 Participar dos Eventos\n👤 Usar seu Perfil\n\nBoa jornada!\n\n🤖 MikaBot PRO\n━━━━━━━━━━━━━━━━━━━━━━";

function createMemberExperienceService(options = {}) {
  const repository = options.repository || experienceDefault;
  const registrations = options.registrationService || registrationsDefault;
  const flows = options.guidedFlowService || flowsDefault;
  const journey = options.memberJourneyService || journeyDefault;
  const identities = options.identityService || identityDefault;
  const mediaLibrary = options.memberMediaLibraryService || mediaLibraryDefault;
  const moderationRepository = options.moderationRepository || moderationRepositoryDefault;
  const discipline = options.disciplineService || disciplineDefault;
  const clock = options.clock || (() => new Date());
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const mediaFactory = options.mediaFactory || (file => require("whatsapp-web.js").MessageMedia.fromFilePath(file));
  const log = options.log || (value => console.log(`[MEMBER_EXPERIENCE] ${value}`));

  const serialize = value => typeof value === "string" ? value : value?._serialized || value?.id?._serialized || "";
  const normalize = value => identities.normalizeUserId(value);
  const validMedia = (file, sticker = false) => typeof file === "string" && path.isAbsolute(file) && fs.existsSync(file) && (sticker ? SUPPORTED_STICKER : SUPPORTED_IMAGE).has(path.extname(file).toLowerCase());

  function safePublicName(value) {
    const validated = typeof identities.validPublicName === "function" ? identities.validPublicName(value) : String(value || "").trim();
    if (!validated || validated === "Treinador" || validated === "Participante" || validated === "@Treinador") return null;
    if (/@(?:lid|c\.us|g\.us|s\.whatsapp\.net)/i.test(validated) || /^\+?\d[\d\s().-]{7,}$/.test(validated)) return null;
    return validated.replace(/^@+/, "").trim() || null;
  }

  async function resolveMemberPresentation(client, memberId, source = null) {
    let contact = source && typeof source === "object" ? source : null;
    if (!contact && typeof client?.getContactById === "function") {
      try { contact = await client.getContactById(memberId); } catch (_) { contact = null; }
    }
    const contactName = safePublicName(contact?.pushname || contact?.name || contact?.shortName || contact?.verifiedName);
    let resolvedName = contactName;
    if (!resolvedName && typeof identities.resolveDisplayName === "function") {
      try {
        resolvedName = safePublicName(await identities.resolveDisplayName({ id: memberId, candidates: identities.collectCanonicalIdentityCandidates(memberId) }, { contact, registrationService: registrations }));
      } catch (_) { resolvedName = null; }
    }
    const name = resolvedName || "Um membro";
    return { name, canMention: Boolean(resolvedName && memberId), mentionTarget: contact || memberId };
  }

  function renderMemberText(text, presentation, mention) {
    const visibleName = mention && presentation.canMention ? `@${presentation.name}` : presentation.name;
    return String(text || "")
      .replace(/@Treinador(?![\p{L}\p{N}_])/gu, visibleName)
      .replace(/\bTreinador\b(?![\p{L}\p{N}_])/gu, presentation.name);
  }

  async function hasActiveBan(groupId, memberId) {
    try {
      if (typeof moderationRepository?.getActiveBan === "function" && await moderationRepository.getActiveBan(groupId, memberId)) return true;
    } catch (_) { /* a experiência não altera a disciplina */ }
    try {
      if (typeof discipline?.isBlocked === "function") {
        const result = await discipline.isBlocked({ platform: "whatsapp", groupId, identity: { id: memberId, candidates: identities.collectCanonicalIdentityCandidates(memberId) } });
        if (result?.blocked) return true;
      }
    } catch (_) { /* a experiência não altera a disciplina */ }
    return false;
  }

  function classifyJoin(previous, groupId, activeBan) {
    const group = previous?.groups?.[groupId] || null;
    if (activeBan) return "ban_active";
    if (!group?.joinCount) return "first_entry";
    if (group.lastExitReason === "ban") return "return_after_ban";
    if (group.lastExitReason === "admin_removed") return "return_after_removal";
    return "return_voluntary";
  }

  function welcomeFor(state, config) {
    if (state === "return_after_ban") return config.welcome.afterBanText || WELCOME_AFTER_BAN;
    if (state === "return_after_removal") return config.welcome.afterRemovalText || WELCOME_AFTER_REMOVAL;
    if (state === "return_voluntary") return config.welcome.returnText || WELCOME_RETURN;
    return config.welcome.firstText || WELCOME_FIRST;
  }

  async function deleteTemporary(record, message = null) {
    try {
      const target = message || (record.client?.getMessageById ? await record.client.getMessageById(record.messageId) : null);
      if (!target || target.fromMe === false || typeof target.delete !== "function") throw new Error("message_unavailable");
      await target.delete(true);
      await repository.removeTemporaryMessage(record.key);
      log("temporaryMessageDeleted=true");
      return true;
    } catch (_) { log("temporaryMessageDeleteFailed=true"); return false; }
  }

  async function scheduleTemporary(message, groupId, delay, client) {
    if (!delay || !message || message.fromMe === false || typeof message.delete !== "function") return false;
    const messageId = message.id?._serialized || (typeof message.id?.toString === "function" ? message.id.toString() : null);
    if (!messageId) return false;
    const key = `${groupId}:${messageId}`;
    if (timers.has(key)) return false;
    const deleteAt = new Date(clock().getTime() + delay).toISOString();
    await repository.saveTemporaryMessage({ key, groupId, messageId, deleteAt });
    const timer = setTimeoutFn(async () => { timers.delete(key); await deleteTemporary({ key, messageId, client }, message); }, delay);
    timer?.unref?.(); timers.set(key, timer); return true;
  }

  async function resume(client) {
    for (const record of await repository.listTemporaryMessages()) {
      if (timers.has(record.key)) continue;
      const delay = Math.max(0, Date.parse(record.deleteAt) - clock().getTime());
      const timer = setTimeoutFn(async () => { timers.delete(record.key); await deleteTemporary({ ...record, client }); }, delay);
      timer?.unref?.(); timers.set(record.key, timer);
    }
    return timers.size;
  }

  async function sendMedia(client, groupId, file, sticker, deleteAfterMs) {
    if (!validMedia(file, sticker)) return false;
    try {
      const sent = await client.sendMessage(groupId, mediaFactory(file), sticker ? { sendMediaAsSticker: true } : {});
      await scheduleTemporary(sent, groupId, deleteAfterMs, client);
      return true;
    } catch (_) { return false; }
  }

  async function sendLibraryItem(client, groupId, item, deleteAfterMs) {
    if (!item) return false;
    try {
      const sendOptions = item.mediaType === "sticker" ? { sendMediaAsSticker: true } : item.mediaType === "gif" && item.mimeType === "video/mp4" ? { sendVideoAsGif: true } : {};
      const sent = await client.sendMessage(groupId, mediaFactory(item.internalPath), sendOptions);
      await mediaLibrary.markUsed(groupId, item); await scheduleTemporary(sent, groupId, deleteAfterMs, client); return true;
    } catch (_) { log("mediaSendFailed=true"); return false; }
  }

  async function previewMedia(client, userId, category) {
    if (!client || typeof client.sendMessage !== "function" || !userId) return { sent: false, errorCode: "invalid_context" };
    const item = await mediaLibrary.selectPreview(category);
    if (!item) {
      await client.sendMessage(userId, "ℹ️ Nenhuma mídia ativa disponível nesta categoria.");
      return { sent: false, empty: true };
    }
    const categoryLabels = { welcome: "Boas-vindas", return: "Retorno", farewell: "Despedida", removal: "Remoção", ban: "Banimento" };
    const header = ["🧪 PRÉ-VISUALIZAÇÃO", "", `Categoria: ${categoryLabels[category] || category}`, "", "Esta é apenas uma demonstração.", "Nenhuma ação real foi executada."].join("\n");
    try {
      await client.sendMessage(userId, header);
      const sendOptions = item.mediaType === "sticker"
        ? { sendMediaAsSticker: true }
        : item.mediaType === "gif" && item.mimeType === "video/mp4" ? { sendVideoAsGif: true } : {};
      await client.sendMessage(userId, mediaFactory(item.internalPath), sendOptions);
      return { sent: true, mediaType: item.mediaType };
    } catch (_) {
      log("mediaPreviewFailed=true");
      return { sent: false, errorCode: "preview_send_failed" };
    }
  }

  async function sendEventMedia(client, groupId, category, config) {
    let visualSent = false; let stickerSent = false;
    const failedVisuals = [];
    for (let attempt = 0; attempt < 4 && !visualSent; attempt += 1) {
      try {
        const item = await mediaLibrary.selectVisual(groupId, category, { fetchExternal: false, excludeMediaIds: failedVisuals });
        if (!item) break;
        if (failedVisuals.includes(item.mediaId)) break;
        visualSent = await sendLibraryItem(client, groupId, item, config.deleteAfterMs);
        if (!visualSent) failedVisuals.push(item.mediaId);
      } catch (_) { log("mediaSendFailed=true"); break; }
    }
    if (!visualSent && config.imageEnabled) visualSent = await sendMedia(client, groupId, config.imagePath, false, config.deleteAfterMs);
    const failedStickers = [];
    for (let attempt = 0; attempt < 4 && !stickerSent; attempt += 1) {
      try {
        const item = await mediaLibrary.selectMedia(groupId, category, "sticker", { fetchExternal: false, excludeMediaIds: failedStickers });
        if (!item) break;
        if (failedStickers.includes(item.mediaId)) break;
        stickerSent = await sendLibraryItem(client, groupId, item, config.deleteAfterMs);
        if (!stickerSent) failedStickers.push(item.mediaId);
      } catch (_) { log("mediaSendFailed=true"); break; }
    }
    if (!stickerSent && config.stickerEnabled) stickerSent = await sendMedia(client, groupId, config.stickerPath, true, config.deleteAfterMs);
    return { visualSent, stickerSent };
  }

  async function sendText(client, groupId, text, memberId, mention, deleteAfterMs, presentation = null) {
    if (!text) return false;
    try {
      const member = presentation || (memberId ? await resolveMemberPresentation(client, memberId) : { name: "Um membro", canMention: false, mentionTarget: null });
      const rendered = renderMemberText(text, member, mention);
      const sent = await client.sendMessage(groupId, rendered, mention && member.canMention ? { mentions: [member.mentionTarget] } : {});
      await scheduleTemporary(sent, groupId, deleteAfterMs, client);
      return true;
    } catch (_) { return false; }
  }

  async function handleJoin(client, notification) {
    const groupId = String(notification?.chatId || "");
    const config = await repository.getGroupConfig(groupId);
    if (!config.welcome.enabled) return [];
    const results = [];
    for (const raw of notification?.recipientIds || []) {
      const memberId = normalize(serialize(raw)); if (!memberId) continue;
      const presentation = await resolveMemberPresentation(client, memberId, raw);
      const previous = await repository.getMember(memberId);
      const registration = await registrations.getRegistrationByIdentity({ id: memberId, candidates: identities.collectCanonicalIdentityCandidates(memberId) });
      const state = classifyJoin(previous, groupId, await hasActiveBan(groupId, memberId));
      if (state === "ban_active") { log("welcomeSkipped=active_ban"); results.push({ memberId, state, returning: false, blocked: true }); continue; }
      const joinedAt = clock().toISOString();
      await repository.updateMember(memberId, item => {
        item.joinCount = Number(item.joinCount || 0) + 1; item.lastJoinAt = joinedAt;
        item.groups ||= {}; const group = item.groups[groupId] || { joinCount: 0 };
        group.joinCount = Number(group.joinCount || 0) + 1; group.lastJoinAt = joinedAt; group.active = true;
        item.groups[groupId] = group;
        if (registration) item.registeredAt ||= registration.createdAt || joinedAt;
      });
      await sendEventMedia(client, groupId, state === "first_entry" ? "welcome" : "return", config.welcome);
      if (config.welcome.textEnabled) await sendText(client, groupId, welcomeFor(state, config), memberId, config.welcome.mention, config.welcome.deleteAfterMs, presentation);
      if (registration) await journey.grant(memberId, "official_trainer", { platform: "whatsapp", groupId });
      log("welcomeSent=true"); results.push({ memberId, state, returning: state !== "first_entry" });
    }
    return results;
  }

  async function handleLeave(client, notification) {
    const groupId = String(notification?.chatId || "");
    const config = await repository.getGroupConfig(groupId);
    const results = [];
    for (const raw of notification?.recipientIds || []) {
      const memberId = normalize(serialize(raw)); if (!memberId) continue;
      const presentation = await resolveMemberPresentation(client, memberId, raw);
      const removed = notification?.type === "remove";
      const receiptKey = `${groupId}:${memberId}`;
      const banLeave = removed && pendingBanLeaves.delete(receiptKey);
      const leftAt = clock().toISOString();
      await repository.updateMember(memberId, item => {
        item.groups ||= {}; const group = item.groups[groupId] || { joinCount: 0 };
        group.active = false; group.lastLeaveAt = leftAt;
        group.lastExitReason = banLeave ? "ban" : removed ? "admin_removed" : "voluntary_leave";
        item.groups[groupId] = group;
      });
      if (banLeave) { log("banDuplicatePrevented=true"); results.push({ memberId, removed, reason: "ban" }); continue; }
      if (config.farewell.enabled) {
        await sendEventMedia(client, groupId, removed ? "removal" : "farewell", config.farewell);
        if (config.farewell.textEnabled) await sendText(client, groupId, removed ? config.farewell.removedText || FAREWELL_REMOVED : config.farewell.leaveText || FAREWELL_LEAVE, memberId, config.farewell.mention, config.farewell.deleteAfterMs, presentation);
      }
      log("farewellSent=true"); results.push({ memberId, removed });
    }
    return results;
  }

  async function disableReminders(memberId) {
    const normalized = normalize(memberId); if (!normalized) return false;
    await repository.updateMember(normalized, item => { item.reminderDisabled = true; });
    return true;
  }

  async function handleIncomingMessage(context, text) {
    if (!context?.userId) return { status: "ignored" };
    const normalizedText = String(text || "").trim().toLocaleLowerCase("pt-BR");
    if (!context.isGroup && (normalizedText === "parar" || normalizedText === "!pararlembretes")) {
      await disableReminders(context.userId);
      await context.replyText("✅ Você não receberá novos lembretes de cadastro.");
      return { status: "disabled" };
    }
    if (!context.isGroup) return { status: "ignored" };
    if (await registrations.getRegistrationByIdentity(context.identity || { id: context.userId })) {
      await repository.updateMember(context.userId, item => { item.registeredAt ||= clock().toISOString(); item.reminderDisabled = true; });
      return { status: "registered" };
    }
    const member = await repository.getMember(context.userId);
    if (member?.reminderDisabled) { log("reminderSkipped=true"); return { status: "disabled" }; }
    if (member?.lastReminderAttemptAt && clock().getTime() - Date.parse(member.lastReminderAttemptAt) < WEEK_MS) { log("reminderSkipped=true"); return { status: "cooldown" }; }
    if (await flows.hasActiveFlowForUser(context.userId)) { log("reminderSkipped=true"); return { status: "guided_flow" }; }
    await repository.updateMember(context.userId, item => { item.lastReminderAttemptAt = clock().toISOString(); });
    try {
      await context.sendPrivate(context.userId, REMINDER);
      await repository.updateMember(context.userId, item => { item.lastReminderAt = clock().toISOString(); item.reminderCount = Number(item.reminderCount || 0) + 1; });
      log("reminderSent=true"); return { status: "sent" };
    } catch (_) { log("reminderSkipped=true"); return { status: "send_failed" }; }
  }

  async function registrationCompleted(context, registration, created) {
    await repository.updateMember(context.userId, item => { item.registeredAt ||= clock().toISOString(); item.reminderDisabled = true; });
    const reward = created ? await journey.grant(context.userId, "registration_completion", { platform: context.platform || "whatsapp", groupId: context.sourceGroupId || null }) : { granted: false };
    return { reward, text: reward.granted ? REGISTRATION_COMPLETED : "✅ Cadastro atualizado/concluído com sucesso." };
  }

  async function testMedia(client, groupId, category) {
    const config = category === "welcome" || category === "return" ? (await repository.getGroupConfig(groupId)).welcome : (await repository.getGroupConfig(groupId)).farewell;
    return sendEventMedia(client, groupId, category, config);
  }

  function renderBanText(config, input = {}) {
    const presentation = input.presentation || { name: safePublicName(input.displayName) || "Um membro", canMention: Boolean(safePublicName(input.displayName)), mentionTarget: null };
    let text = renderMemberText(config.text || BAN_MESSAGE, presentation, config.mention);
    const reason = String(input.reason || "Descumprimento das regras").trim();
    const duration = input.duration === "permanent" ? "Permanente" : String(input.duration || "").trim();
    text = config.showReason ? text.replace("{motivo}", reason) : text.replace(/^.*\{motivo\}.*(?:\r?\n)?/m, "");
    text = config.showDuration && duration ? text.replace("{duracao}", duration) : text.replace(/^.*\{duracao\}.*(?:\r?\n)?/m, "");
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }

  async function announceBan(client, input = {}) {
    const groupId = String(input.groupId || ""), memberId = normalize(input.memberId);
    if (!groupId || !memberId) return { sent: false, errorCode: "invalid_context" };
    const config = (await repository.getGroupConfig(groupId)).ban;
    if (!config.enabled) return { sent: false, disabled: true };
    const presentation = await resolveMemberPresentation(client, memberId, input.contact);
    let mediaSent = false;
    if (config.mediaEnabled) {
      const failed = [];
      for (let attempt = 0; attempt < 2 && !mediaSent; attempt += 1) {
        const item = await mediaLibrary.selectVisual(groupId, "ban", { fetchExternal: false, excludeMediaIds: failed });
        if (!item || failed.includes(item.mediaId)) break;
        mediaSent = await sendLibraryItem(client, groupId, item, config.deleteAfterMs);
        if (!mediaSent) failed.push(item.mediaId);
      }
      if (!mediaSent) {
        const sticker = await mediaLibrary.selectMedia(groupId, "ban", "sticker", { fetchExternal: false });
        mediaSent = await sendLibraryItem(client, groupId, sticker, config.deleteAfterMs);
      }
    }
    const textSent = config.textEnabled ? await sendText(client, groupId, renderBanText(config, { ...input, presentation }), memberId, config.mention, config.deleteAfterMs, presentation) : false;
    await repository.updateMember(memberId, item => {
      item.groups ||= {}; const group = item.groups[groupId] || { joinCount: 0 };
      group.active = false; group.lastLeaveAt = clock().toISOString(); group.lastExitReason = "ban";
      item.groups[groupId] = group;
    });
    pendingBanLeaves.set(`${groupId}:${memberId}`, true);
    log("banAnnouncementSent=true");
    return { sent: mediaSent || textSent, mediaSent, textSent };
  }

  async function testBan(client, groupId) {
    const config = (await repository.getGroupConfig(groupId)).ban;
    let mediaSent = false;
    if (config.mediaEnabled) mediaSent = await sendLibraryItem(client, groupId, await mediaLibrary.selectVisual(groupId, "ban", { fetchExternal: false }), config.deleteAfterMs)
      || await sendLibraryItem(client, groupId, await mediaLibrary.selectMedia(groupId, "ban", "sticker", { fetchExternal: false }), config.deleteAfterMs);
    const textSent = await sendText(client, groupId, "🧪 Teste da mensagem de banimento.", null, false, config.deleteAfterMs);
    return { mediaSent, textSent };
  }

  return { handleJoin, handleLeave, handleIncomingMessage, disableReminders, registrationCompleted, registrationRequiredMessage: () => REGISTRATION_REQUIRED, testMedia, previewMedia, announceBan, testBan, renderBanText, resolveMemberPresentation, renderMemberText, classifyJoin, hasActiveBan, scheduleTemporary, resume, validMedia, constants: { WELCOME_FIRST, WELCOME_RETURN, WELCOME_AFTER_BAN, WELCOME_AFTER_REMOVAL, FAREWELL_LEAVE, FAREWELL_REMOVED, BAN_MESSAGE, REMINDER, REGISTRATION_REQUIRED, REGISTRATION_COMPLETED } };
}

const service = createMemberExperienceService();
module.exports = { ...service, createMemberExperienceService, WEEK_MS };
