const { Client, LocalAuth } = require("whatsapp-web.js")
const qrcode = require("qrcode-terminal")

const client = new Client({
    authStrategy: new LocalAuth()
})

const BOT_NAME = "MikaBot PRO 👑"

// 📲 QR CODE
client.on("qr", qr => {
    console.log("📲 Escaneia o QR:")
    qrcode.generate(qr, { small: true })
})

// ✅ ONLINE
client.on("ready", () => {
    console.log(`✅ ${BOT_NAME} ONLINE`)
})

// 💬 MENSAGENS
client.on("message", async (msg) => {

    if (!msg.body) return

    const text = msg.body.toLowerCase().trim()
    const chat = await msg.getChat()

    console.log("📩:", text)

    // 📌 MENU
    if (text === "menu") {
        return msg.reply(
`🤖 ${BOT_NAME}

📌 MENU
• menu
• ping
• oi
• regras`
        )
    }

    // 🏓 PING
    if (text === "ping") {
        return msg.reply("🏓 Pong!")
    }

    // 👋 OI
    if (text === "oi") {
        return msg.reply("👋 Oi! MikaBot PRO aqui 🚀")
    }

    // 📜 REGRAS
    if (text === "regras") {
        return msg.reply(
`📜 REGRAS DO GRUPO

🚫 Proibido tigrinho / apostas
🚫 Proibido pornografia
🚫 Proibido ofensas ou spam`
        )
    }
})

// 👋 BOAS-VINDAS (quando alguém entra no grupo)
client.on("group_join", async (notification) => {
    try {
        const chat = await client.getChatById(notification.chatId)

        const user = notification.id.participant

        await chat.sendMessage(
`👋 Bem-vindo(a) @${user.replace("@c.us", "")} à Tropa Pokémon GO! ⚡

🤖 É uma honra ter você aqui!

📌 Leia as regras com atenção
📜 Digite *regras* para ver as regras`,
        {
            mentions: [user]
        })
    } catch (err) {
        console.log("Erro boas-vindas:", err)
    }
})

client.initialize()