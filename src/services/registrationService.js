"use strict";

const identityService = require("./identityService");
const repositoryDefault = require("../repositories/registrationRepository");

const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const placeholder = (value) => /\$\{[^}]+\}/.test(String(value || ""));
const getDefaultPreferences = () => ({ raidNotifications: true, eventNotifications: true, quizNotifications: true, newsNotifications: true });
const getDefaultPrivacy = () => ({ showFriendCode: true, showSecondaryAccounts: true });
const getDefaultContacts = () => ({ telegram: { enabled: false, username: "", groupName: "", groupLink: "" } });

function createRegistrationService(options = {}) {
  const repository = options.repository || repositoryDefault;
  const identities = options.identityService || identityService;

  function normalizeStored(item) {
    if (!item) return null;
    return { ...item, mainAccount: { nick: item.mainAccount?.nick || item.nick || "", friendCode: item.mainAccount?.friendCode || item.friendCode || "", team: item.mainAccount?.team ?? null, level: item.mainAccount?.level ?? null }, secondaryAccounts: Array.isArray(item.secondaryAccounts) ? item.secondaryAccounts : [], contacts: normalizeContacts(item.contacts), preferences: normalizePreferences(item.preferences), privacy: normalizePrivacy(item.privacy) };
  }

  function validateTelegramUsername(value) { const username = clean(value).replace(/^@+/, ""); const valid = /^[A-Za-z0-9_]{5,32}$/.test(username); return { valid, value: valid ? `@${username}` : "", error: valid ? null : "Usuário do Telegram inválido." }; }
  function validateTelegramPhone(value) { const digits = clean(value).replace(/\D/g, ""); const valid = /^\d{10,15}$/.test(digits); return { valid, value: valid ? `+${digits}` : "", error: valid ? null : "Número do Telegram inválido." }; }
  function validateTelegramGroupLink(value) { const raw = clean(value); const candidate = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i.test(raw) ? (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`) : ""; let valid = false; try { const url = new URL(candidate); valid = ["t.me", "telegram.me"].includes(url.hostname.toLowerCase()) && url.protocol === "https:" && url.pathname.length > 1; } catch (_) { valid = false; } return { valid, value: valid ? candidate.replace(/^http:\/\//i, "https://") : "", error: valid ? null : "Link de grupo do Telegram inválido." }; }
  function normalizeTelegram(value = {}) { const username = value.username ? (clean(value.username).startsWith("+") ? validateTelegramPhone(value.username) : validateTelegramUsername(value.username)) : { valid: true, value: "" }; const link = value.groupLink ? validateTelegramGroupLink(value.groupLink) : { valid: true, value: "" }; const enabled = Boolean(value.enabled && username.valid && username.value); return { enabled, username: username.valid ? username.value : "", groupName: clean(value.groupName), groupLink: link.valid ? link.value : "" }; }
  function normalizeContacts(value = {}) { return { ...getDefaultContacts(), ...(value || {}), telegram: normalizeTelegram(value?.telegram || {}) }; }
  function normalizePreferences(value = {}) { const defaults = getDefaultPreferences(); return Object.fromEntries(Object.keys(defaults).map(key => [key, value[key] === undefined ? defaults[key] : Boolean(value[key])])); }
  function normalizePrivacy(value = {}) { const defaults = getDefaultPrivacy(); const normalized = Object.fromEntries(Object.keys(defaults).map(key => [key, value[key] === undefined ? defaults[key] : Boolean(value[key])])); if (value.showNick !== undefined) normalized.showNick = Boolean(value.showNick); return normalized; }

  function normalizeIdentity(value) { return identities.normalizeUserId(value); }
  function buildIdentityAliases(value, extras = []) {
    const values = [value, ...extras], result = new Set();
    for (const raw of values) {
      const normalized = normalizeIdentity(raw); if (!normalized) continue;
      result.add(normalized);
      for (const variant of identities.generateBrazilianNumberVariants(normalized)) {
        result.add(variant);
        if (/^\d+$/.test(variant)) { result.add(`${variant}@c.us`); result.add(`${variant}@s.whatsapp.net`); }
      }
    }
    return [...result];
  }
  async function findByIdentity(value) {
    const candidates = buildIdentityAliases(value, typeof value === "object" ? value.candidates || [] : []);
    for (const candidate of candidates) { const found = await repository.findByIdentity(candidate); if (found) return normalizeStored(found); }
    return null;
  }
  async function resolveRegistration(value) { return findByIdentity(value); }
  const getRegistration = async (id) => normalizeStored(await repository.getRegistrationById(id));
  const getRegistrationByIdentity = (value) => findByIdentity(value);

  function normalizeFriendCode(value) { return String(value ?? "").replace(/\D/g, ""); }
  function validateFriendCode(value) { const normalized = normalizeFriendCode(value); return { valid: /^\d{12}$/.test(normalized), value: normalized, error: /^\d{12}$/.test(normalized) ? null : "Friend Code deve conter 12 dígitos." }; }
  function validateText(value, label, { required = true, max = 80 } = {}) { const normalized = clean(value); const valid = (!required || normalized.length > 0) && normalized.length <= max && !placeholder(normalized); return { valid, value: normalized, error: valid ? null : `${label} inválido.` }; }
  const validateName = (value) => validateText(value, "Nome", { max: 100 });
  const validateNick = (value) => validateText(value, "Nick", { max: 50 });
  const validateCity = (value) => validateText(value, "Cidade", { max: 100 });

  function normalizeInput(input, legacy = false) {
    const primaryIdentity = normalizeIdentity(input.primaryIdentity || input.identity);
    const aliases = buildIdentityAliases(primaryIdentity, input.identityAliases || []);
    const name = validateName(input.name ?? input.nome), nick = validateNick(input.nick), city = validateCity(input.city ?? input.cidade), friend = validateFriendCode(input.friendCode ?? input.codigo ?? input.cod);
    const invalidPlaceholder = [input.name ?? input.nome, input.nick, input.friendCode ?? input.codigo ?? input.cod, input.city ?? input.cidade].some(placeholder);
    const needsReview = invalidPlaceholder || !name.valid || !nick.valid || !friend.valid;
    const main = input.mainAccount;
    return {
      platform: input.platform || "whatsapp", primaryIdentity, identityAliases: aliases,
      name: name.value, nick: nick.value, friendCode: friend.value, city: city.value,
      status: invalidPlaceholder ? "review_required" : (input.status || (needsReview ? "review_required" : "active")),
      validationStatus: invalidPlaceholder ? "invalid_placeholder" : (input.validationStatus || (legacy ? (needsReview ? "legacy_invalid" : "legacy_unverified") : (needsReview ? "review_required" : "valid"))),
      source: input.source || (legacy ? "legacy_migration" : "command"), metadata: { ...(input.metadata || {}) },
      ...(main ? { mainAccount: { nick: clean(main.nick ?? input.nick), friendCode: normalizeFriendCode(main.friendCode ?? input.friendCode), team: main.team ?? null, level: main.level ?? null } } : {}),
      ...(Array.isArray(input.secondaryAccounts) ? { secondaryAccounts: input.secondaryAccounts.map(account => ({ ...account, nick: clean(account.nick), friendCode: normalizeFriendCode(account.friendCode), team: account.team, level: Number(account.level) })) } : {}),
      ...(input.playStyle ? { playStyle: { fly: Boolean(input.playStyle.fly), canela: Boolean(input.playStyle.canela) } } : {}),
      ...(input.playSchedule !== undefined ? { playSchedule: clean(input.playSchedule) } : {})
      , contacts: normalizeContacts(input.contacts), preferences: normalizePreferences(input.preferences), privacy: normalizePrivacy(input.privacy)
    };
  }

  async function createRegistration(input) {
    const normalized = normalizeInput(input, false);
    if (!normalized.primaryIdentity) throw new Error("Identidade obrigatória.");
    for (const check of [validateName(input.name ?? input.nome), validateNick(input.nick), validateFriendCode(input.friendCode ?? input.codigo ?? input.cod), validateCity(input.city ?? input.cidade)]) if (!check.valid) throw new Error(check.error);
    return repository.createRegistration(normalized);
  }
  async function updateRegistration(id, changes) {
    const current = await repository.getRegistrationById(id); if (!current) return null;
    const merged = { ...current, ...changes };
    if (current.mainAccount && !changes.mainAccount) merged.mainAccount = { ...current.mainAccount, ...(changes.nick !== undefined ? { nick: changes.nick } : {}), ...(changes.friendCode !== undefined ? { friendCode: changes.friendCode } : {}) };
    return repository.updateRegistration(id, normalizeInput(merged, current.source === "legacy_migration"));
  }
  async function upsertLegacyRegistration(input) {
    const normalized = normalizeInput({ ...input, source: "legacy_migration" }, true);
    if (!normalized.primaryIdentity) throw new Error("Identidade legada inválida.");
    const current = await findByIdentity({ id: normalized.primaryIdentity, candidates: normalized.identityAliases });
    return current ? repository.updateRegistration(current.registrationId, { ...normalized, registrationId: current.registrationId }, { action: "legacy_migrated" }) : repository.createRegistration(normalized, { action: "legacy_migrated" });
  }
  async function upsertRegistration(input) {
    const prepared = { ...input };
    if (Array.isArray(input.secondaryAccounts)) {
      const primary = validateAccount(input.mainAccount || { nick: input.nick, friendCode: input.friendCode, team: input.team || "mystic", level: input.level || 1 });
      const seenNicks = new Set([clean(primary.nick).toLocaleLowerCase("pt-BR")]), seenCodes = new Set([primary.friendCode]), seenIds = new Set();
      prepared.secondaryAccounts = [];
      for (const raw of input.secondaryAccounts) {
        const account = validateAccount(raw), nickKey = clean(account.nick).toLocaleLowerCase("pt-BR");
        if (seenNicks.has(nickKey)) throw new Error("Nick duplicado neste cadastro.");
        if (seenCodes.has(account.friendCode)) throw new Error("Friend Code duplicado neste cadastro.");
        seenNicks.add(nickKey); seenCodes.add(account.friendCode);
        const accountId = raw.accountId || await repository.reserveAccountId();
        if (seenIds.has(accountId)) throw new Error("accountId duplicado."); seenIds.add(accountId);
        prepared.secondaryAccounts.push({ ...raw, ...account, accountId, createdAt: raw.createdAt || new Date().toISOString() });
      }
    }
    const normalized = normalizeInput(prepared, false); if (!normalized.primaryIdentity) throw new Error("Identidade obrigatória.");
    for (const check of [validateName(prepared.name ?? prepared.nome), validateNick(prepared.nick), validateFriendCode(prepared.friendCode ?? prepared.codigo ?? prepared.cod), validateCity(prepared.city ?? prepared.cidade)]) if (!check.valid) throw new Error(check.error);
    const current = await findByIdentity({ id: normalized.primaryIdentity, candidates: normalized.identityAliases });
    return current ? updateRegistration(current.registrationId, prepared) : repository.createRegistration(normalized);
  }
  async function isRegistered(value) { return Boolean(await findByIdentity(value)); }
  async function resolvePublicName(value, fallback) { const item = await findByIdentity(value); return identities.validPublicName?.(item?.nick) || identities.validPublicName?.(item?.name) || item?.nick || item?.name || fallback || "Treinador"; }
  const listRegistrations = async (filters) => (await repository.listRegistrations(filters)).map(normalizeStored);
  async function getRegistrationHealth() { const validation = await repository.validateDatabase(); const registrations = validation.valid ? await repository.listRegistrations() : []; return { ...validation, total: registrations.length, reviewRequired: registrations.filter(item => item.status === "review_required").length }; }

  function validateAccount(input) {
    const nick = validateNick(input.nick), friend = validateFriendCode(input.friendCode);
    const team = String(input.team || "").toLowerCase();
    const level = Number(input.level);
    if (!nick.valid) throw new Error(nick.error);
    if (!friend.valid) throw new Error(friend.error);
    if (!["valor", "mystic", "instinct"].includes(team)) throw new Error("Time inválido.");
    if (!Number.isInteger(level) || level < 1) throw new Error("Nível inválido.");
    return { nick: nick.value, friendCode: friend.value, team, level };
  }
  function ensureUniqueAccount(registration, account, ignoredAccountId = null) {
    const accounts = [registration.mainAccount, ...(registration.secondaryAccounts || [])].filter(Boolean).filter(item => item.accountId !== ignoredAccountId);
    if (accounts.some(item => clean(item.nick).toLocaleLowerCase("pt-BR") === clean(account.nick).toLocaleLowerCase("pt-BR"))) throw new Error("Nick duplicado neste cadastro.");
    if (accounts.some(item => normalizeFriendCode(item.friendCode) === account.friendCode)) throw new Error("Friend Code duplicado neste cadastro.");
  }
  async function addSecondaryAccount(identity, input) {
    const registration = await findByIdentity(identity); if (!registration) throw new Error("Cadastro não encontrado.");
    const account = validateAccount(input); ensureUniqueAccount(registration, account);
    const accountId = await repository.reserveAccountId();
    const stored = { accountId, ...account, createdAt: new Date().toISOString() };
    await repository.updateRegistration(registration.registrationId, { secondaryAccounts: [...registration.secondaryAccounts, stored] }, { action: "secondary_account_added" });
    return stored;
  }
  async function updateSecondaryAccount(identity, accountId, changes) {
    const registration = await findByIdentity(identity); if (!registration) throw new Error("Cadastro não encontrado.");
    const current = registration.secondaryAccounts.find(item => item.accountId === accountId); if (!current) throw new Error("Conta secundária não encontrada.");
    const account = validateAccount({ ...current, ...changes }); ensureUniqueAccount(registration, account, accountId);
    const updated = { ...current, ...account, accountId: current.accountId, createdAt: current.createdAt, updatedAt: new Date().toISOString() };
    await repository.updateRegistration(registration.registrationId, { secondaryAccounts: registration.secondaryAccounts.map(item => item.accountId === accountId ? updated : item) }, { action: "secondary_account_updated" });
    return updated;
  }
  async function removeSecondaryAccount(identity, accountId) {
    const registration = await findByIdentity(identity); if (!registration) throw new Error("Cadastro não encontrado.");
    const current = registration.secondaryAccounts.find(item => item.accountId === accountId); if (!current) throw new Error("Conta secundária não encontrada.");
    await repository.updateRegistration(registration.registrationId, { secondaryAccounts: registration.secondaryAccounts.filter(item => item.accountId !== accountId) }, { action: "secondary_account_removed" });
    return current;
  }
  async function listAccounts(identity) { const registration = await findByIdentity(identity); return registration ? { mainAccount: registration.mainAccount, secondaryAccounts: registration.secondaryAccounts } : null; }

  async function getPrivacy(identity) {
    const registration = await findByIdentity(identity);
    return registration ? normalizePrivacy(registration.privacy) : null;
  }
  async function updatePrivacy(identity, changes = {}) {
    const registration = await findByIdentity(identity); if (!registration) return null;
    const allowed = {};
    if (changes.showNick !== undefined) allowed.showNick = Boolean(changes.showNick);
    if (changes.showFriendCode !== undefined) allowed.showFriendCode = Boolean(changes.showFriendCode);
    if (changes.showSecondaryAccounts !== undefined) allowed.showSecondaryAccounts = Boolean(changes.showSecondaryAccounts);
    const privacy = normalizePrivacy({ ...registration.privacy, ...allowed });
    const updated = await repository.updateRegistration(registration.registrationId, { privacy }, { action: "privacy_updated" });
    return normalizeStored(updated);
  }
  const setNickVisibility = (identity, visible) => updatePrivacy(identity, { showNick: visible });
  const setFriendCodeVisibility = (identity, visible) => updatePrivacy(identity, { showFriendCode: visible });
  const setSecondaryAccountsVisibility = (identity, visible) => updatePrivacy(identity, { showSecondaryAccounts: visible });

  async function updateEditableField(identity, field, value) {
    const registration = await findByIdentity(identity); if (!registration) return null;
    const validators = { name: validateName, city: validateCity };
    if (validators[field]) { const result = validators[field](value); if (!result.valid) throw new Error(result.error); value = result.value; }
    if (field === "playSchedule") { value = clean(value); if (!value || value.length > 120 || placeholder(value)) throw new Error("Horários inválidos."); }
    if (!['name', 'city', 'playSchedule'].includes(field)) throw new Error("Campo não editável.");
    const actions = { name: "name_updated", city: "city_updated", playSchedule: "schedule_updated" };
    return normalizeStored(await repository.updateRegistration(registration.registrationId, { [field]: value }, { action: actions[field] }));
  }
  async function updatePlayStyle(identity, field, value) {
    if (!['fly', 'canela'].includes(field)) throw new Error("Campo de estilo inválido.");
    const registration = await findByIdentity(identity); if (!registration) return null;
    return normalizeStored(await repository.updateRegistration(registration.registrationId, { playStyle: { ...(registration.playStyle || {}), [field]: Boolean(value) } }, { action: `${field}_updated` }));
  }
  async function updateMainAccount(identity, field, rawValue) {
    const registration = await findByIdentity(identity); if (!registration) return null;
    const main = { ...registration.mainAccount };
    let value = rawValue;
    if (field === "nick") { const result = validateNick(value); if (!result.valid) throw new Error(result.error); value = result.value; if ((registration.secondaryAccounts || []).some(account => clean(account.nick).toLocaleLowerCase("pt-BR") === clean(value).toLocaleLowerCase("pt-BR"))) throw new Error("Nick duplicado neste cadastro."); }
    else if (field === "friendCode") { const result = validateFriendCode(value); if (!result.valid) throw new Error(result.error); value = result.value; if ((registration.secondaryAccounts || []).some(account => normalizeFriendCode(account.friendCode) === value)) throw new Error("Friend Code duplicado neste cadastro."); const duplicate = await repository.findByFriendCode(value); if (duplicate && duplicate.registrationId !== registration.registrationId) throw new Error("Friend Code já cadastrado por outro treinador."); }
    else if (field === "team") { value = String(value || "").toLowerCase(); if (!["valor", "mystic", "instinct"].includes(value)) throw new Error("Time inválido."); }
    else if (field === "level") { value = Number(value); if (!Number.isInteger(value) || value < 1) throw new Error("Nível inválido."); }
    else throw new Error("Campo da conta principal inválido.");
    main[field] = value;
    const legacy = field === "nick" ? { nick: value } : field === "friendCode" ? { friendCode: value } : {};
    return normalizeStored(await repository.updateRegistration(registration.registrationId, { ...legacy, mainAccount: main }, { action: `main_account_${field === "friendCode" ? "friend_code" : field}_updated` }));
  }
  async function updateTelegram(identity, changes = {}, options = {}) {
    const registration = await findByIdentity(identity); if (!registration) return null;
    const current = { ...getDefaultContacts().telegram, ...(registration.contacts?.telegram || {}) };
    let telegram;
    if (options.clear) telegram = { enabled: false, username: "", groupName: "", groupLink: "" };
    else {
      telegram = { ...current, ...changes };
      if (changes.username !== undefined) { const result = validateTelegramUsername(changes.username); if (!result.valid) throw new Error(result.error); telegram.username = result.value; }
      if (changes.groupLink !== undefined && clean(changes.groupLink)) { const result = validateTelegramGroupLink(changes.groupLink); if (!result.valid) throw new Error(result.error); telegram.groupLink = result.value; }
      if (changes.groupLink !== undefined && !clean(changes.groupLink)) telegram.groupLink = "";
      if (changes.groupName !== undefined) { telegram.groupName = clean(changes.groupName); if (telegram.groupName.length > 100 || placeholder(telegram.groupName)) throw new Error("Nome do grupo inválido."); }
      if (changes.enabled !== undefined) telegram.enabled = Boolean(changes.enabled);
    }
    const contacts = { ...(registration.contacts || {}), telegram };
    return normalizeStored(await repository.updateRegistration(registration.registrationId, { contacts }, { action: options.clear ? "telegram_cleared" : "telegram_updated" }));
  }
  async function updatePreferences(identity, changes = {}) {
    const registration = await findByIdentity(identity); if (!registration) return null;
    const allowed = {}; for (const key of Object.keys(getDefaultPreferences())) if (changes[key] !== undefined) allowed[key] = Boolean(changes[key]);
    return normalizeStored(await repository.updateRegistration(registration.registrationId, { preferences: normalizePreferences({ ...registration.preferences, ...allowed }) }, { action: "preferences_updated" }));
  }

  return { normalizeIdentity, buildIdentityAliases, findByIdentity, resolveRegistration, getRegistration, getRegistrationByIdentity, createRegistration, updateRegistration, upsertRegistration, upsertLegacyRegistration, isRegistered, resolvePublicName, validateFriendCode, normalizeFriendCode, validateNick, validateName, validateCity, listRegistrations, getRegistrationHealth, addSecondaryAccount, updateSecondaryAccount, removeSecondaryAccount, listAccounts, getPrivacy, updatePrivacy, setNickVisibility, setFriendCodeVisibility, setSecondaryAccountsVisibility, updateEditableField, updatePlayStyle, updateMainAccount, updateTelegram, updatePreferences, normalizeTelegram, validateTelegramUsername, validateTelegramGroupLink, normalizePreferences, normalizePrivacy, getDefaultPreferences, getDefaultPrivacy, getDefaultContacts };
}

const service = createRegistrationService();
module.exports = { ...service, createRegistrationService };
