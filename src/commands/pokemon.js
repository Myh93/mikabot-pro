const fs = require("fs");
const path = require("path");
const dbPath = path.join(__dirname, "..", "database");
const menuRegistry = require("../services/menuRegistry");
const registrationGuidedFlow = require("../services/registrationGuidedFlowService");
const { createPlatformContext } = require("../utils/platformContext");
const { FALLBACK: REGISTRATION_PRIVATE_FALLBACK } = require("../services/registrationPrivateShortcutService");

module.exports = {
  name: "pokemon",
  aliases: ["pokedex", "counter", "cadastro", "cadastrar", "registro", "registrar", "perfil"],
  async execute(client, msg, args, context = {}) {
    const commandName = context.commandName || msg.body.split(" ")[0].substring(1).toLowerCase();

    if (commandName === "pokemon") return menuRegistry.openMenuFromCommand("pokemon", client, msg, context);
    if (commandName === "perfil") return menuRegistry.openMenuFromCommand("profile", client, msg, context);

    if (["cadastro", "cadastrar", "registro", "registrar"].includes(commandName)) {
      const platformContext = context.platformContext || await createPlatformContext(client, msg);
      if (args.length) await msg.reply(`ℹ️ O cadastro agora é feito pelo fluxo seguro no privado.\n\n${REGISTRATION_PRIVATE_FALLBACK}`);
      return registrationGuidedFlow.start({ ...platformContext, conversationId: platformContext.conversationId || platformContext.groupId });
    }

    const busca = args.join(" ").toLowerCase().trim();
    if (commandName === "pokedex") {
      if (!busca) return msg.reply("⚠️ Qual Pokémon queres procurar?");
      let dex = [];
      for (let i = 1; i <= 9; i++) {
        const pFile = path.join(dbPath, `pokedex_gen${i}.json`);
        if (fs.existsSync(pFile)) dex = dex.concat(JSON.parse(fs.readFileSync(pFile, "utf8")));
      }
      const p = dex.find(x => x.nome.toLowerCase() === busca || x.numero.toString() === busca);
      if (!p) return msg.reply("❌ Pokémon não encontrado.");
      return msg.reply(`📖 *#${p.numero} - ${p.nome.toUpperCase()}*\n\n🧬 *Tipo:* ${p.tipo.join("/")}\n⚔️ *Fraquezas:* ${p.fraquezas.join(", ")}`);
    }

    if (commandName === "counter") {
      if (!busca) return msg.reply("⚠️ Counter de quem?");
      const bases = ["pokemon_raids.json", "pokemon_megaraids.json", "pokemon_dynamax.json"];
      for (const b of bases) {
        let pFile = path.join(dbPath, b);
        if (fs.existsSync(pFile)) {
          const data = JSON.parse(fs.readFileSync(pFile, "utf8"));
          if (data[busca]) return msg.reply(`⚔️ *COUNTERS PARA ${busca.toUpperCase()}*\n\n${data[busca].counters.join("\n")}`);
        }
      }
      return msg.reply("❌ Sem dados para esse Pokémon.");
    }
  }
};
