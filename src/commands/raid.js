const raidRepository = require("../repositories/raidRepository");
const menuRegistry = require("../services/menuRegistry");
const raidService = require("../services/raidService");
const raidGuidedFlow = require("../services/raidGuidedFlowService");
const { createPlatformContext } = require("../utils/platformContext");

function getActiveRaidsForGroup(groupId) {
  return raidRepository.listActiveRaids(groupId);
}

function findActiveRaid(identifier, groupId) {
  const search = String(identifier || "").trim();
  if (!search) return null;

  const byId = raidRepository.getRaidById(search);
  if (byId && ["active", "published"].includes(byId.status)) return byId;

  return getActiveRaidsForGroup(groupId).find(raid =>
    raid.name.toLowerCase() === search.toLowerCase()
  ) || null;
}

const createRaidCommand = {
  name: "criar raid",
  aliases: ["raid criar", "novaraid", "raid"],
  async execute(client, msg, args, context) {
    const raidName = args.join(" ").trim().toLowerCase();

    if (!raidName && context?.commandName === "raid") return menuRegistry.openMenuFromCommand("raid", client, msg, context);
    if (!raidName) {
      const platformContext = context?.platformContext || await createPlatformContext(client, msg);
      return raidGuidedFlow.start({ ...platformContext, conversationId: platformContext.groupId, message: msg });
    }
    const platformContext = context?.platformContext || await createPlatformContext(client, msg);
    if (!platformContext.isGroup) {
      const guidedContext = { ...platformContext, conversationId: platformContext.groupId, message: msg };
      const started = await raidGuidedFlow.start(guidedContext);
      if (started.status === "started") await raidGuidedFlow.handleAnswer(guidedContext, raidName);
      return started;
    }
    const result = await raidService.createRaidFromMessage(msg, { name: raidName });
    return msg.reply(await raidService.formatCreatedRaid(result.raid));
  }
};

const editRaidCommand = {
  name: "editar raid",
  aliases: ["raid editar"],
  async execute(client, msg, args) {
    const fullArgs = args.join(" ");

    if (!fullArgs.includes(">")) return msg.reply("⚠️ Erro! Use: !editar raid antigo > novo");

    const [oldNameOrId, newName] = fullArgs.split(">").map(text => text.trim());
    if (!oldNameOrId || !newName) return msg.reply("⚠️ Erro! Use: !editar raid antigo > novo");

    const raid = findActiveRaid(oldNameOrId, msg.from);
    if (!raid) return msg.reply("❌ Essa raid não existe.");

    const updatedRaid = raidRepository.updateRaid(raid.id, {
      name: newName.toLowerCase()
    });
    return msg.reply(`✅ Raid ${updatedRaid.id} alterada para: *${updatedRaid.name.toUpperCase()}*`);
  }
};

const cancelRaidCommand = {
  name: "cancelar raid",
  aliases: ["raid cancelar"],
  async execute(client, msg, args) {
    const raidNameOrId = args.join(" ").trim();

    if (!raidNameOrId) return msg.reply("⚠️ Digita o nome ou ID da Raid!");

    const raid = findActiveRaid(raidNameOrId, msg.from);
    if (!raid) return msg.reply("❌ Essa raid não existe.");

    raidRepository.cancelRaid(raid.id);
    return msg.reply(`✅ Raid *${raid.name.toUpperCase()}* (${raid.id}) cancelada!`);
  }
};

const publishRaidCommand = {
  name: "publicar raid",
  aliases: ["raid publicar"],
  async execute(client, msg, args) {
    const groupId = typeof msg.from === "string" && msg.from.endsWith("@g.us")
      ? msg.from
      : null;
    if (!groupId) return msg.reply("❌ Este comando só pode ser usado em grupos.");

    const raidId = args[0];
    if (!raidId) return msg.reply("⚠️ Use: !publicar raid R1024");

    const raid = raidRepository.getRaidById(raidId);
    if (!raid) return msg.reply("❌ Raid não encontrada.");
    if (raid.status === "cancelled") return msg.reply("❌ Não é possível publicar uma raid cancelada.");
    if ((raid.publications || []).some(item => item.groupId === groupId)) {
      return msg.reply("⚠️ Esta raid já foi publicada neste grupo.");
    }
    const result = await raidService.publishRaidToGroups(client, raid, [{ id: groupId, name: "Grupo atual" }]);
    return msg.reply(raidService.formatPublicationResult(result));
  }
};

const listRaidsCommand = {
  name: "listar raids",
  aliases: ["raid lista", "listar raid"],
  async execute(client, msg, args, context) {
    const platformContext = context?.platformContext || await createPlatformContext(client, msg);
    if (!platformContext.isGroup) return raidGuidedFlow.startList({ ...platformContext, conversationId: platformContext.groupId, message: msg });
    const raids = getActiveRaidsForGroup(msg.from);

    if (!raids.length) return msg.reply("📋 Não há raids ativas no momento.");

    let list = "📋 *RAIDS ATIVAS*\n\n";
    raids.forEach((raid, index) => {
      list += `${index + 1}. *${raid.name.toUpperCase()}* — ${raid.id} — ${raid.participants.length} treinador(es)\n`;
    });
    return msg.reply(list);
  }
};

const listArchivedRaidsCommand = {
  name: "listar raids arquivadas",
  aliases: ["raid arquivadas"],
  adminOnly: true,
  async execute(client, msg) {
    const raids = raidRepository.listArchivedRaids(msg.from);
    if (!raids.length) return msg.reply("📦 Não há raids arquivadas.");
    const lines = raids.map((raid, index) => `${index + 1}. *${raid.name.toUpperCase()}* — ${raid.id}`);
    return msg.reply(["📦 *RAIDS ARQUIVADAS*", "", ...lines].join("\n"));
  }
};

module.exports = [
  createRaidCommand,
  editRaidCommand,
  cancelRaidCommand,
  publishRaidCommand,
  listRaidsCommand,
  listArchivedRaidsCommand
];
