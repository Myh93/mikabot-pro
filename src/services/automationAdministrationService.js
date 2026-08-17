"use strict";

const configurationDefault = require("./configurationService");
const moderationDefault = require("./moderationService");
const experienceRepositoryDefault = require("../repositories/memberExperienceRepository");

const CONFIGURED = [
  ["Anti-spam", "moderation.antiSpam.enabled"],
  ["Anti-flood", "moderation.antiFlood.enabled"],
  ["Join Request", "joinRequest.enabled"],
  ["Eventos", "events.scheduler.enabled"],
  ["Quiz", "quiz.enabled"]
];

function createAutomationAdministrationService(options = {}) {
  const configuration = options.configurationService || configurationDefault;
  const moderation = options.moderationService || moderationDefault;
  const experience = options.memberExperienceRepository || experienceRepositoryDefault;
  const mark = value => value === true ? "✅ Ativo" : value === false ? "❌ Desativado" : "⚠️ Atenção";

  async function getStatus(context = {}) {
    const scope = { platform: context.platform || "whatsapp", groupId: context.groupId, communityId: context.communityId };
    const groupConfig = context.groupId ? await moderation.getGroupConfig(context.groupId) : null;
    const experienceConfig = context.groupId ? await experience.getGroupConfig(context.groupId) : null;
    const items = CONFIGURED.map(([label, key]) => ({ label, status: mark(configuration.get(key, scope)), source: "ConfigurationService" }));
    items.splice(2, 0,
      { label: "Antilink", status: mark(groupConfig?.settings?.antiLink?.enabled), source: "moderationService" },
      { label: "Advertências automáticas", status: mark(groupConfig?.settings?.warnings?.enabled), source: "moderationService" },
      { label: "Banimentos automáticos", status: mark(groupConfig?.settings?.ban?.enabled), source: "moderationService" }
    );
    items.push(
      { label: "Boas-vindas", status: mark(experienceConfig?.welcome?.enabled), source: "memberExperienceRepository" },
      { label: "Saída/Retorno", status: mark(experienceConfig?.farewell?.enabled), source: "memberExperienceRepository" },
      { label: "Cadastro/Entrada", status: mark(configuration.get("joinRequest.requireCompletedRegistration", scope)), source: "ConfigurationService" },
      { label: "Raids/Lembretes", status: "⚠️ Atenção", source: "sem configuração liga/desliga própria" }
    );
    return items;
  }

  async function formatStatus(context) {
    const items = await getStatus(context);
    return `🤖 STATUS DAS AUTOMAÇÕES\n\n${items.map(item => `${item.status} — ${item.label}`).join("\n")}`;
  }

  return { getStatus, formatStatus };
}

const service = createAutomationAdministrationService();
module.exports = { ...service, createAutomationAdministrationService };
