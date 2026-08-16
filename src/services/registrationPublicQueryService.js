"use strict";

const registrationServiceDefault = require("./registrationService");
const identityServiceDefault = require("./identityService");
const inputResolverDefault = require("./inputResolverService");
const { SEPARATOR } = require("./messageStyleService");

const LINE = SEPARATOR;
const NOT_FOUND = "❌ Treinador não encontrado.\n\nPeça para a pessoa concluir o cadastro no privado do MikaBot enviando:\n\ncadastro";
const INCOMPLETE = "⚠️ Este cadastro ainda não está completo ou precisa de revisão.\n\nA pessoa deve falar com o MikaBot no privado e enviar:\n\ncadastro";
const DUPLICATE = "⚠️ Mais de um treinador possui esse Nick.\n\nUse uma menção:\n\n!treinador @usuario";

function createRegistrationPublicQueryService(options = {}) {
  const registrations = options.registrationService || registrationServiceDefault;
  const identities = options.identityService || identityServiceDefault;
  const inputs = options.inputResolverService || inputResolverDefault;

  function isOwnerView(registration, viewerIdentity) {
    if (!registration || !viewerIdentity) return false;
    const ownerIdentities = [registration.primaryIdentity, ...(registration.identityAliases || [])].filter(Boolean);
    return ownerIdentities.some(ownerIdentity => identities.identitiesMatch(ownerIdentity, viewerIdentity));
  }
  function canViewFriendCode(registration, viewerIdentity) {
    return isOwnerView(registration, viewerIdentity) || registration?.privacy?.showFriendCode !== false;
  }
  function canViewNick(registration, viewerIdentity) {
    return isOwnerView(registration, viewerIdentity) || registration?.privacy?.showNick !== false;
  }
  function canViewSecondaryAccounts(registration, viewerIdentity) {
    return isOwnerView(registration, viewerIdentity) || registration?.privacy?.showSecondaryAccounts !== false;
  }

  function formatFriendCode(value) { const code = registrations.normalizeFriendCode(value); return /^\d{12}$/.test(code) ? code.replace(/(\d{4})(?=\d)/g, "$1 ") : null; }
  function formatTeam(value) { return ({ valor: "Valor", mystic: "Mystic", instinct: "Instinct" })[String(value || "").toLowerCase()] || "Não informado"; }
  function formatLevel(value) { const level = Number(value); return Number.isInteger(level) && level >= 1 ? String(level) : "Não informado"; }
  function formatPagination(page, totalPages) { return totalPages > 1 ? `📄 Página ${page} de ${totalPages}` : ""; }
  function formatAccountSummary(account, options = {}) {
    const nick = identities.validPublicName(account?.nick) || "Treinador";
    const code = formatFriendCode(account?.friendCode);
    if (!code) return null;
    if (options.compact) return [`🎮 ${nick}`, code].join("\n");
    return [`${options.number ? `${options.number}️⃣ ` : ""}${nick}`, options.showFriendCode === false ? "🔒 Friend Code privado" : `🆔 ${code}`, `🛡️ ${formatTeam(account.team)}`, `⭐ Nível ${formatLevel(account.level)}`].join("\n");
  }

  function safeAccount(account, main = false) {
    const nick = identities.validPublicName(account?.nick), friendCode = formatFriendCode(account?.friendCode);
    if (!nick || !friendCode) return null;
    return { nick, friendCode: registrations.normalizeFriendCode(account.friendCode), team: ["valor", "mystic", "instinct"].includes(account.team) ? account.team : null, level: Number.isInteger(Number(account.level)) && Number(account.level) >= 1 ? Number(account.level) : null, main };
  }
  function publicTrainer(registration, viewerIdentity) {
    if (!registration) return { status: "not_found" };
    if (registration.status === "review_required" || registration.validationStatus === "invalid_placeholder") return { status: "incomplete" };
    const main = safeAccount(registration.mainAccount || { nick: registration.nick, friendCode: registration.friendCode }, true);
    if (!main) return { status: "incomplete" };
    const secondary = (registration.secondaryAccounts || []).map(account => safeAccount(account, false)).filter(Boolean);
    const nickVisible = canViewNick(registration, viewerIdentity);
    return { status: "found", trainer: { publicName: nickVisible ? (main.nick || identities.validPublicName(registration.nick) || "Treinador") : "Treinador", mainAccount: { ...main, nick: nickVisible ? main.nick : "Nick privado" }, secondaryAccounts: secondary, totalAccounts: 1 + secondary.length, canViewNick: nickVisible, canViewFriendCode: canViewFriendCode(registration, viewerIdentity), canViewSecondaryAccounts: canViewSecondaryAccounts(registration, viewerIdentity), city: registration.city || null } };
  }

  async function getPublicTrainer(identity, viewerIdentity) { return publicTrainer(await registrations.getRegistrationByIdentity(identity), viewerIdentity); }
  async function findPublicTrainer(query, viewerIdentity) {
    const normalized = inputs.normalizeInput(query); if (!normalized) return { status: "not_found" };
    const all = await registrations.listRegistrations();
    const friendCode = registrations.normalizeFriendCode(query);
    if (/^\d{12}$/.test(friendCode)) {
      const match = all.find(item => [item.mainAccount?.friendCode, item.friendCode, ...(item.secondaryAccounts || []).map(account => account.friendCode)].some(value => registrations.normalizeFriendCode(value) === friendCode));
      return match ? publicTrainer(match, viewerIdentity) : { status: "not_found" };
    }
    const nickMatches = all.filter(item => [item.mainAccount?.nick, item.nick, ...(item.secondaryAccounts || []).map(account => account.nick)].some(value => inputs.normalizeInput(value) === normalized));
    if (nickMatches.length > 1) return { status: "duplicate" };
    if (nickMatches.length === 1) return publicTrainer(nickMatches[0], viewerIdentity);
    const nameMatches = all.filter(item => inputs.normalizeInput(item.name) === normalized);
    if (nameMatches.length > 1) return { status: "duplicate" };
    return nameMatches.length === 1 ? publicTrainer(nameMatches[0], viewerIdentity) : { status: "not_found" };
  }

  function resolveQueryTarget({ msg, args = [], context }) {
    const mentions = [msg?.mentionedIds?.[0], msg?._data?.mentionedJidList?.[0]].filter(Boolean);
    const tokens = [...args];
    let page = 1;
    if (tokens.length && /^\d+$/.test(String(tokens.at(-1))) && Number(tokens.at(-1)) >= 1) page = Number(tokens.pop());
    const command = inputs.normalizeInput(String(msg?.body || "").trim().split(/\s+/)[0]).replace(/^!/, "");
    const viewerIdentity = identities.normalizeUserId(context.userId);
    const privacyContext = { ...(viewerIdentity ? { viewerIdentity } : {}), ...(command ? { command } : {}) };
    if (mentions.length) return { type: "identity", value: identities.normalizeUserId(mentions[0]), page, source: "mention", ...privacyContext };
    const text = tokens.join(" ").trim();
    if (!text) return { type: "identity", value: context.userId, page, source: "self", ...privacyContext };
    return { type: "text", value: text.replace(/^@/, ""), page, source: "text", ...privacyContext };
  }

  async function resolveTrainer(target) { return target.type === "identity" ? getPublicTrainer(target.value, target.viewerIdentity) : findPublicTrainer(target.value, target.viewerIdentity); }
  function paginate(trainer, page) {
    const accounts = trainer.canViewSecondaryAccounts === false ? [trainer.mainAccount] : [trainer.mainAccount, ...trainer.secondaryAccounts], totalPages = Math.max(1, Math.ceil(accounts.length / 10));
    if (page < 1 || page > totalPages) return { status: "invalid_page", page, totalPages, accounts: [] };
    return { status: "ok", page, totalPages, accounts: accounts.slice((page - 1) * 10, page * 10) };
  }

  function formatTrainerProfile(trainer, page = 1) {
    const pagination = paginate(trainer, page); if (pagination.status !== "ok") return "❌ Esta página não possui contas.";
    const lines = [LINE, "🎮 TREINADOR", LINE, "", `👤 ${trainer.publicName}`];
    if (page === 1 && pagination.accounts[0]?.main) {
      const main = pagination.accounts[0]; lines.push("", "⭐ Conta principal", "", "🎮 Nick:", main.nick, "", "🆔 Friend Code:", trainer.canViewFriendCode ? formatFriendCode(main.friendCode) : "🔒 Friend Code privado", "", "🛡️ Time:", formatTeam(main.team), "", "⭐ Nível:", formatLevel(main.level));
    }
    const secondary = trainer.canViewSecondaryAccounts ? pagination.accounts.filter(account => !account.main) : [];
    lines.push("", "━━━━━━━━━━━━━━", "", "🎮 Contas secundárias", "");
    if (!trainer.canViewSecondaryAccounts) lines.push("🔒 Contas secundárias privadas"); else if (!secondary.length) lines.push("Nenhuma"); else secondary.forEach((account, index) => lines.push(formatAccountSummary(account, { number: (page - 1) * 10 + index + (page === 1 ? 1 : 0), showFriendCode: trainer.canViewFriendCode }), ""));
    lines.push("━━━━━━━━━━━━━━", "", "Total de contas:", String(trainer.totalAccounts));
    const pageText = formatPagination(page, pagination.totalPages); if (pageText) lines.push("", pageText);
    return lines.join("\n").trim();
  }
  function formatFriendCodes(trainer, page = 1) {
    if (!trainer.canViewFriendCode) return "Este treinador optou por não divulgar o Friend Code.";
    const pagination = paginate(trainer, page); if (pagination.status !== "ok") return "❌ Esta página não possui contas.";
    const blocks = pagination.accounts.map(account => formatAccountSummary(account, { compact: true })).filter(Boolean);
    const lines = [LINE, "🆔 FRIEND CODES", LINE, "", ...blocks.flatMap(block => [block, ""]), "━━━━━━━━━━━━━━", "", "Total:", `${trainer.totalAccounts} conta${trainer.totalAccounts === 1 ? "" : "s"}`];
    const pageText = formatPagination(page, pagination.totalPages); if (pageText) lines.push("", pageText);
    return lines.join("\n").trim();
  }
  async function query(target, compact) { const found = await resolveTrainer(target); if (found.status !== "found") return { ...found, text: found.status === "duplicate" ? DUPLICATE : found.status === "incomplete" ? INCOMPLETE : NOT_FOUND }; if (!compact && target.command === "contas" && !found.trainer.canViewSecondaryAccounts) return { ...found, text: "Este treinador optou por não divulgar as contas secundárias." }; return { ...found, text: compact ? formatFriendCodes(found.trainer, target.page) : formatTrainerProfile(found.trainer, target.page) }; }
  const getPublicAccounts = target => query(target, false);
  const getPublicFriendCodes = target => query(target, true);

  return { getPublicTrainer, findPublicTrainer, getPublicAccounts, getPublicFriendCodes, formatTrainerProfile, formatFriendCodes, formatAccountSummary, formatTeam, formatLevel, formatFriendCode, formatPagination, resolveQueryTarget, canViewNick, canViewFriendCode, canViewSecondaryAccounts, isOwnerView, createRegistrationPublicQueryService };
}

const service = createRegistrationPublicQueryService();
module.exports = { ...service, createRegistrationPublicQueryService, NOT_FOUND, INCOMPLETE, DUPLICATE };
