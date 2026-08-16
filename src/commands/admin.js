const fs = require("fs");
const path = require("path");
const dbPath = path.join(__dirname, "..", "database");
const menuRegistry = require("../services/menuRegistry");
const whatsappWarningLimiter = require("../utils/whatsappWarningLimiter");

module.exports = {
  name: "admin",
  aliases: ["ban", "warn", "sync", "todos", "tagall"],
  adminOnly: true,
  async execute(client, msg, args, context = {}) {
    const commandName = context.commandName || msg.body.split(" ")[0].substring(1).toLowerCase();
    if (commandName === "admin") return menuRegistry.openMenuFromCommand("admin", client, msg, context);
    let chat = context.chat || null;
    if (!chat && !context.chatAttempted && typeof msg.getChat === "function") {
      try { chat = await msg.getChat(); }
      catch (_) { whatsappWarningLimiter.warn("adminCommand", "getChat"); }
    }
    if (!chat?.isGroup || !Array.isArray(chat.participants)) return msg.reply("❌ Não foi possível concluir esta ação agora.");

    if (commandName === "sync") {
      const pFile = path.join(dbPath, "participants.json");
      let pData = {};
      pData[chat.id._serialized] = chat.participants.map(p => ({ id: p.id._serialized, user: p.id.user, isAdmin: p.isAdmin }));
      fs.writeFileSync(pFile, JSON.stringify(pData, null, 2));
      return msg.reply("✅ Sincronização concluída!");
    }

    if (commandName === "todos" || commandName === "tagall") {
      let m = chat.participants.map(p => p.id._serialized);
      return await client.sendMessage(msg.from, args.join(" ") || "📢 *CHAMADA GERAL!*", { mentions: m });
    }
  }
};
