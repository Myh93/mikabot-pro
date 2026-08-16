const raidRepository = require("../repositories/raidRepository");
const raidService = require("../services/raidService");
const memberJourneyDefault = require("../services/memberJourneyService");
const memberExperience = require("../services/memberExperienceService");

function formatPokemonName(name) {
  return String(name || "")
    .split(" ")
    .map(part => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function createRaidParticipationCommands(repository = raidRepository, service = raidService, journey = repository === raidRepository ? memberJourneyDefault : { grant: async () => ({ granted: false }) }) {
  async function replyResolutionError(msg, operation) {
    try {
      return await operation();
    } catch (err) {
      if (err instanceof raidService.RaidResolutionError || err?.name === "RaidResolutionError") {
        return msg.reply(err.message);
      }
      throw err;
    }
  }

  const joinRaidCommand = {
    name: "vou",
    aliases: [],
    async execute(client, msg, args) {
      return replyResolutionError(msg, async () => {
        const raid = await service.resolveRaid(msg, args);
        const identity = await service.resolveUserIdentity(msg);

        if (identity.ambiguous) {
          return msg.reply("❌ Não foi possível confirmar seu cadastro com segurança. Revise seus aliases de identidade.");
        }
        if (!identity.registration) {
          return msg.reply(memberExperience.registrationRequiredMessage());
        }

        const existingParticipant = service.findExistingParticipant(raid, identity);
        if (existingParticipant) {
          return msg.reply(`ℹ️ Você já está participando da Raid ${raid.id}.`);
        }

        const result = repository.addParticipant(raid.id, identity.id, msg.from);
        if (result.added !== false) await journey.grant(identity.id, "first_raid", { platform: "whatsapp", groupId: msg.from });
        return msg.reply(
          "✅ PARTICIPAÇÃO CONFIRMADA\n\n" +
          `👤 Treinador: ${identity.name}\n` +
          `👾 Raid: ${result.raid.id} — ${formatPokemonName(result.raid.name)}\n` +
          `👥 Participantes: ${result.raid.participants.length}`
        );
      });
    }
  };

  const leaveRaidCommand = {
    name: "desistir",
    aliases: [],
    async execute(client, msg, args) {
      return replyResolutionError(msg, async () => {
        const raid = await service.resolveRaid(msg, args);
        const identity = await service.resolveUserIdentity(msg);
        if (identity.ambiguous) {
          return msg.reply("❌ Não foi possível confirmar seu cadastro com segurança. Revise seus aliases de identidade.");
        }
        const existingParticipant = service.findExistingParticipant(raid, identity);

        if (!existingParticipant) {
          return msg.reply(`ℹ️ Você não está participando da Raid ${raid.id}.`);
        }

        const result = repository.removeParticipant(raid.id, existingParticipant, msg.from);
        return msg.reply(
          "🚪 PARTICIPAÇÃO CANCELADA\n\n" +
          `👤 Treinador: ${identity.name || "Treinador"}\n` +
          `👾 Raid: ${result.raid.id} — ${formatPokemonName(result.raid.name)}\n` +
          `👥 Participantes: ${result.raid.participants.length}`
        );
      });
    }
  };

  const listParticipantsCommand = {
    name: "lista",
    aliases: [],
    async execute(client, msg, args) {
      return replyResolutionError(msg, async () => {
        const raid = await service.resolveRaid(msg, args);
        const participantNames = await Promise.all(raid.participants.map(participantId =>
          service.getParticipantName(participantId)
        ));

        let response =
          `👥 PARTICIPANTES — ${raid.id}\n\n` +
          `👾 ${formatPokemonName(raid.name)}\n` +
          `📊 Total: ${raid.participants.length}\n`;

        if (participantNames.length) {
          response += "\n" + participantNames
            .map((name, index) => `${index + 1}. ${name}`)
            .join("\n");
        } else {
          response += "\nNenhum participante confirmado.";
        }

        return msg.reply(response);
      });
    }
  };

  return [joinRaidCommand, leaveRaidCommand, listParticipantsCommand];
}

const participationCommands = createRaidParticipationCommands();
Object.defineProperty(participationCommands, "createRaidParticipationCommands", {
  value: createRaidParticipationCommands,
  enumerable: false
});

module.exports = participationCommands;
