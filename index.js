const { Client, LocalAuth } = require("whatsapp-web.js")
const qrcode = require("qrcode-terminal")

const client = new Client({
    authStrategy: new LocalAuth()
})

const BOT_NAME = "MikaBot PRO 👑"

// 🧠 memória de boas-vindas (não repete por pessoa)
const greeted = new Set()

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

    // 📌 COMANDOS
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

    if (text === "ping") {
        return msg.reply("🏓 Pong!")
    }

    if (text === "oi") {
        return msg.reply("👋 Oi! MikaBot PRO aqui 🚀")
    }

    if (text === "regras") {
        return msg.reply(
`📜 REGRAS DO GRUPO

🚫 Proibido tigrinho / apostas
🚫 Proibido pornografia
🚫 Proibido ofensas ou spam`
        )
    }

    // 👋 BOAS-VINDAS 1X (quando a pessoa fala pela primeira vez no grupo)
    if (chat.isGroup) {

        const sender = msg.author || msg.from

        // evita repetir
        if (greeted.has(sender)) return

        greeted.add(sender)

        await chat.sendMessage(
`👋 Bem-vindo(a) @${sender.replace("@c.us", "")} à Tropa Pokémon GO! ⚡

🤖 É uma honra ter você aqui!

📌 Leia as regras com atenção
📜 Digite *regras* para ver as regras`
        , {
            mentions: [msg.author]
        })
    }

})

client.initialize()