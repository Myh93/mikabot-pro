"use strict";

const permissionServiceDefault = require("./permissionService");
const menuSessionServiceDefault = require("./menuSessionService");
const { createPlatformContext, isCompletePlatformContext } = require("../utils/platformContext");
const whatsappWarningLimiter = require("../utils/whatsappWarningLimiter");

const DEFINITIONS = {
  main: {
    id: "main", title: "🤖 *MIKABOT PRO*", permission: "public",
    options: [
      { label: "Raids", menuId: "raid" }, { label: "Quiz", menuId: "quiz" },
      { label: "Pokémon", menuId: "pokemon" }, { label: "Perfil", menuId: "profile" },
      { label: "Eventos", menuId: "events", privateMenuId: "events_private" }, { label: "Ajuda e Comandos", menuId: "help" },
      { label: "Administração", menuId: "admin", permission: "admin" }
    ]
  },
  quiz: {
    id: "quiz", title: "🧠 *MENU DO QUIZ*", permission: "public",
    options: [
      { label: "Jogar Quiz", command: "jogar quiz" },
      { label: "Quiz Individual", command: "jogar quiz", args: ["individual"] },
      { label: "Maratona", command: "maratona", aliases: ["iniciar maratona"] },
      { label: "Ranking do Grupo", command: "ranking grupo" },
      { label: "Ranking Global", command: "ranking global" },
      { label: "Ranking Semanal", command: "ranking semanal" },
      { label: "Ranking Mensal", command: "ranking mensal" },
      { label: "Estatísticas", command: "perfil", aliases: ["estatisticas"] },
      { label: "Perfil do Quiz", command: "perfil quiz" },
      { label: "Conquistas", command: "conquistas" },
      { label: "Próximo Quiz", command: "proximo quiz" }, { label: "Ajuda", command: "ajuda quiz" }
    ]
  },
  raid: {
    id: "raid", title: "⚔️ *MENU DE RAIDS*", permission: "public",
    options: [
      { label: "Criar Raid", command: "criar raid" },
      { label: "Editar Raid", command: "editar raid", prompt: "✏️ Informe a Raid e o novo nome.\n\nExemplo: R1024 > Novo nome\n\n0️⃣ Voltar" },
      { label: "Cancelar Raid", command: "cancelar raid", prompt: "🗑️ Qual Raid deseja cancelar?\n\nInforme o ID ou nome.\n\n0️⃣ Voltar" },
      { label: "Publicar Raid", command: "publicar raid", prompt: "📣 Qual Raid deseja publicar?\n\nInforme o ID.\n\n0️⃣ Voltar" },
      { label: "Listar Raids", command: "listar raids" },
      { label: "Entrar em Raid", command: "vou", prompt: "✅ Em qual Raid deseja entrar?\n\nInforme o ID.\n\n0️⃣ Voltar" },
      { label: "Desistir de Raid", command: "desistir", prompt: "🚪 De qual Raid deseja desistir?\n\nInforme o ID.\n\n0️⃣ Voltar" },
      { label: "Ver Participantes", command: "lista", prompt: "📋 De qual Raid deseja ver os participantes?\n\nInforme o ID.\n\n0️⃣ Voltar" }
    ]
  },
  pokemon: {
    id: "pokemon", title: "🔍 *MENU POKÉMON*", permission: "public",
    options: [
      { label: "Pokédex", command: "pokedex", prompt: "🔎 Qual Pokémon deseja consultar?\n\n0️⃣ Voltar" },
      { label: "Counters", command: "counter", aliases: ["counters"], prompt: "⚔️ Qual Pokémon deseja consultar?\n\n0️⃣ Voltar" },
      { label: "Pokébola", command: "pokebola" }, { label: "Quiz", menuId: "quiz" },
      { label: "Minha Coleção", info: "Em desenvolvimento." }
    ]
  },
  profile: {
    id: "profile", title: "👤 *MENU DO PERFIL*", permission: "public",
    options: [
      { label: "Meu Perfil", command: "perfil", aliases: ["ver perfil"] },
      { label: "Cadastro", command: "cadastro" },
      { label: "Consultar Treinador", menuId: "trainer_query" },
      { label: "Ranking", command: "ranking" },
      { label: "Conquistas", command: "conquistas" },
      { label: "Perfil do Quiz", command: "perfil quiz" },
      { label: "Contas cadastradas", command: "treinador" }
    ]
  },
  trainer_query: {
    id: "trainer_query", title: "🎮 *CONSULTAR TREINADOR*", permission: "public", backMenuId: "profile",
    options: [
      { label: "Meu cadastro público", command: "treinador" },
      { label: "Consultar por menção", info: "Use: !treinador @usuario" },
      { label: "Consultar por Nick", info: "Use: !treinador Nick" },
      { label: "Ver Friend Codes", command: "fc" }
    ]
  },
  events: {
    id: "events", title: "📅 *MENU DE EVENTOS*", permission: "public",
    options: [
      { label: "Eventos Ativos", command: "listar eventos" },
      { label: "Próximos Eventos", command: "proximos eventos" },
      { label: "Ver Evento", command: "ver evento" },
      { label: "Criar Evento", command: "criar evento" },
      { label: "Editar Evento", command: "editar evento", permission: "admin" },
      { label: "Publicar Evento", command: "publicar evento", permission: "admin" },
      { label: "Cancelar Evento", command: "cancelar evento", permission: "admin" },
      { label: "Finalizar Evento", command: "finalizar evento", permission: "admin" },
      { label: "Arquivar Evento", command: "arquivar evento", permission: "admin" },
      { label: "Histórico", command: "historico eventos", permission: "admin" }
    ]
  },
  help: {
    id: "help", title: "🤝 *AJUDA E COMANDOS*", permission: "public", backMenuId: "main",
    options: [
      { label: "Cadastro e Perfil", menuId: "profile" },
      { label: "Pokémon", menuId: "pokemon" },
      { label: "Quiz", menuId: "quiz" },
      { label: "Raids", menuId: "raid" },
      { label: "Eventos", menuId: "events", privateMenuId: "events_private" },
      { label: "Feedback", command: "feedback" },
      {
        label: "Outros recursos",
        info: [
          "📚 *OUTROS RECURSOS*", "",
          "• TREINADORES — consulta pública", "• PRIVACIDADE — preferências do cadastro",
          "• MISSÕES — jornada do treinador", "• PARARLEMBRETES — lembretes da jornada",
          "• MEUSLINKS — solicitações de links", "• ENVIARLINK — solicitar publicação"
        ].join("\n")
      },
      {
        label: "Comandos administrativos",
        permission: "admin",
        info: [
          "🛡️ *COMANDOS ADMINISTRATIVOS*", "",
          "• WARN / AVISAR / WARNINGS / LIMPARAVISOS", "• BANIR / DESBANIR / BANIDOS",
          "• ANTILINK / APROVACAOLINK / ACAOAVISOS / LIMITEAVISOS / BANREENTRADA",
          "• FEEDBACKS", "• CADASTROS", "• APAGARMEMBRO / APAGARCADASTRO / RESETQUIZ / STATUSMEMBRO / PRESERVARMEMBRO",
          "• LINKSPENDENTES / ANALISARLINK / APROVARSOLICITACAO / REJEITARSOLICITACAO",
          "• SINCRONIZAR GRUPOS", "• GRUPOS / NOMEAR GRUPO / REGISTRAR GRUPO", "• PRAZORETORNO"
        ].join("\n")
      },
      { label: "Administração", menuId: "admin", permission: "admin" }
    ]
  },
  events_private: {
    id: "events_private", title: "📅 *EVENTOS*", permission: "public",
    options: [
      { label: "Criar evento", command: "criar evento" },
      { label: "Editar evento", command: "editar evento" },
      { label: "Publicar evento", command: "publicar evento" },
      { label: "Cancelar evento", command: "cancelar evento" },
      { label: "Finalizar evento", command: "finalizar evento" },
      { label: "Arquivar evento", command: "arquivar evento" },
      { label: "Ver agendados", command: "eventos agendados" },
      { label: "Histórico", command: "historico eventos" },
      { label: "Sair", command: "sair" }
    ]
  },
  admin: {
    id: "admin", title: "🛡️ *ADMINISTRAÇÃO*", permission: "admin",
    options: [
      { label: "Segurança", aliases: ["protecao", "proteção"], menuId: "admin.security", permission: "admin" },
      { label: "Marcar Todos", info: "Use: !todos mensagem", permission: "admin" },
      { label: "Warn", info: "Em desenvolvimento.", permission: "admin" },
      { label: "Ban", info: "Em desenvolvimento.", permission: "admin" },
      { label: "Sincronizar", command: "sync", permission: "admin" },
      { label: "Configurar Grupo", menuId: "config", permission: "admin" },
      { label: "Logs", info: "Em desenvolvimento.", permission: "admin" }
    ]
  },
  config: {
    id: "config", title: "⚙️ *CONFIGURAÇÕES DO GRUPO*", permission: "admin", backMenuId: "admin",
    options: ["Boas-vindas", "Anti-spam", "Anti-flood", "Regras", "Quiz", "Raids", "Eventos"]
      .map((label) => ({ label, info: "Em desenvolvimento.", permission: "admin" }))
  },
  "admin.security": {
    id: "admin.security", title: "🛡️ *SEGURANÇA*", permission: "admin", backMenuId: "admin",
    options: [
      {
        label: "Sobre esta área",
        aliases: ["informacoes", "informações"],
        info: [
          "🛡️ *SEGURANÇA*",
          "",
          "Esta área reunirá futuramente:",
          "",
          "• Antilink",
          "• Advertências",
          "• Banimentos",
          "• Aprovação de links",
          "",
          "Nenhuma configuração foi alterada."
        ].join("\n"),
        permission: "admin"
      }
    ]
  }
};

function createMenuRegistry(options = {}) {
  const sessionService = options.sessionService || menuSessionServiceDefault;
  const permissionService = options.permissionService || permissionServiceDefault;
  const definitions = options.definitions || DEFINITIONS;

  function hasPermission(role, permission = "public") {
    if (permission === "public") return true;
    if (!role) return false;
    if (permission === "admin") return permissionService.hasPermission(role, { adminOnly: true });
    if (permission === "owner") return permissionService.hasPermission(role, { ownerOnly: true });
    if (permission === "protectedOwner") return permissionService.hasPermission(role, { protectedOwnerOnly: true });
    return false;
  }

  async function resolveRole(client, msg, loaderContext = {}) {
    if (loaderContext.role) return loaderContext.role;
    let contact = loaderContext.contact || null;
    let chat = loaderContext.chat || null;
    try { if (!contact && msg?.getContact) contact = await msg.getContact(); } catch (_) { contact = null; }
    try { if (!chat && !loaderContext.chatAttempted && msg?.getChat) chat = await msg.getChat(); }
    catch (_) { chat = null; whatsappWarningLimiter.warn("menuRegistry", "getChat"); }
    return permissionService.resolveRole({ client, msg, contact, chat, identity: loaderContext.identity });
  }

  function visibleOptions(definition, role) {
    return definition.options.filter((option) => hasPermission(role, option.permission || "public"));
  }

  function parentMenuId(menuId) {
    const definition = definitions[menuId];
    return definition?.backMenuId || (menuId === "main" ? null : "main");
  }

  async function openMenu(menuId, context, role = null, navigation = {}) {
    if (!isCompletePlatformContext(context)) return { status: "ignored" };
    const definition = definitions[menuId];
    if (!definition) throw new Error(`Menu não registrado: ${menuId}.`);
    if (!hasPermission(role, definition.permission || "public")) {
      await context.replyText("❌ Você não tem permissão para acessar este menu.");
      return { status: "denied" };
    }
    const visible = visibleOptions(definition, role);
    const options = {};
    visible.forEach((option, index) => { options[String(index + 1)] = { ...option }; });
    const inheritedStack = Array.isArray(navigation.stack)
      ? navigation.stack
      : navigation.fromSession
        ? [...(navigation.fromSession.stack || []), navigation.fromSession.menuId]
        : [];
    const canGoBack = inheritedStack.length > 0 || Boolean(parentMenuId(menuId));
    const session = await sessionService.openMenu(context, {
      menuId,
      origin: context.isGroup ? "group" : "private",
      targetGroupId: navigation.targetGroupId ?? null,
      stack: inheritedStack, options
    });
    const text = [
      definition.title, "",
      ...visible.map((option, index) => `${index + 1}️⃣ ${option.label}`),
      canGoBack ? "0️⃣ Voltar" : "0️⃣ Fechar",
      "",
      "Responda com o número ou nome da opção."
    ].join("\n");
    await context.replyText(text);
    return { status: "opened", session, text, options, canGoBack };
  }

  async function openMenuFromCommand(menuId, client, msg, loaderContext = {}) {
    let context = loaderContext.platformContext;
    if (!isCompletePlatformContext(context)) {
      try { context = await createPlatformContext(client, msg); }
      catch (_) { return { status: "ignored" }; }
    }
    if (!isCompletePlatformContext(context)) return { status: "ignored" };
    const role = await resolveRole(client, msg, loaderContext);
    return openMenu(menuId, context, role);
  }

  return { getMenu: (id) => definitions[id] || null, openMenu, openMenuFromCommand, hasPermission, resolveRole, visibleOptions, parentMenuId, definitions };
}

const registry = createMenuRegistry();
module.exports = { ...registry, createMenuRegistry, DEFINITIONS };
