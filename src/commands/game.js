const fs = require("fs");
const path = require("path");
const dbPath = path.join(__dirname, "..", "database");

module.exports = {
  name: "game",
  aliases: ["pokebola"],
  async execute(client, msg, args, context = {}) {
    const cmd = context.commandName || msg.body.split(" ")[0].substring(1).toLowerCase();

    if (cmd === "pokebola") {
      const dex = JSON.parse(fs.readFileSync(path.join(dbPath, "pokedex_gen1.json"), "utf8"));
      const pkm = dex[Math.floor(Math.random() * dex.length)];
      const capturou = Math.random() < 0.5;
      await msg.reply("⚾ Pokébola vai!...");
      setTimeout(() => {
        if (capturou) msg.reply(`✅ Capturaste um **${pkm.nome}**!`);
        else msg.reply(`💨 O **${pkm.nome}** fugiu!`);
      }, 2000);
    }

  }
};
