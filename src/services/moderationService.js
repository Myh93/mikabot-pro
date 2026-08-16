"use strict";

const crypto = require("crypto");
const repositoryDefault = require("../repositories/moderationRepository");
const identityServiceDefault = require("./identityService");
const inputResolverDefault = require("./inputResolverService");
const messageStyleDefault = require("./messageStyleService");
const disciplineServiceDefault = require("./disciplineService");
const configurationServiceDefault = require("./configurationService");
const { ensureMessageIdSerialized } = require("./whatsappClientHealthService");

const LINK_STATUSES = new Set(["pending", "approved", "rejected", "cancelled", "expired", "published"]);
const STATUS_TRANSITIONS = Object.freeze({
  pending: new Set(["approved", "rejected", "cancelled", "expired"]),
  approved: new Set(["published", "cancelled", "expired"]),
  rejected: new Set(), cancelled: new Set(), expired: new Set(), published: new Set()
});
const clone = value => JSON.parse(JSON.stringify(value));

function createModerationService(options = {}) {
  const repository = options.repository || repositoryDefault;
  const identities = options.identityService || identityServiceDefault;
  const inputResolver = options.inputResolverService || inputResolverDefault;
  const messageStyle = options.messageStyleService || messageStyleDefault;
  const disciplineService = options.disciplineService ||
    (repository === repositoryDefault ? disciplineServiceDefault : null);
  const configurationService = Object.prototype.hasOwnProperty.call(
    options,
    "configurationService"
  ) ? options.configurationService : configurationServiceDefault;
  const clock = options.clock || (() => new Date());
  const nowIso = () => clock().toISOString();
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const internalId = value => identities.normalizeUserId(value) || clean(value);
  const pendingWarningRemovals = new Map();
  const warningRemovalKey = (groupId, targetId) => `${internalId(groupId)}::${internalId(targetId)}`;

  const getDefaultGroupConfig = () => clone(repository.getDefaultGroupConfig());
  function normalizeGroupConfig(value = {}) {
    const defaults = getDefaultGroupConfig();
    const merge = (base, patch) => Object.fromEntries(new Set([...Object.keys(base || {}), ...Object.keys(patch || {})]).values().map(key => {
      const left = base?.[key], right = patch?.[key];
      return [key, right && typeof right === "object" && !Array.isArray(right) && left && typeof left === "object" && !Array.isArray(left) ? merge(left, right) : right === undefined ? clone(left) : clone(right)];
    }));
    const result = merge(defaults, value);
    result.enabled = Boolean(result.enabled);
    result.settings.warnings.enabled = Boolean(result.settings.warnings.enabled);
    result.settings.warnings.limit = Number.isInteger(Number(result.settings.warnings.limit)) && Number(result.settings.warnings.limit) >= 1 ? Number(result.settings.warnings.limit) : 3;
    for (const field of ["enabled", "deleteMessage", "warnUser", "adminsBypass", "requireApproval"]) result.settings.antiLink[field] = Boolean(result.settings.antiLink[field]);
    result.settings.ban = result.settings.ban || { enabled: false, blockReentry: true };
    result.settings.ban.enabled = Boolean(result.settings.ban.enabled);
    result.settings.ban.blockReentry = result.settings.ban.blockReentry !== false;
    result.settings.approval = result.settings.approval || {};
    result.settings.approval.enabled = Boolean(result.settings.approval.enabled);
    result.settings.approval.allowModeratorReview = Boolean(result.settings.approval.allowModeratorReview);
    result.settings.approval.requestExpiresDays = Number.isInteger(Number(result.settings.approval.requestExpiresDays)) && Number(result.settings.approval.requestExpiresDays) >= 1 ? Number(result.settings.approval.requestExpiresDays) : 7;
    result.settings.approval.notifyAdminsPrivately = result.settings.approval.notifyAdminsPrivately !== false;
    result.settings.approval.publishByBotOnly = result.settings.approval.publishByBotOnly !== false;
    result.settings.antiFlood.enabled = Boolean(result.settings.antiFlood.enabled);
    result.settings.antiSpam.enabled = Boolean(result.settings.antiSpam.enabled);
    return result;
  }
  const getGroupConfig = groupId => repository.getGroupConfig(internalId(groupId));
  async function updateGroupConfig(groupId, patch) { return repository.updateGroupConfig(internalId(groupId), patch); }
  async function isModerationEnabled(groupId) { return Boolean((await getGroupConfig(groupId))?.enabled); }

  function validWarningsLimit(value) {
    return typeof value === "number" &&
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value > 0;
  }

  function resolveWarningsLimit(context = {}, persistedLimit) {
    try {
      const resolved = configurationService?.getResolved?.(
        "moderation.warnings.limit",
        context
      );
      if (
        resolved?.source !== "default" &&
        validWarningsLimit(resolved?.value)
      ) {
        return resolved.value;
      }
    } catch (_) {
      // A configuração persistida da Moderação permanece como fallback seguro.
    }

    return validWarningsLimit(persistedLimit) ? persistedLimit : 3;
  }

  function safeMetadata(value, depth = 0) {
    if (depth > 4 || value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return value.slice(0, 500);
    if (Array.isArray(value)) return value.slice(0, 30).map(item => safeMetadata(item, depth + 1)).filter(item => item !== undefined);
    if (typeof value === "object") {
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (/token|password|secret|authorization|cookie|credential|messagebody|body|query/i.test(key)) continue;
        const safe = safeMetadata(item, depth + 1); if (safe !== undefined) result[key] = safe;
      }
      return result;
    }
    return undefined;
  }

  function normalizeDomain(value) {
    let domain = clean(value).toLowerCase();
    if (!domain) throw new Error("Domínio vazio.");
    if (/^[a-z][a-z0-9+.-]*:/i.test(domain) && !/^https?:/i.test(domain)) throw new Error("Protocolo não permitido.");
    if (/^https?:\/\//i.test(domain)) domain = extractEffectiveDomain(domain);
    domain = domain.replace(/^www\./, "").replace(/\.+$/, "");
    if (!domain || domain.length > 253 || domain.includes("/") || domain.includes("@") || !/^[a-z0-9.-]+$/.test(domain) || domain.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) throw new Error("Domínio inválido.");
    return domain;
  }

  function parseSafeUrl(value) {
    const raw = clean(value); if (!raw) throw new Error("URL vazia.");
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:/i.test(raw)) throw new Error("Protocolo não permitido.");
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw new Error("URL inválida.");
    return url;
  }
  function extractEffectiveDomain(value) { return normalizeDomain(parseSafeUrl(value).hostname); }
  function sanitizeUrl(value) {
    const url = parseSafeUrl(value), domain = extractEffectiveDomain(value);
    const pathname = url.pathname.replace(/\/+/g, "/").slice(0, 500) || "/";
    const sanitizedUrl = `${url.protocol}//${domain}${pathname}`;
    return { domain, sanitizedUrl, urlHash: crypto.createHash("sha256").update(`${url.protocol}//${domain}${pathname}`).digest("hex") };
  }
  const belongsTo = (domain, base) => domain === base || domain.endsWith(`.${base}`);
  function classifyLink(value) {
    const domain = extractEffectiveDomain(value);
    const groups = [
      ["whatsapp", ["whatsapp.com", "wa.me"]], ["telegram", ["t.me", "telegram.me", "telegram.org"]],
      ["discord", ["discord.com", "discord.gg"]], ["youtube", ["youtube.com", "youtu.be"]],
      ["pokemon_go", ["pokemongolive.com", "pokemon.com"]], ["campfire", ["campfire.nianticlabs.com", "nianticcampfire.com"]],
      ["google_drive", ["drive.google.com", "docs.google.com"]], ["shortened", ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "cutt.ly"]]
    ];
    return groups.find(([, domains]) => domains.some(base => belongsTo(domain, base)))?.[0] || "other";
  }

  function createModerationHistoryEntry(input = {}) {
    const sanitized = input.url ? sanitizeUrl(input.url) : null;
    return {
      groupId: internalId(input.groupId), userId: internalId(input.userId), actorId: internalId(input.actorId),
      action: clean(input.action || "foundation_test"), reason: clean(input.reason).slice(0, 300),
      domain: sanitized?.domain || (input.domain ? normalizeDomain(input.domain) : ""), result: clean(input.result || "recorded"),
      metadata: safeMetadata({ ...(input.metadata || {}), ...(sanitized ? { sanitizedUrl: sanitized.sanitizedUrl, urlHash: sanitized.urlHash } : {}) }), createdAt: input.createdAt || nowIso()
    };
  }
  const registerHistory = input => repository.appendHistory(createModerationHistoryEntry(input));

  function domainCandidates(domain) { const labels = normalizeDomain(domain).split("."); return labels.map((_, index) => labels.slice(index).join(".")).filter(item => item.includes(".")); }
  async function isDomainWhitelisted(domain, groupId = null) { for (const candidate of domainCandidates(domain)) if (groupId && await repository.getDomainRule("whitelist", candidate, { scope: "group", groupId: internalId(groupId) }) || await repository.getDomainRule("whitelist", candidate, { scope: "global" })) return true; return false; }
  async function isDomainBlacklisted(domain, groupId = null) { for (const candidate of domainCandidates(domain)) if (groupId && await repository.getDomainRule("blacklist", candidate, { scope: "group", groupId: internalId(groupId) }) || await repository.getDomainRule("blacklist", candidate, { scope: "global" })) return true; return false; }

  async function createPendingLinkRequest(input = {}) {
    const sanitized = sanitizeUrl(input.url), linkType = classifyLink(input.url), timestamp = nowIso();
    return repository.createPendingLink({ groupId: internalId(input.groupId), requesterId: internalId(input.requesterId), domain: sanitized.domain, linkType, sanitizedUrl: sanitized.sanitizedUrl, urlHash: sanitized.urlHash, status: "pending", reviewedBy: null, reviewReason: "", createdAt: timestamp, updatedAt: timestamp });
  }
  const getPendingLinkRequest = requestId => repository.getPendingLink(clean(requestId).toUpperCase());
  async function updatePendingLinkStatus(requestId, status, review = {}) {
    const normalized = clean(status).toLowerCase(); if (!LINK_STATUSES.has(normalized)) throw new Error("Status de link inválido.");
    const current = await getPendingLinkRequest(requestId); if (!current) return null;
    if (!STATUS_TRANSITIONS[current.status]?.has(normalized)) throw new Error(`Transição inválida: ${current.status} → ${normalized}.`);
    return repository.updatePendingLink(current.requestId, { status: normalized, reviewedBy: review.reviewedBy ? internalId(review.reviewedBy) : current.reviewedBy, reviewReason: clean(review.reason).slice(0, 300), updatedAt: nowIso() });
  }

  const getWarningCount = async (groupId, userId) => (await repository.getWarningRecords(internalId(groupId), internalId(userId))).filter(item => item.active).length;
  async function addWarning(input = {}) {
    const item = await repository.addWarningRecord({ groupId: internalId(input.groupId), userId: internalId(input.userId), actorId: internalId(input.actorId), source: clean(input.source || "manual"), reason: clean(input.reason).slice(0, 300), active: true, createdAt: nowIso(), clearedAt: null, clearedBy: null });
    await registerHistory({ groupId: item.groupId, userId: item.userId, actorId: item.actorId, action: "warning_created", reason: item.reason, result: "recorded", metadata: { source: item.source } });
    return item;
  }
  async function clearWarnings(groupId, userId, actorId) {
    const normalizedGroup = internalId(groupId), normalizedUser = internalId(userId), normalizedActor = internalId(actorId);
    const cleared = await repository.clearWarningRecords(normalizedGroup, normalizedUser, normalizedActor);
    if (cleared.length) await registerHistory({ groupId: normalizedGroup, userId: normalizedUser, actorId: normalizedActor, action: "warning_reset", result: "recorded", metadata: { clearedCount: cleared.length } });
    return cleared;
  }

  function moderationError(code, message) { const error = new Error(message); error.code = code; return error; }
  function roleRank(role = {}) { if (Number.isFinite(role.rank)) return Number(role.rank); if (role.isOwner) return 4; if (role.isAdmin) return 2; if (role.isModerator) return 1; return 0; }
  const canResetWarnings = role => roleRank(role) >= 1;
  function isProtectedUser({ targetId, actorId, botId, targetParticipant }) {
    if (!targetId) return true;
    if (botId && identities.identitiesMatch(targetId, botId)) return true;
    if (actorId && identities.identitiesMatch(targetId, actorId)) return true;
    return Boolean(targetParticipant?.isAdmin || targetParticipant?.isSuperAdmin);
  }
  function canWarn({ actorRole, actorId, targetId, botId, targetParticipant }) {
    if (roleRank(actorRole) < 1) return { allowed: false, reason: "permission_denied" };
    if (!targetId || !targetParticipant) return { allowed: false, reason: "target_not_in_group" };
    if (botId && identities.identitiesMatch(targetId, botId)) return { allowed: false, reason: "bot_protected" };
    if (identities.identitiesMatch(targetId, actorId)) return { allowed: false, reason: "self_protected" };
    if (targetParticipant.isSuperAdmin) return { allowed: false, reason: "owner_protected" };
    if (targetParticipant.isAdmin) return { allowed: false, reason: "admin_protected" };
    return { allowed: true, reason: null };
  }
  function canViewWarnings({ actorRole, actorId, targetId }) { return identities.identitiesMatch(actorId, targetId) || roleRank(actorRole) >= 1; }
  function sanitizeWarningReason(value) { const reason = clean(value); if (!reason) throw moderationError("REASON_REQUIRED", "O motivo da advertência é obrigatório."); if (reason.length > 300) throw moderationError("REASON_TOO_LONG", "O motivo deve possuir no máximo 300 caracteres."); return reason; }
  const hasReachedLimit = (activeCount, limit) => Number(activeCount) >= Math.max(1, Number(limit) || 3);
  const hasCrossedWarningLimit = (previousActiveCount, activeCount, limit) => !hasReachedLimit(previousActiveCount, limit) && hasReachedLimit(activeCount, limit);

  async function resolveWarningTarget({ msg, chat, actorId, allowSelf = false }) {
    const mentions = [msg?.mentionedIds?.[0], msg?._data?.mentionedJidList?.[0]].filter(Boolean);
    let rawTarget = mentions[0] || null, source = mentions.length ? "mention" : null;
    if (!rawTarget && (msg?.hasQuotedMsg || msg?._data?.quotedMsg) && typeof msg?.getQuotedMessage === "function") {
      if (!ensureMessageIdSerialized(msg).ok) throw moderationError("IDENTITY_UNAVAILABLE", "Não foi possível confirmar a identidade do membro agora.");
      let quoted; try { quoted = await msg.getQuotedMessage(); } catch (_) { throw moderationError("IDENTITY_UNAVAILABLE", "Não foi possível confirmar a identidade do membro agora."); }
      rawTarget = quoted?.author || quoted?.from || null; source = rawTarget ? "reply" : null;
    }
    if (!rawTarget && allowSelf) { rawTarget = actorId; source = "self"; }
    if (!rawTarget) throw moderationError("TARGET_REQUIRED", "Mencione um membro ou responda à mensagem dele.");
    const targetId = internalId(rawTarget); if (!targetId) throw moderationError("TARGET_INVALID", "Não foi possível resolver o membro informado.");
    if (!Array.isArray(chat?.participants)) throw moderationError("PARTICIPANTS_UNAVAILABLE", "Não foi possível confirmar os participantes do grupo agora.");
    const participant = chat.participants.find(item => identities.identitiesMatch(item.id, targetId));
    if (!participant) throw moderationError("TARGET_NOT_IN_GROUP", "O membro informado não pertence a este grupo.");
    return { targetId, participant, source };
  }

  async function warningSettings(groupId) {
    const normalizedGroupId = internalId(groupId);
    const config = normalizeGroupConfig(await getGroupConfig(normalizedGroupId) || {});
    config.settings.warnings.limit = resolveWarningsLimit({
      platform: "whatsapp",
      groupId: normalizedGroupId
    }, config.settings.warnings.limit);
    return config.settings.warnings;
  }
  async function warnPlayer(input = {}) {
    const reason = sanitizeWarningReason(input.reason), permission = canWarn(input);
    if (!permission.allowed) {
      throw moderationError(permission.reason.toUpperCase(), permission.reason === "permission_denied" ? "Você não possui permissão para advertir membros." : "Este membro é protegido e não pode ser advertido.");
    }
    const settings = await warningSettings(input.groupId), receiptKey = input.receiptId ? crypto.createHash("sha256").update(clean(input.receiptId)).digest("hex") : null;
    const timestamp = nowIso(), stored = await repository.addWarningRecordIdempotent({ groupId: internalId(input.groupId), userId: internalId(input.targetId), actorId: internalId(input.actorId), source: "manual", reason, active: true, receipt: receiptKey, createdAt: timestamp, clearedAt: null, clearedBy: null }, receiptKey);
    if (stored.duplicate) return { ...stored, limit: settings.limit, reachedLimit: stored.warning ? hasReachedLimit(await getWarningCount(input.groupId, input.targetId), settings.limit) : false, crossedLimit: false };
    await registerHistory({ groupId: input.groupId, userId: input.targetId, actorId: input.actorId, action: "warning_created", result: "recorded", metadata: { activeCount: stored.activeCount, limit: settings.limit, source: "manual" } });
    const crossedLimit = hasCrossedWarningLimit(stored.previousActiveCount, stored.activeCount, settings.limit);
    if (crossedLimit) await registerHistory({ groupId: input.groupId, userId: input.targetId, actorId: input.actorId, action: "warning_limit_reached", result: settings.finalAction, metadata: { activeCount: stored.activeCount, limit: settings.limit, finalAction: settings.finalAction } });
    return { ...stored, limit: settings.limit, finalAction: settings.finalAction, reachedLimit: hasReachedLimit(stored.activeCount, settings.limit), crossedLimit };
  }
  async function warnPlayerAutomatically(input = {}) {
    const settings = await warningSettings(input.groupId);
    const receiptKey = input.receiptId ? crypto.createHash("sha256").update(clean(input.receiptId)).digest("hex") : null;
    const stored = await repository.addWarningRecordIdempotent({ groupId: internalId(input.groupId), userId: internalId(input.targetId), actorId: internalId(input.actorId), source: "anti_link", reason: "Publicação de link sem autorização", active: true, receipt: receiptKey, metadata: safeMetadata({ domain: input.domain, linkType: input.linkType }), createdAt: nowIso(), clearedAt: null, clearedBy: null }, receiptKey);
    if (stored.duplicate) return { ...stored, limit: settings.limit, crossedLimit: false };
    await registerHistory({ groupId: input.groupId, userId: input.targetId, actorId: input.actorId, action: "warning_created", result: "recorded", metadata: { source: "anti_link", domain: input.domain, linkType: input.linkType, warningCount: stored.activeCount, warningLimit: settings.limit } });
    const crossedLimit = hasCrossedWarningLimit(stored.previousActiveCount, stored.activeCount, settings.limit);
    if (crossedLimit) await registerHistory({ groupId: input.groupId, userId: input.targetId, actorId: input.actorId, action: "warning_limit_reached", result: settings.finalAction, metadata: { warningCount: stored.activeCount, warningLimit: settings.limit, finalAction: settings.finalAction } });
    return { ...stored, limit: settings.limit, crossedLimit };
  }

  const canApplyModerationAction = ({ targetId, botId, targetParticipant, botParticipant }) => Boolean(targetId && targetParticipant && botParticipant?.isAdmin && !isProtectedUser({ targetId, botId, targetParticipant }));
  async function removePlayerFromGroup(input = {}) {
    if (!canApplyModerationAction(input)) return { removed: false, failureCode: "permission_or_protection" };
    if (typeof input.chat?.removeParticipants !== "function") return { removed: false, failureCode: "api_unavailable" };
    try { await input.chat.removeParticipants([input.rawTargetId || input.targetId]); return { removed: true, failureCode: null }; }
    catch (_) { return { removed: false, failureCode: "remove_failed" }; }
  }
  async function banPlayer(input = {}) {
    const receipt = input.receiptId ? crypto.createHash("sha256").update(clean(input.receiptId)).digest("hex") : null;
    const stored = await repository.addBanRecord({ groupId: internalId(input.groupId), userId: internalId(input.targetId), actorId: internalId(input.actorId), source: clean(input.source || "anti_link"), reason: clean(input.reason || "Limite de advertências atingido").slice(0, 300), active: true, createdAt: nowIso(), revokedAt: null, revokedBy: null, metadata: safeMetadata(input.metadata || {}) }, receipt);
    if (!stored.duplicate) await registerHistory({ groupId: input.groupId, userId: input.targetId, actorId: input.actorId, action: "ban_created", result: "recorded", metadata: input.metadata || {} });
    if (!stored.duplicate && disciplineService) await disciplineService.recordBan({
      identity: input.targetId,
      administrator: input.actorId,
      platform: "whatsapp",
      groupId: input.groupId,
      scope: "group",
      reason: input.reason || "Limite de advertências atingido"
    });
    return stored;
  }
  const isPlayerBanned = async (groupId, userId) => Boolean(await repository.getActiveBan(internalId(groupId), internalId(userId)));
  async function listBannedPlayers(input = {}) { const items = await repository.listActiveBans(internalId(input.groupId)); const pageSize = 5, totalPages = Math.max(1, Math.ceil(items.length / pageSize)), page = Math.max(1, Number(input.page) || 1); if (page > totalPages) throw moderationError("INVALID_PAGE", "Esta página não possui banimentos."); return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: items.length, totalPages }; }
  async function unbanPlayer(input = {}) {
    const item = await repository.revokeBan(input.banId, internalId(input.actorId));
    if (item) {
      await registerHistory({ groupId: item.groupId, userId: item.userId, actorId: input.actorId, action: "ban_revoked", result: "recorded" });
      if (disciplineService) await disciplineService.revoke({ identity: item.userId, administrator: input.actorId, platforms: "whatsapp", mode: "last", reason: "moderation_unban" });
    }
    return item;
  }
  async function applyWarningFinalAction(input = {}) {
    const config = normalizeGroupConfig(await getGroupConfig(input.groupId) || {}), finalAction = config.settings.warnings.finalAction;
    if (!config.settings.warnings.enabled) return { action: "none", applied: false };
    const reoffense = Boolean(!input.crossedLimit && finalAction === "ban_and_remove" && Number(input.warningCount) > Number(input.warningLimit) && input.targetParticipant && await isPlayerBanned(input.groupId, input.targetId));
    if (!input.crossedLimit && !reoffense) return { action: "none", applied: false };
    if (finalAction === "notify_admins") return { action: finalAction, applied: true };
    if (finalAction === "ban_and_remove" && !config.settings.ban.enabled) return { action: finalAction, applied: false, failureCode: "ban_disabled" };
    if (!await repository.claimReceipt("finalActions", crypto.createHash("sha256").update(clean(input.receiptId || input.warningId)).digest("hex"), finalAction)) return { action: finalAction, applied: false, duplicate: true };
    if (reoffense) await registerHistory({ groupId: input.groupId, userId: input.targetId, actorId: input.actorId, action: "warning_reentry_reoffense", result: "detected", metadata: { warningCount: input.warningCount, warningLimit: input.warningLimit } });
    if (!canApplyModerationAction(input)) {
      const removal = { removed: false, failureCode: "permission_or_protection" };
      await registerHistory({ groupId: input.groupId, userId: input.targetId, actorId: input.actorId, action: reoffense ? "warning_reoffense_remove_failed" : "member_remove_failed", result: "failed", metadata: { finalAction, failureCode: removal.failureCode } });
      return { action: finalAction, applied: false, reoffense, ...removal };
    }
    const removalKey = warningRemovalKey(input.groupId, input.targetId);
    const pendingRemoval = pendingWarningRemovals.get(removalKey);
    if (pendingRemoval?.participant === input.targetParticipant) {
      return { action: finalAction, applied: false, reoffense, removed: false, removalPending: true, failureCode: "removal_pending" };
    }
    if (pendingRemoval) pendingWarningRemovals.delete(removalKey);
    if (finalAction === "ban_and_remove" && !reoffense) await banPlayer({ ...input, receiptId: input.receiptId, metadata: { warningCount: input.warningCount, warningLimit: input.warningLimit } });
    pendingWarningRemovals.set(removalKey, { participant: input.targetParticipant });
    const removal = await removePlayerFromGroup(input);
    if (!removal.removed) pendingWarningRemovals.delete(removalKey);
    await registerHistory({ groupId: input.groupId, userId: input.targetId, actorId: input.actorId, action: reoffense ? (removal.removed ? "warning_reoffense_removed" : "warning_reoffense_remove_failed") : (removal.removed ? "member_removed" : "member_remove_failed"), result: removal.removed ? "success" : "failed", metadata: { finalAction, failureCode: removal.failureCode } });
    return { action: finalAction, applied: removal.removed, reoffense, ...removal };
  }
  async function handleBannedParticipantJoin(input = {}) {
    const config = normalizeGroupConfig(await getGroupConfig(input.groupId) || {});
    if (!config.settings.ban.enabled || !config.settings.ban.blockReentry || !await isPlayerBanned(input.groupId, input.targetId)) return { blocked: false };
    const result = await removePlayerFromGroup(input);
    await registerHistory({ groupId: input.groupId, userId: input.targetId, actorId: input.actorId, action: result.removed ? "ban_reentry_blocked" : "ban_reentry_block_failed", result: result.removed ? "success" : "failed", metadata: { failureCode: result.failureCode } });
    return { blocked: result.removed, ...result };
  }
  async function listWarnings(input = {}) {
    if (!canViewWarnings(input)) throw moderationError("VIEW_FORBIDDEN", "Você pode consultar apenas as próprias advertências.");
    const active = (await repository.getWarningRecords(internalId(input.groupId), internalId(input.targetId))).filter(item => item.active).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const pageSize = 5, total = active.length, totalPages = Math.max(1, Math.ceil(total / pageSize)), page = Math.max(1, Number(input.page) || 1);
    if (page > totalPages) throw moderationError("INVALID_PAGE", "Esta página não possui advertências.");
    return { items: active.slice((page - 1) * pageSize, page * pageSize), activeCount: total, limit: (await warningSettings(input.groupId)).limit, page, pageSize, totalPages };
  }
  async function resetWarnings(input = {}) {
    if (!canResetWarnings(input.actorRole)) throw moderationError("RESET_FORBIDDEN", "Você não possui permissão para limpar advertências.");
    return clearWarnings(input.groupId, input.targetId, input.actorId);
  }
  function createWarningSummary({ memberName, activeCount, limit, reason, reachedLimit = false, crossedLimit = false, finalAction = "notify_admins", finalResult = null }) {
    const lines = [`👤 Membro: ${clean(memberName) || "Treinador"}`];
    if (reachedLimit) {
      const status = finalResult?.reoffense ? "reincidência acima do limite" : `limite ${crossedLimit ? "atingido" : "já atingido"}`;
      lines.push(`📊 Advertências ativas: ${activeCount}`, `🎯 Limite configurado: ${limit}`, `📌 Status: ${status}`);
    } else {
      lines.push(`📊 Advertências: ${activeCount}/${limit}`);
    }
    lines.push(`📝 Motivo: ${reason}`);
    if (crossedLimit && finalAction === "notify_admins") lines.push("", "⚠️ A moderação foi avisada.");
    if (crossedLimit && finalAction === "remove_member" && finalResult?.removed) lines.push("", "🚫 Membro removido do grupo.");
    if (finalResult?.reoffense && finalResult?.removed) lines.push("", "🚫 Membro banido e removido novamente.");
    if (crossedLimit && finalAction === "ban_and_remove" && finalResult?.removed) lines.push("", "🚫 Membro banido e removido do grupo.");
    if ((crossedLimit || finalResult?.reoffense) && ["remove_member", "ban_and_remove"].includes(finalAction) && !finalResult?.removed) lines.push("", "⚠️ O limite foi atingido, mas não foi possível remover o membro.");
    return messageStyle.section("⚠️ ADVERTÊNCIA REGISTRADA", lines);
  }

  return { getDefaultGroupConfig, normalizeGroupConfig, getGroupConfig, updateGroupConfig, isModerationEnabled, createModerationHistoryEntry, registerHistory, normalizeDomain, extractEffectiveDomain, sanitizeUrl, classifyLink, isDomainWhitelisted, isDomainBlacklisted, createPendingLinkRequest, getPendingLinkRequest, updatePendingLinkStatus, getWarningCount, addWarning, clearWarnings, warnPlayer, warnPlayerAutomatically, listWarnings, resetWarnings, canWarn, canResetWarnings, canViewWarnings, isProtectedUser, hasReachedLimit, createWarningSummary, resolveWarningTarget, sanitizeWarningReason, hasCrossedWarningLimit, banPlayer, unbanPlayer, isPlayerBanned, listBannedPlayers, removePlayerFromGroup, applyWarningFinalAction, canApplyModerationAction, handleBannedParticipantJoin, inputResolver, messageStyle };
}

const service = createModerationService();
module.exports = { ...service, createModerationService, LINK_STATUSES, STATUS_TRANSITIONS };
