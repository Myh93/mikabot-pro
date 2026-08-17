"use strict";

const moderationDefault = require("./moderationService");
const repositoryDefault = require("../repositories/moderationRepository");
const crypto = require("node:crypto");

const KEY = "officialRules";
const DEFAULT_RULES = "📜 As regras oficiais deste grupo ainda não foram publicadas pela administração.";
const clean = value => String(value || "").replace(/\r\n/g, "\n").trim();

function createGroupRulesService(options = {}) {
  const moderation = options.moderationService || moderationDefault;
  const repository = options.moderationRepository || repositoryDefault;

  async function getRules(context) {
    const config = await moderation.getGroupConfig(context.groupId);
    return { value: clean(config?.officialRules) || DEFAULT_RULES, source: config?.officialRules ? "moderationRepository" : "default" };
  }

  async function publishRules(context, text, audit = {}) {
    const value = clean(text);
    if (!value) throw Object.assign(new Error("As regras não podem ficar vazias."), { code: "RULES_EMPTY" });
    if (value.length > 2048) throw Object.assign(new Error("As regras devem possuir no máximo 2048 caracteres."), { code: "RULES_TOO_LONG" });
    const previous = await getRules(context);
    await moderation.updateGroupConfig(context.groupId, { officialRules: value });
    const executor = `rules_admin_${crypto.createHash("sha256").update(String(context.userId || "unknown")).digest("hex").slice(0, 12)}`;
    await moderation.registerHistory({ groupId: context.groupId, userId: executor, actorId: executor, action: "group_rules_published", result: "success", metadata: { value, previousValue: previous.value, reason: clean(audit.reason || "publicação de regras"), executor: "administrador_autorizado" } });
    return { value, source: "moderationRepository" };
  }

  async function listVersions(context) {
    const result = await repository.listHistory({ groupId: context.groupId, action: "group_rules_published", page: 1, pageSize: 1000 });
    const entries = [...(result.items || [])].reverse();
    return entries.map((item, index) => ({
      version: index + 1, value: item.metadata?.value, previousValue: item.metadata?.previousValue,
      action: item.action, recordedAt: item.createdAt, reason: item.metadata?.reason || "alteração administrativa"
    }));
  }

  async function restoreVersion(context, version) {
    const versions = await listVersions(context);
    const selected = versions.find(item => item.version === Number(version));
    if (!selected || typeof selected.value !== "string") throw Object.assign(new Error("Versão não encontrada."), { code: "RULES_VERSION_NOT_FOUND" });
    return publishRules(context, selected.value, { reason: `restauração da versão ${selected.version}` });
  }

  async function synchronizeGroupDescription(chat, text) {
    if (!chat || typeof chat.setDescription !== "function") return { synchronized: false, reason: "unsupported" };
    try { await chat.setDescription(clean(text)); return { synchronized: true }; }
    catch (_) { return { synchronized: false, reason: "platform_failure" }; }
  }

  return { KEY, DEFAULT_RULES, getRules, publishRules, listVersions, restoreVersion, synchronizeGroupDescription };
}

const service = createGroupRulesService();
module.exports = { ...service, createGroupRulesService, KEY };
