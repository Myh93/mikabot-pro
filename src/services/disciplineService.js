"use strict";

const crypto = require("crypto");
const repositoryDefault = require("../repositories/disciplineRepository");
const identityDefault = require("./identityService");
const permissionDefault = require("./permissionService");

const VALID_SCOPES = new Set(["group", "platform", "community"]);
const VALID_PLATFORMS = new Set(["whatsapp", "telegram"]);
const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();

function createDisciplineService(options = {}) {
  const repository = options.repository || repositoryDefault;
  const identities = options.identityService || identityDefault;
  const permissions = options.permissionService || permissionDefault;
  const clock = options.clock || (() => new Date());
  const logger = options.logger || (line => console.log(`[DISCIPLINE] ${line}`));
  const notifyAdministrators = options.notifyAdministrators || (async () => false);

  function aliasesOf(identity) {
    return [...new Set(identities.collectCanonicalIdentityCandidates(
      identity?.id || identity,
      ...(identity?.candidates || identity?.identityAliases || [])
    ).filter(Boolean))];
  }
  function keyFor(aliases) {
    return `MEM-${crypto.createHash("sha256").update([...aliases].sort().join("|")).digest("hex")}`;
  }
  async function resolveMember(identity, create = false) {
    const aliases = aliasesOf(identity);
    if (!aliases.length) throw Object.assign(new Error("Identidade não resolvida."), { code: "identity_unresolved" });
    let member = await repository.findMemberByAliases(aliases);
    if (!member && create) member = {
      memberKey: keyFor(aliases), identityAliases: aliases, bans: [], releaseOverrides: {},
      communityBan: false, platformBlocks: { whatsapp: false, telegram: false },
      releaseRequests: [], createdAt: clock().toISOString(), updatedAt: clock().toISOString()
    };
    if (member) member.identityAliases = [...new Set([...(member.identityAliases || []), ...aliases])];
    return member;
  }
  function activeBans(member) { return (member?.bans || []).filter(ban => ban.status === "active"); }
  function refresh(member) {
    const active = activeBans(member);
    member.activeBanCount = active.length;
    member.communityBan = active.length >= 3 || active.some(ban => ban.scope === "community");
    member.platformBlocks = {
      whatsapp: member.communityBan || active.some(ban => ban.scope === "platform" && ban.platform === "whatsapp"),
      telegram: member.communityBan || active.some(ban => ban.scope === "platform" && ban.platform === "telegram")
    };
    member.updatedAt = clock().toISOString();
    return member;
  }
  function audit(action, input, result, member) {
    logger([
      `action=${action}`, `scope=${input.scope || "none"}`, `platform=${input.platform || "none"}`,
      `groupKnown=${Boolean(input.groupId)}`, `memberResolved=${Boolean(member)}`,
      `activeBanCount=${member?.activeBanCount || 0}`, `communityBan=${Boolean(member?.communityBan)}`,
      `result=${result}`, `reasonCode=${input.reasonCode || "none"}`
    ].join(" "));
  }
  async function assertTargetAllowed(identity) {
    if (permissions.isProtectedOwner?.(identity)) {
      throw Object.assign(new Error("A dona protegida não pode ser alvo."), { code: "protected_owner" });
    }
  }
  async function recordBan(input = {}) {
    if (!VALID_SCOPES.has(input.scope)) throw Object.assign(new Error("Escopo inválido."), { code: "invalid_scope" });
    if (!VALID_PLATFORMS.has(input.platform)) throw Object.assign(new Error("Plataforma inválida."), { code: "invalid_platform" });
    await assertTargetAllowed(input.identity);
    let member = await resolveMember(input.identity, true);
    const now = clock().toISOString();
    const stored = await repository.addBan(member.memberKey, member, {
      memberKey: member.memberKey, platform: input.platform,
      groupId: input.scope === "group" ? clean(input.groupId) : null,
      scope: input.scope, createdAt: now,
      administratorKey: input.administrator ? keyFor(aliasesOf(input.administrator)) : null,
      reason: clean(input.reason || "Não informado").slice(0, 300),
      status: "active", revokedAt: null, revokedBy: null, revocationReason: null
    });
    member = refresh(stored.member);
    member.releaseOverrides = { ...(member.releaseOverrides || {}), [input.platform]: false };
    await repository.saveMember(member);
    if (member.communityBan) await notifyAdministrators({ type: "community_ban", memberKey: member.memberKey });
    audit("ban", input, "recorded", member);
    return { ban: stored.ban, member };
  }
  async function getMemberStatus(identity) {
    const member = await resolveMember(identity, false);
    return member ? refresh(member) : {
      activeBanCount: 0, communityBan: false,
      platformBlocks: { whatsapp: false, telegram: false }, bans: []
    };
  }
  async function isBlocked(input = {}) {
    const member = await resolveMember(input.identity, false);
    if (!member) return { blocked: false, reason: null, activeBanCount: 0, communityBan: false };
    refresh(member);
    const override = member.releaseOverrides?.[input.platform] === true;
    const active = activeBans(member);
    let reason = member.communityBan ? "community_ban" :
      active.some(ban => ban.scope === "platform" && ban.platform === input.platform) ? "platform_ban" :
      active.some(ban => ban.scope === "group" && ban.platform === input.platform && ban.groupId === clean(input.groupId)) ? "group_ban" : null;
    if (override) reason = null;
    return { blocked: Boolean(reason), reason, activeBanCount: member.activeBanCount, communityBan: member.communityBan };
  }
  async function revoke(input = {}) {
    let member = await resolveMember(input.identity, false);
    if (!member) return null;
    const platforms = input.platforms === "both" ? ["whatsapp", "telegram"] : [input.platforms].flat().filter(item => VALID_PLATFORMS.has(item));
    const now = clock().toISOString();
    if (input.mode === "keep") for (const platform of platforms) member.releaseOverrides[platform] = true;
    else {
      let candidates = activeBans(member).filter(ban => platforms.includes(ban.platform) || ban.scope === "community");
      if (input.mode === "last") candidates = candidates.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 1);
      const ids = new Set(candidates.map(ban => ban.banId));
      member.bans = member.bans.map(ban => ids.has(ban.banId) ? {
        ...ban, status: "revoked", revokedAt: now,
        revokedBy: input.administrator ? keyFor(aliasesOf(input.administrator)) : null,
        revocationReason: clean(input.reason || "administrative_release").slice(0, 300)
      } : ban);
      for (const platform of platforms) member.releaseOverrides[platform] = false;
    }
    member = refresh(member);
    await repository.saveMember(member);
    audit("revoke", { ...input, scope: "administrative" }, "recorded", member);
    return member;
  }
  async function requestOtherPlatformRelease(input = {}) {
    const member = await resolveMember(input.identity, true);
    member.releaseRequests.push({ platform: input.platform, status: "pending", createdAt: clock().toISOString() });
    await repository.saveMember(member);
    return member.releaseRequests.at(-1);
  }
  async function notifyBlockedJoin(input) {
    return notifyAdministrators({ type: "join_blocked", reason: input.reason, groupKnown: Boolean(input.groupId) });
  }

  return { recordBan, revoke, isBlocked, getMemberStatus, requestOtherPlatformRelease, notifyBlockedJoin, resolveMember };
}

const service = createDisciplineService();
module.exports = { ...service, createDisciplineService, VALID_SCOPES, VALID_PLATFORMS };
