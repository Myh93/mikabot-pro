"use strict";

const crypto = require("crypto");
const repositoryDefault = require("../repositories/moderationRepository");
const moderationDefault = require("./moderationService");
const antiLinkDefault = require("./antiLinkService");
const identitiesDefault = require("./identityService");
const groupsDefault = require("./groupDirectoryService");
const styleDefault = require("./messageStyleService");

function createLinkApprovalService(options = {}) {
  const repository = options.repository || repositoryDefault, moderation = options.moderationService || moderationDefault, antiLink = options.antiLinkService || antiLinkDefault, identities = options.identityService || identitiesDefault, groups = options.groupDirectoryService || groupsDefault, style = options.messageStyleService || styleDefault;
  const clock = options.clock || (() => new Date()), clean = value => String(value ?? "").replace(/\s+/g, " ").trim(), nowIso = () => clock().toISOString();
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  const error = (code, message) => Object.assign(new Error(message), { code });

  function validateLinkRequest(value) {
    const raw = clean(value), links = antiLink.extractLinks(raw);
    if (links.length !== 1 || links[0] !== raw) throw error(links.length > 1 ? "MULTIPLE_LINKS" : "INVALID_URL", links.length > 1 ? "Envie apenas um link por solicitação." : "Envie uma URL HTTP ou HTTPS válida.");
    if (!/^https?:\/\//i.test(raw)) throw error("PROTOCOL_REQUIRED", "A URL deve começar com http:// ou https://.");
    let parsed; try { parsed = new URL(raw); } catch (_) { throw error("INVALID_URL", "URL inválida."); }
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) throw error("UNSAFE_PROTOCOL", "Protocolo não permitido.");
    if (parsed.username || parsed.password) throw error("CREDENTIALS_FORBIDDEN", "URLs com credenciais não são permitidas.");
    const sanitized = moderation.sanitizeUrl(raw), linkType = moderation.classifyLink(raw);
    const normalizedOriginal = `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname.replace(/\/+/g, "/") || "/"}${parsed.search}`;
    return { original: raw, domain: sanitized.domain, linkType, sanitizedUrl: sanitized.sanitizedUrl, urlHash: hash(normalizedOriginal) };
  }
  function sanitizeLinkDescription(value) { const description = clean(value); if (description.length > 300) throw error("DESCRIPTION_TOO_LONG", "A descrição deve possuir no máximo 300 caracteres."); if (description && (antiLink.extractLinks(description).length || /(?:@lid|@c\.us|@g\.us|\+?\d[\d\s().-]{7,}|^!)/i.test(description))) throw error("DESCRIPTION_UNSAFE", "A descrição contém dados ou comandos não permitidos."); return description; }

  async function getEligibleGroupsForLinkRequest({ requesterId, resolveAccess }) {
    const listed = await groups.listActiveGroups("whatsapp"), eligible = [];
    for (const group of listed) {
      const config = moderation.normalizeGroupConfig(await moderation.getGroupConfig(group.groupId) || {});
      if (!config.settings.approval.enabled || !(config.settings.antiLink.enabled || config.settings.antiLink.requireApproval)) continue;
      let access = null; try { access = await resolveAccess(group.groupId, requesterId); } catch (_) { access = null; }
      if (access?.userPresent && access?.botPresent) eligible.push({ groupId: group.groupId, name: groups.formatGroupDisplayName(group), config, access });
    }
    return eligible;
  }
  async function findDuplicateActiveRequest(input) { const items = await repository.findPendingLinks({ groupId: input.groupId, requesterId: input.requesterId, urlHash: input.urlHash }); for (const item of items) { const current = await expireLinkRequestIfNeeded(item); if (["pending", "approved", "publishing"].includes(current.status)) return current; } return null; }
  async function createLinkRequest(input = {}) {
    const link = input.link || validateLinkRequest(input.url), config = moderation.normalizeGroupConfig(await moderation.getGroupConfig(input.groupId) || {});
    if (!config.settings.approval.enabled) throw error("APPROVAL_DISABLED", "A aprovação de links não está disponível neste grupo.");
    if (await moderation.isDomainBlacklisted(link.domain, input.groupId)) throw error("DOMAIN_BLACKLISTED", "🚫 Este domínio não pode ser enviado para análise neste grupo.");
    const duplicate = await findDuplicateActiveRequest({ groupId: input.groupId, requesterId: input.requesterId, urlHash: link.urlHash });
    if (duplicate) { await moderation.registerHistory({ groupId: input.groupId, userId: input.requesterId, action: "link_request_duplicate_reused", domain: link.domain, metadata: { requestStatus: duplicate.status } }); return { request: duplicate, duplicate: true }; }
    const days = config.settings.approval.requestExpiresDays, createdAt = nowIso(), expiresAt = new Date(clock().getTime() + days * 86400000).toISOString();
    const request = await repository.createPendingLink({ groupId: input.groupId, requesterId: input.requesterId, domain: link.domain, linkType: link.linkType, sanitizedUrl: link.sanitizedUrl, urlHash: link.urlHash, description: sanitizeLinkDescription(input.description), status: "pending", reviewedBy: null, reviewReason: "", publishedMessageIdHash: null, createdAt, updatedAt: createdAt, expiresAt });
    await moderation.registerHistory({ groupId: input.groupId, userId: input.requesterId, action: "link_request_created", domain: link.domain, metadata: { linkType: link.linkType, requestStatus: "pending", expirationDays: days } });
    return { request, duplicate: false };
  }
  async function expireLinkRequestIfNeeded(request) { if (!request || !["pending", "approved"].includes(request.status) || Date.parse(request.expiresAt) > clock().getTime()) return request; const expired = await repository.expirePendingLink(request.requestId); await moderation.registerHistory({ groupId: request.groupId, userId: request.requesterId, action: "link_request_expired", domain: request.domain, metadata: { requestStatus: "expired" } }); return expired; }
  async function getRequest(id) { return expireLinkRequestIfNeeded(await repository.getPendingLink(clean(id).toUpperCase())); }
  async function listRequesterLinkRequests({ requesterId, page = 1 }) { const all = await repository.findPendingLinks({ requesterId }); const items = []; for (const item of all) items.push(await expireLinkRequestIfNeeded(item)); return paginate(items, page); }
  async function listPendingGroupRequests({ groupId, page = 1 }) { const all = await repository.findPendingLinks({ groupId, status: "pending" }), current = []; for (const item of all) if ((await expireLinkRequestIfNeeded(item)).status === "pending") current.push(item); return paginate(current, page); }
  function paginate(items, page) { const pageSize = 5, totalPages = Math.max(1, Math.ceil(items.length / pageSize)), normalized = Math.max(1, Number(page) || 1); if (normalized > totalPages) throw error("INVALID_PAGE", "Página inválida."); return { items: items.slice((normalized - 1) * pageSize, normalized * pageSize), page: normalized, pageSize, total: items.length, totalPages }; }
  async function getLinkRequestForReview(id) { const request = await getRequest(id); if (!request) throw error("NOT_FOUND", "Solicitação não encontrada."); return request; }
  const rank = role => role?.isOwner ? 3 : role?.isAdmin ? 2 : role?.isModerator ? 1 : 0;
  async function canReviewLinkRequest({ role, request }) { const config = moderation.normalizeGroupConfig(await moderation.getGroupConfig(request.groupId) || {}); return rank(role) >= 2 || rank(role) === 1 && config.settings.approval.allowModeratorReview; }
  const canApproveLinkRequest = input => canReviewLinkRequest(input);
  async function reserveLinkPublication({ requestId, actorId }) { const request = await getRequest(requestId); if (!request || request.status !== "pending") return { reserved: false, request }; if (!/^[a-f0-9]{64}$/.test(request.urlHash || "") || moderation.extractEffectiveDomain(request.sanitizedUrl) !== request.domain) throw error("INTEGRITY_FAILED", "A integridade da solicitação não pôde ser confirmada."); const result = await repository.reservePendingLinkPublication(requestId, actorId); if (result.reserved) await moderation.registerHistory({ groupId: request.groupId, userId: request.requesterId, actorId, action: "link_publish_reserved", domain: request.domain, metadata: { requestStatus: "publishing" } }); return result; }
  async function finalizePublishedLink({ request, actorId, messageId }) { const updated = await repository.updatePendingLink(request.requestId, { status: "published", reviewedBy: actorId, publishedMessageIdHash: hash(clean(messageId) || request.requestId), updatedAt: nowIso() }); await repository.savePublicationReceipt(hash(request.requestId), updated.publishedMessageIdHash); await moderation.registerHistory({ groupId: request.groupId, userId: request.requesterId, actorId, action: "link_published", domain: request.domain, metadata: { requestStatus: "published", linkType: request.linkType } }); return updated; }
  async function publishApprovedLink({ requestId, actorId, sendToGroup, requesterName }) { const reserved = await reserveLinkPublication({ requestId, actorId }); if (!reserved.reserved) return { published: false, duplicate: reserved.request?.status === "published", request: reserved.request }; const request = reserved.request; await moderation.registerHistory({ groupId: request.groupId, userId: request.requesterId, actorId, action: "link_approved", domain: request.domain, metadata: { requestStatus: "publishing", linkType: request.linkType } }); try { const sent = await sendToGroup(request.groupId, formatPublishedLinkMessage(request, requesterName)); const finalized = await finalizePublishedLink({ request, actorId, messageId: sent?.id?._serialized || sent?.id?.id || sent?.id }); return { published: true, request: finalized, sent }; } catch (cause) { await repository.releasePendingLinkPublication(requestId); await moderation.registerHistory({ groupId: request.groupId, userId: request.requesterId, actorId, action: "link_publish_failed", domain: request.domain, metadata: { requestStatus: "pending", failureCode: "send_failed" } }); return { published: false, failureCode: "send_failed", cause }; } }
  async function rejectLinkRequest({ requestId, actorId, reason = "" }) { const request = await getRequest(requestId); if (!request || request.status !== "pending") throw error("NOT_PENDING", "Esta solicitação não está pendente."); const updated = await repository.updatePendingLink(requestId, { status: "rejected", reviewedBy: actorId, reviewReason: sanitizeLinkDescription(reason), updatedAt: nowIso() }); await moderation.registerHistory({ groupId: request.groupId, userId: request.requesterId, actorId, action: "link_rejected", domain: request.domain, metadata: { requestStatus: "rejected" } }); return updated; }
  async function cancelLinkRequest({ requestId, requesterId }) { const request = await getRequest(requestId); if (!request || !identities.identitiesMatch(request.requesterId, requesterId)) throw error("FORBIDDEN", "Você não pode cancelar esta solicitação."); if (request.status !== "pending") throw error("NOT_PENDING", "Somente solicitações pendentes podem ser canceladas."); const updated = await repository.updatePendingLink(requestId, { status: "cancelled", updatedAt: nowIso() }); await moderation.registerHistory({ groupId: request.groupId, userId: requesterId, action: "link_request_cancelled", domain: request.domain, metadata: { requestStatus: "cancelled" } }); return updated; }
  async function notifyGroupAdmins({ request, admins = [], sendPrivate, requesterName, groupName }) { let sent = 0; for (const admin of admins) { const key = hash(`${request.requestId}:${identities.normalizeUserId(admin.id)}`); if (!await repository.saveNotificationReceipt(key, true)) continue; try { await sendPrivate(admin.id, formatLinkRequestSummary(request, { requesterName, groupName, admin: true })); sent++; await moderation.registerHistory({ groupId: request.groupId, userId: request.requesterId, action: "link_admin_notification_sent", domain: request.domain }); } catch (_) { await moderation.registerHistory({ groupId: request.groupId, userId: request.requesterId, action: "link_admin_notification_failed", domain: request.domain, metadata: { failureCode: "send_failed" } }); } } return sent; }
  async function notifyRequester({ request, text, sendPrivate }) { try { await sendPrivate(request.requesterId, text); await moderation.registerHistory({ groupId: request.groupId, userId: request.requesterId, action: "link_requester_notification_sent", domain: request.domain }); return true; } catch (_) { await moderation.registerHistory({ groupId: request.groupId, userId: request.requesterId, action: "link_requester_notification_failed", domain: request.domain, metadata: { failureCode: "send_failed" } }); return false; } }
  function formatLinkRequestSummary(request, names = {}) { return style.section("🔗 NOVO LINK PARA ANÁLISE", [`Protocolo: ${request.requestId}`, `Solicitante: ${names.requesterName || "Membro não identificado"}`, `Grupo: ${names.groupName || "Grupo"}`, `Domínio: ${request.domain}`, `Tipo: ${request.linkType}`, `Descrição: ${request.description || "Não informada"}`, "", `Use !analisarlink ${request.requestId} ou !links pendentes.`]); }
  function formatPublishedLinkMessage(request, requesterName) { return `✅ LINK APROVADO\n\nEnviado por:\n${requesterName || "Membro não identificado"}\n\nDescrição:\n${request.description || "Não informada"}\n\n${request.sanitizedUrl}\n\nAprovado pela moderação.`; }
  return { getEligibleGroupsForLinkRequest, validateLinkRequest, sanitizeLinkDescription, createLinkRequest, findDuplicateActiveRequest, listRequesterLinkRequests, listPendingGroupRequests, getLinkRequestForReview, canReviewLinkRequest, canApproveLinkRequest, reserveLinkPublication, publishApprovedLink, finalizePublishedLink, rejectLinkRequest, cancelLinkRequest, expireLinkRequestIfNeeded, notifyGroupAdmins, notifyRequester, formatLinkRequestSummary, formatPublishedLinkMessage };
}
const service = createLinkApprovalService();
module.exports = { ...service, createLinkApprovalService };
