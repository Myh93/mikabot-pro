const fs = require("fs");
const path = require("path");
const { logDetailedError } = require("../utils/logger");
const configurationService = require("./services/configurationService");
const permissionService = require("./services/permissionService");
const quizAnswer = require("./events/quizAnswer");
const menuAnswer = require("./events/menuAnswer");
const guidedFlowAnswer = require("./events/guidedFlowAnswer");
const registrationGuidedFlowAnswer = require("./events/registrationGuidedFlowAnswer");
const inputResolver = require("./services/inputResolverService");
const { createPlatformContext } = require("./utils/platformContext");
const groupDirectoryService = require("./services/groupDirectoryService");
const whatsappWarningLimiter = require("./utils/whatsappWarningLimiter");
const quizMarathonService = require("./services/quizMarathonService");
const antiLinkService = require("./services/antiLinkService");
const joinRequestService = require("./services/joinRequestService");
const memberLeaveService = require("./services/memberLeaveService");
const memberExperienceService = require("./services/memberExperienceService");
const registrationAccessService = require("./services/registrationAccessService");
const comandos = {};
const attachedClients = new WeakSet();
const joinRequestListenerClients = new WeakSet();
const memberLifecycleListenerClients = new WeakSet();

const comandosPath = path.join(__dirname, "commands");
fs.readdirSync(comandosPath).forEach(file => {
  if (file.endsWith(".js")) {
    const exportedCommands = require(path.join(comandosPath, file));
    const fileCommands = Array.isArray(exportedCommands) ? exportedCommands : [exportedCommands];

    fileCommands.forEach(comando => {
      comandos[comando.name] = comando;
    });
  }
});

function resolveCommand(commandText) {
  const inputTokens = commandText.trim().split(/\s+/);
  const normalizedTokens = inputTokens.map(token => token.toLowerCase());
  const candidates = [];

  Object.values(comandos).forEach(command => {
    [command.name, ...(command.aliases || [])].forEach(commandName => {
      const nameTokens = commandName.trim().toLowerCase().split(/\s+/);
      const matches = nameTokens.every((token, index) => normalizedTokens[index] === token);

      if (matches) {
        candidates.push({
          command,
          matchedName: commandName.trim().toLowerCase(),
          tokenCount: nameTokens.length,
          canonical: commandName === command.name
        });
      }
    });
  });

  candidates.sort((a, b) =>
    b.tokenCount - a.tokenCount ||
    Number(b.canonical) - Number(a.canonical) ||
    b.matchedName.length - a.matchedName.length
  );

  const resolved = candidates[0];
  if (!resolved) return null;

  return {
    ...resolved,
    args: inputTokens.slice(resolved.tokenCount)
  };
}

function resolveCommandPrefix(context) {
  try {
    const resolved = configurationService.getResolved("system.commandPrefix", {
      communityId: context?.communityId,
      platform: context?.platform,
      groupId: context?.groupId
    });
    return typeof resolved?.value === "string" && resolved.value
      ? resolved.value
      : "!";
  } catch (_) {
    return "!";
  }
}

function resolvePrivateRegistrationCommand(context, body) {
  if (context?.isGroup) return null;
  const normalized = inputResolver.normalizeInput(body);
  return ["cadastro", "cadastrar", "registro", "registrar"].includes(normalized) ? normalized : null;
}

async function dispatchCommand(client, msg, commandText) {
  const resolved = resolveCommand(commandText);
  if (!resolved) return false;

  const { command, matchedName: commandName, args } = resolved;

  const canonicalContext = await createPlatformContext(client, msg, { resolveContact: false });
  const registrationAccess = await registrationAccessService.authorize(canonicalContext, command, commandName);
  if (!registrationAccess.allowed) {
    await canonicalContext.replyText(registrationAccessService.MESSAGE);
    return true;
  }

  let chat = null;
  let contact = null;
  let isOwner = false;
  let isAdmin = false;
  let isModerator = false;
  let participante = null;
  let role = null;
  const needsPermissions = Boolean(
    command.groupOnly || command.privateOnly || command.moderatorOnly || command.adminOnly ||
    command.ownerOnly || command.protectedOwnerOnly || command.participantOnly || command.permissions
  );

  if (needsPermissions) {
    contact = await msg.getContact();

    try {
      chat = await msg.getChat();
    } catch (err) {
      whatsappWarningLimiter.warn("loader", "getChat");
    }

    role = await permissionService.resolveRole({ msg, client, chat, contact });
    participante = role.participant;
    isOwner = role.isOwner;
    isAdmin = role.isAdmin;
    isModerator = role.isModerator;

    if (command.groupOnly && !chat?.isGroup) return msg.reply("❌ Este comando só pode ser usado em grupos.");
    if (command.privateOnly && chat?.isGroup) return msg.reply("❌ Este comando só pode ser usado no privado.");
    if (command.protectedOwnerOnly && !permissionService.hasPermission(role, command)) return msg.reply("Apenas a dona protegida pode usar este comando.");
    if (command.ownerOnly && !permissionService.hasPermission(role, command)) return msg.reply("❌ Apenas owners!");
    if (command.adminOnly && !permissionService.hasPermission(role, command)) return msg.reply("❌ Apenas admins!");
    if (command.moderatorOnly && !permissionService.hasPermission(role, command)) return msg.reply("Apenas moderadores!");
  }

  try {
    const platformContext = canonicalContext;
    await command.execute(client, msg, args, {
      chat, chatAttempted: needsPermissions, contact, isOwner, isAdmin, isModerator, participante, role,
      identity: role?.identity || null, commandName, canonicalCommand: command.name, platformContext
    });
    return true;
  } catch (err) {
    logDetailedError(`Erro no comando ${commandName}:`, err);
    return false;
  }
}

function joinRequestBootErrorCode(error) {
  return String(error?.code || error?.name || "attach_failed")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_");
}

function attachJoinRequest(client) {
  console.log("[JOIN_REQUEST_BOOT] attachCalled=true");
  try {
    if (!joinRequestListenerClients.has(client)) {
      client.on("group_membership_request", async (notification) => {
        console.log("[JOIN_REQUEST_EVENT] received=true");
        console.log(`[JOIN_REQUEST_EVENT] authorPresent=${Boolean(notification?.author)}`);
        console.log(`[JOIN_REQUEST_EVENT] chatIdPresent=${Boolean(notification?.chatId)}`);
        console.log(`[JOIN_REQUEST_EVENT] notificationValid=${Boolean(
          notification && typeof notification === "object"
        )}`);
        try {
          await joinRequestService.handleEvent(client, notification);
        } catch (err) {
          logDetailedError("Erro ao processar pedido de entrada:", err);
        }
      });
      joinRequestListenerClients.add(client);
      console.log("[JOIN_REQUEST_BOOT] listenerRegistered=true");
    }
    joinRequestService.start(client);
  } catch (error) {
    console.log("[JOIN_REQUEST_BOOT] attachFailed=true");
    console.log(`[JOIN_REQUEST_BOOT] errorCode=${joinRequestBootErrorCode(error)}`);
  }
}

function attach(client) {
  attachJoinRequest(client);
  if (attachedClients.has(client)) return;
  attachedClients.add(client);
  if (!memberLifecycleListenerClients.has(client)) {
    client.on("group_leave", async notification => {
      try {
        await memberLeaveService.handleNotification(notification);
        await memberExperienceService.handleLeave(client, notification);
      } catch (error) {
        logDetailedError("Erro ao processar saída de membro:", error);
      }
    });
    client.on("group_join", notification => {
      Promise.all([memberLeaveService.handleJoinNotification(notification), memberExperienceService.handleJoin(client, notification)]).catch(error => logDetailedError("Erro ao registrar entrada de membro:", error));
    });
    memberLifecycleListenerClients.add(client);
    memberExperienceService.resume(client).catch(error => logDetailedError("Erro ao retomar mensagens temporárias:", error));
  }
  quizMarathonService.resume(client).catch((error) => logDetailedError("Erro ao retomar Maratonas do Quiz:", error));
  client.on("message", async (msg) => {
    try {
      console.log("[ANTI] listener recebeu mensagem");
      if (!msg || msg.fromMe || msg.from === "status@broadcast") return;
      const body = typeof msg.body === "string" ? msg.body : "";
      const platformContext = await createPlatformContext(client, msg, { resolveContact: false });
      let memberExperienceResult = null;
      try { memberExperienceResult = await memberExperienceService.handleIncomingMessage(platformContext, body); }
      catch (experienceError) { logDetailedError("Erro ao processar experiência do membro:", experienceError); }
      if (memberExperienceResult?.status === "disabled") return;
      if (typeof msg.from === "string" && msg.from.endsWith("@g.us")) {
        try {
          await groupDirectoryService.registerSeenGroup(msg);
        } catch (directoryError) {
          console.warn(`⚠️ Não foi possível atualizar o diretório de grupos: ${directoryError?.message || directoryError}`);
        }
      }
      console.log("[ANTI] chamando handleIncomingMessage");
      const antiLinkResult = await antiLinkService.handleIncomingMessage({ ...platformContext, client, message: msg });
      if (antiLinkResult?.status === "blocked") return;
      const commandPrefix = resolveCommandPrefix(platformContext);
      const slashDiscipline = /^\/(?:banir|desbanir|historicoban|statusmembro)\b/i.test(body);
      const privateRegistrationCommand = resolvePrivateRegistrationCommand(platformContext, body);
      if (privateRegistrationCommand) {
        await dispatchCommand(client, msg, privateRegistrationCommand);
        return;
      }
      if (body.startsWith(commandPrefix) || slashDiscipline) {
        const commandText = body.slice(slashDiscipline ? 1 : commandPrefix.length).trim();
        if (commandText && await registrationGuidedFlowAnswer.hasActiveFlow(platformContext)) {
          const navigation = inputResolver.resolveNavigation(commandText);
          if (navigation) {
            await registrationGuidedFlowAnswer.handleRegistrationGuidedFlowAnswer({ context: platformContext, text: body });
            return;
          }
        }
        if (commandText) await dispatchCommand(client, msg, commandText);
        return;
      }

      if (await quizAnswer.hasActiveRound(platformContext)) {
        const quizAccess = await registrationAccessService.authorize(platformContext, { registrationRequired: true, name: "quiz" }, "quiz");
        if (!quizAccess.allowed) { await platformContext.replyText(registrationAccessService.MESSAGE); return; }
        await quizAnswer.handleQuizAnswer({ client, msg, context: platformContext });
        return;
      }

      if (await registrationGuidedFlowAnswer.hasActiveFlow(platformContext)) {
        await registrationGuidedFlowAnswer.handleRegistrationGuidedFlowAnswer({ context: platformContext, text: body });
        return;
      }

      if (await guidedFlowAnswer.hasActiveFlow(platformContext)) {
        await guidedFlowAnswer.handleGuidedFlowAnswer({ client, context: platformContext, text: body });
        return;
      }

      // Espaço reservado para fluxos guiados persistentes, antes dos menus.
      if (await menuAnswer.hasActiveMenu(platformContext)) {
        await menuAnswer.handleMenuAnswer({
          client, msg, context: platformContext, text: body,
          executeCommand: async (text) => dispatchCommand(client, msg, text)
        });
      }
    } catch (err) {
      logDetailedError("Erro no loader de mensagens:", err);
    }
  });
}

function detach(client) {
  joinRequestService.stop(client);
}

Object.defineProperty(comandos, "attach", { value: attach, enumerable: false });
Object.defineProperty(comandos, "detach", { value: detach, enumerable: false });
Object.defineProperty(comandos, "dispatchCommand", { value: dispatchCommand, enumerable: false });
Object.defineProperty(comandos, "resolvePrivateRegistrationCommand", { value: resolvePrivateRegistrationCommand, enumerable: false });

module.exports = comandos;
