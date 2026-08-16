"use strict";

const crypto = require("crypto");
const registrationsDefault = require("./registrationService");
const repositoryDefault = require("../repositories/registrationRepository");
const identityServiceDefault = require("./identityService");
const inputResolverDefault = require("./inputResolverService");

const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
const safeActor = value => crypto.createHash("sha256").update(clean(value)).digest("hex").slice(0, 16);

function createRegistrationAdministrationService(options = {}) {
  const registrations = options.registrationService || registrationsDefault;
  const repository = options.repository || repositoryDefault;
  const identities = options.identityService || identityServiceDefault;
  const inputs = options.inputResolverService || inputResolverDefault;

  async function locate(query) {
    if (query && typeof query === "object") return registrations.getRegistrationByIdentity(query);
    const raw = clean(query);
    if (!raw) return null;
    const byIdentity = await registrations.getRegistrationByIdentity(raw);
    if (byIdentity) return byIdentity;
    const code = registrations.normalizeFriendCode(raw);
    const all = await registrations.listRegistrations();
    const normalized = inputs.normalizeInput(raw.replace(/^@/, ""));
    const matches = all.filter(item =>
      (/^\d{12}$/.test(code) && [item.friendCode, item.mainAccount?.friendCode, ...(item.secondaryAccounts || []).map(account => account.friendCode)].some(value => registrations.normalizeFriendCode(value) === code)) ||
      [item.name, item.nick, item.mainAccount?.nick, ...(item.secondaryAccounts || []).map(account => account.nick)].some(value => inputs.normalizeInput(value) === normalized)
    );
    return matches.length === 1 ? matches[0] : matches.length > 1 ? { ambiguous: true, count: matches.length } : null;
  }

  function view(item) {
    if (!item || item.ambiguous) return null;
    const main = item.mainAccount || {};
    return {
      registrationId: item.registrationId, status: item.status, validationStatus: item.validationStatus,
      name: item.name, city: item.city, nick: main.nick || item.nick,
      friendCode: registrations.normalizeFriendCode(main.friendCode || item.friendCode),
      team: main.team, level: main.level, secondaryAccounts: item.secondaryAccounts || [],
      contacts: item.contacts, preferences: item.preferences, privacy: item.privacy,
      createdAt: item.createdAt, updatedAt: item.updatedAt
    };
  }

  async function updateField(target, field, value, audit = {}) {
    const item = await locate(target);
    if (!item || item.ambiguous) return null;
    let updated;
    if (["name", "city", "playSchedule"].includes(field)) updated = await registrations.updateEditableField(item.primaryIdentity, field, value);
    else if (["nick", "friendCode", "team", "level"].includes(field)) updated = await registrations.updateMainAccount(item.primaryIdentity, field, value);
    else if (["fly", "canela"].includes(field)) updated = await registrations.updatePlayStyle(item.primaryIdentity, field, value);
    else throw new Error("Campo administrativo não permitido.");
    await repository.addHistoryEntry(item.registrationId, "administrative_field_updated", {
      field, executor: safeActor(audit.executor || "unknown"), reason: clean(audit.reason || "Não informado").slice(0, 200)
    });
    return updated;
  }

  const history = async target => { const item = await locate(target); return item && !item.ambiguous ? repository.listHistory(item.registrationId) : null; };
  return { locate, view, updateField, history, safeActor };
}

const service = createRegistrationAdministrationService();
module.exports = { ...service, createRegistrationAdministrationService };
