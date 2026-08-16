const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const comandos = require("./src/loader");
const eventScheduler = require("./src/services/eventSchedulerService");
const raidLifecycle = require("./src/services/raidLifecycleService");
const whatsappClientHealth = require("./src/services/whatsappClientHealthService");
const {
  initializeConfigurationInfrastructure
} = require("./src/services/configurationBootstrapService");
const { logInfo, logDetailedError } = require("./utils/logger");

let motorAtivado = false;
let encerrando = false;

// Inicializa o cliente
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  }
});

// Mostra QR Code no terminal
client.on("qr", qr => {
  qrcode.generate(qr, { small: true });
  console.log("📲 Escaneie o QR Code acima com o WhatsApp para conectar.");
});

// Quando o bot estiver pronto
client.on("ready", async () => {
  console.log("[JOIN_REQUEST_BOOT] readyReached=true");
  logInfo("✅ MikaBot PRO v2.0 conectado e pronto para uso!");
  comandos.attach(client);

  const health = await whatsappClientHealth.diagnoseClientHealth(client);
  logInfo(`[WHATSAPP] cliente=${health.status} erro=${health.errorCode || "none"}`);

  if (!motorAtivado) {
    motorAtivado = true;
    logInfo("🚀 Motor de comandos e segurança ativado!");
  }

  try {
    await eventScheduler.start(client);
  } catch (err) {
    logDetailedError("Erro ao iniciar o scheduler de Eventos:", err);
  }
  try {
    await raidLifecycle.start(client);
  } catch (err) {
    logDetailedError("Erro ao iniciar o ciclo automático de Raids:", err);
  }
});

client.on("auth_failure", err => {
  logDetailedError("Falha na autenticação do WhatsApp:", err);
});

client.on("disconnected", reason => {
  comandos.detach(client);
  logDetailedError("Cliente do WhatsApp desconectado:", reason);
});

async function encerrar(signal) {
  if (encerrando) return;
  encerrando = true;
  logInfo(`Encerramento solicitado por ${signal}.`);

  try {
    eventScheduler.stop();
    raidLifecycle.stop();
    await client.destroy();
    logInfo("Cliente do WhatsApp encerrado com segurança.");
  } catch (err) {
    logDetailedError("Erro ao encerrar o cliente do WhatsApp:", err);
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", () => encerrar("SIGINT"));
process.once("SIGTERM", () => encerrar("SIGTERM"));

async function iniciar() {
  await initializeConfigurationInfrastructure();
  return client.initialize();
}

iniciar().catch(err => {
  logDetailedError("Erro ao inicializar o cliente do WhatsApp:", err);
});
