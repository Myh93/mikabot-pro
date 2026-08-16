"use strict";

const guidedFlowDefault = require("./guidedFlowService");
const inputResolverDefault = require("./inputResolverService");
const raidServiceDefault = require("./raidService");
const menuSessionDefault = require("./menuSessionService");
const raidPokemonCatalogDefault = require("./raidPokemonCatalogService");
const raidGroupAccessDefault = require("./raidGroupAccessService");
const pokemonDataDefault = require("./pokemonDataService");

const FLOW_ID = "raid_create";
const LIST_FLOW_ID = "raid_list";
const confirmationLocks = new Set();
const PROMPTS = Object.freeze({
  pokemon: "⚔️ *CRIAR RAID*\n\n👾 Qual é o Pokémon da Raid?\n\nExemplos:\nRayquaza\nMega Gengar\nPikachu",
  coordinates: "📍 Informe as coordenadas da Raid.\n\nExemplo:\n-7.163456,-38.501234",
  startTime: "🕒 Qual é o horário de início da Raid?\n\nExemplo:\n18:30",
  remainingMinutes: "⏱️ Quantos minutos faltam para a Raid terminar?\n\nExemplo:\n45",
  recommendedPlayers: "👥 Quantos jogadores você recomenda para essa Raid?\n\nExemplo:\n5\n\nVocê também pode responder: pular"
});

function createRaidGuidedFlowService(options = {}) {
  const flows = options.guidedFlowService || guidedFlowDefault;
  const inputResolver = options.inputResolverService || inputResolverDefault;
  const raids = options.raidService || raidServiceDefault;
  const pokemonCatalog = options.raidPokemonCatalogService || raidPokemonCatalogDefault;
  const pokemonData = options.pokemonDataService || pokemonDataDefault;
  const groupAccess = options.raidGroupAccessService || raidGroupAccessDefault;
  const menuSessions = options.menuSessionService || menuSessionDefault;
  const authorize = options.authorize || (() => true);
  const confirmLog = options.confirmLog || (value => console.log(`[RAID_CONFIRM] ${value}`));
  const aliasLog = options.aliasLog || (value => console.log(`[RAID_ALIAS] ${value}`));
  const destinationLog = options.destinationLog || (value => console.log(`[RAID_DEST] ${value}`));
  const flowArgs = context => [context.platform || "whatsapp", context.conversationId || context.groupId, context.userId];
  const reply = (context, text) => context.replyText(String(text));

  function actorIdentityFrom(context) {
    const id = context.identity?.id || context.userId || null;
    const candidates = [...new Set([
      id,
      ...(Array.isArray(context.identity?.candidates) ? context.identity.candidates : [])
    ].filter(value => typeof value === "string" && value.trim()))];
    return id ? { id, candidates } : null;
  }

  function actorIdentityFor(context, session) {
    const sessionIdentity = session?.data?.actorIdentity || null;
    const currentIdentity = actorIdentityFrom(context);
    aliasLog(`sessionIdentityUsed=${Boolean(sessionIdentity)}`);
    aliasLog(`currentMessageIdentityUsed=${Boolean(!sessionIdentity && currentIdentity)}`);
    return sessionIdentity || currentIdentity || context.userId;
  }

  function basePokemonName(value) {
    return String(value || "")
      .replace(/^(?:mega|dynamax|gigantamax|shadow)\s+/i, "")
      .replace(/\s+[xy]$/i, "")
      .trim();
  }

  function pokemonMetadata(pokemon, displayName = pokemon?.nome) {
    return {
      displayName,
      pokemonId: pokemon?.numero || null,
      nomeOficial: pokemon?.nome || displayName,
      pokemonTypes: Array.isArray(pokemon?.tipo) ? pokemon.tipo : []
    };
  }

  function resolvePokemonDetailed(value) {
    const raw = String(value || "").trim();
    const official = pokemonData.resolvePokemon?.(raw) ||
      pokemonData.getPokemonByName?.(raw) ||
      (/^\d+$/.test(raw) ? pokemonData.getPokemonByNumber?.(Number(raw)) : null);
    if (official) return { status: "resolved", ...pokemonMetadata(official) };
    const catalog = typeof pokemonCatalog.resolveDetailed === "function"
      ? pokemonCatalog.resolveDetailed(raw)
      : { status: pokemonCatalog.resolve(raw) ? "resolved" : "invalid", value: pokemonCatalog.resolve(raw), options: [] };
    if (catalog.status === "ambiguous") return { status: "ambiguous", options: catalog.options || [] };
    if (catalog.status === "resolved" && catalog.value) {
      const baseName = basePokemonName(catalog.value);
      const base = pokemonData.resolvePokemon?.(baseName) || pokemonData.getPokemonByName?.(baseName);
      return { status: "resolved", ...pokemonMetadata(base, catalog.value) };
    }
    const suggestions = (pokemonData.suggestPokemon?.(raw, 3) || []).map(item => item.nome);
    return suggestions.length
      ? { status: "suggestions", options: suggestions }
      : { status: "invalid", options: [] };
  }

  function resolvePokemon(value) {
    const result = resolvePokemonDetailed(value);
    return result.status === "resolved" ? result.displayName : null;
  }

  function pokemonAmbiguityPrompt(options, mode = "form") {
    return [
      mode === "suggestion" ? "Você quis dizer:" : "⚠️ Qual forma deseja?", "",
      ...options.map((name, index) => `${index + 1}️⃣ ${name}`),
      "0️⃣ Cancelar"
    ].join("\n");
  }

  function parseCoordinates(value) {
    const match = String(value || "").trim().match(/^([+-]?(?:\d+(?:\.\d+)?))\s*(?:,|\s)\s*([+-]?(?:\d+(?:\.\d+)?))$/);
    if (!match) return null;
    const latitude = Number(match[1]), longitude = Number(match[2]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
    return `${match[1]},${match[2]}`;
  }

  function parseTime(value) {
    const match = String(value || "").trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    return match ? `${match[1]}:${match[2]}` : null;
  }

  function parsePositiveInteger(value, maximum) {
    const raw = String(value || "").trim();
    if (!/^\d+$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null;
  }

  function review(data) {
    return [
      "⚔️ *CONFIRME A RAID*", "",
      `👾 Pokémon: ${data.pokemon}`,
      data.pokemonTypes?.length ? `🏷️ Tipo(s): ${data.pokemonTypes.join(" / ")}` : null,
      `📍 Coordenadas: ${data.coordinates}`,
      `🕒 Início: ${data.startTime}`,
      `⏱️ Restante: ${data.remainingMinutes} minutos`,
      `👥 Jogadores recomendados: ${data.recommendedPlayers || "Não informado"}`, "",
      "1️⃣ Confirmar", "2️⃣ Editar", "3️⃣ Cancelar"
    ].filter(value => value !== null).join("\n");
  }

  const editPrompt = ["✏️ *EDITAR RAID*", "", "1️⃣ Pokémon", "2️⃣ Coordenadas", "3️⃣ Horário", "4️⃣ Tempo restante", "5️⃣ Jogadores recomendados", "0️⃣ Voltar"].join("\n");
  const destinationPrompt = ["📣 *ONDE DESEJA PUBLICAR?*", "", "1️⃣ Um grupo", "2️⃣ Vários grupos", "3️⃣ Todos os grupos autorizados", "0️⃣ Cancelar"].join("\n");
  const listModePrompt = ["📋 *COMO DESEJA CONSULTAR?*", "", "1️⃣ Um grupo", "2️⃣ Vários grupos", "3️⃣ Todos os grupos permitidos", "0️⃣ Cancelar"].join("\n");

  function groupPrompt(groups, multiple = false) {
    return [
      "👥 *ESCOLHA O GRUPO*", "",
      ...groups.map((group, index) => `${index + 1}️⃣ ${group.name}`), "",
      multiple ? "Envie os números separados por vírgula, espaço ou ponto e vírgula." : "Envie o número ou nome exato.",
      "0️⃣ Cancelar"
    ].join("\n");
  }

  function selectionPrompt(groups, all = false) {
    return [
      all ? `⚠️ Você selecionou ${groups.length} grupos autorizados.` : "✅ *GRUPOS SELECIONADOS*",
      "", ...groups.map(group => `• ${group.name}`), "",
      "1️⃣ Confirmar", "2️⃣ Alterar", "3️⃣ Cancelar"
    ].join("\n");
  }

  function parseGroupSelection(text, groups, multiple) {
    const normalized = inputResolver.normalizeInput(text);
    if (!multiple) {
      const numeric = Number(normalized);
      if (Number.isInteger(numeric) && numeric >= 1 && numeric <= groups.length) return [groups[numeric - 1]];
      const matches = groups.filter(group =>
        inputResolver.normalizeInput(group.name) === normalized ||
        (group.aliases || []).some(alias => inputResolver.normalizeInput(alias) === normalized)
      );
      return matches.length === 1 ? matches : null;
    }
    const tokens = String(text || "").trim().split(/[\s,;]+/).filter(Boolean);
    if (!tokens.length) return null;
    const positions = [];
    for (const token of tokens) {
      const range = token.match(/^(\d+)-(\d+)$/);
      if (range) {
        const start = Number(range[1]), end = Number(range[2]);
        if (start > end || start < 1 || end > groups.length) return null;
        for (let index = start; index <= end; index += 1) positions.push(index);
      } else if (/^\d+$/.test(token)) positions.push(Number(token));
      else return null;
    }
    if (positions.some(position => position < 1 || position > groups.length)) return null;
    return [...new Set(positions)].map(position => groups[position - 1]);
  }

  function formatRaidGroups(groups) {
    const sections = [];
    for (const group of groups) {
      const active = raids.listActiveRaids ? raids.listActiveRaids(group.id) : [];
      sections.push(`⚔️ *RAIDS — ${group.name.toUpperCase()}*`, "");
      if (!active.length) sections.push("• Nenhuma Raid ativa.");
      else active.forEach(raid => sections.push(`• ${raid.id} — ${raid.name} — ${raid.startTime || "horário não informado"}`));
      sections.push("");
    }
    return sections.join("\n").trim();
  }

  function promptFor(session) {
    if (session.step === "review") return review(session.data);
    if (session.step === "edit_select") return editPrompt;
    if (session.step === "destination_mode") return destinationPrompt;
    if (session.step === "pokemon_ambiguity") return pokemonAmbiguityPrompt(session.data.pokemonOptions || [], session.data.pokemonOptionMode);
    if (session.step === "list_mode") return listModePrompt;
    if (session.step === "select_group") return groupPrompt(session.data.groups || [], false);
    if (session.step === "select_groups") return groupPrompt(session.data.groups || [], true);
    if (session.step === "list_select_group") return groupPrompt(session.data.groups || [], false);
    if (session.step === "list_select_groups") return groupPrompt(session.data.groups || [], true);
    if (session.step === "destination_confirm" || session.step === "list_confirm") return selectionPrompt(session.data.selectedGroups || [], session.data.selectionMode === "all");
    if (session.step.startsWith("edit_")) return PROMPTS[session.step.slice(5)];
    return PROMPTS[session.step] || PROMPTS.pokemon;
  }

  async function start(context) {
    if (!await authorize(context)) { await reply(context, "❌ Você não tem permissão para criar uma Raid."); return { status: "denied" }; }
    const existing = await flows.getActiveFlow(...flowArgs(context));
    if (existing?.flowId === FLOW_ID) {
      await reply(context, promptFor(existing));
      return { status: "resumed", session: existing };
    }
    if (existing) {
      await reply(context, "⚠️ Você já possui outro fluxo em andamento. Continue respondendo ou envie cancelar.");
      return { status: "conflict", session: existing };
    }
    const result = await flows.startFlow({ flowId: FLOW_ID, platform: context.platform || "whatsapp", conversationId: context.conversationId || context.groupId, userId: context.userId, step: "pokemon", data: { isGroup: Boolean(context.isGroup), sourceGroupId: context.isGroup ? context.groupId : null, actorIdentity: actorIdentityFrom(context) } });
    if (result.conflict) return { status: "conflict", session: result.session };
    await menuSessions.closeMenu(context.platform || "whatsapp", context.conversationId || context.groupId, context.userId).catch(() => false);
    await reply(context, PROMPTS.pokemon);
    return { status: "started", session: result.session };
  }

  async function startList(context) {
    if (context.isGroup) return { status: "group_context" };
    const existing = await flows.getActiveFlow(...flowArgs(context));
    if (existing) {
      await reply(context, promptFor(existing));
      return { status: existing.flowId === LIST_FLOW_ID ? "resumed" : "conflict", session: existing };
    }
    let groups;
    try { groups = await groupAccess.listAuthorizedGroups(context.client, context.identity || context.userId); }
    catch (_) { groups = null; }
    if (!groups) { await reply(context, "❌ Não foi possível consultar os grupos agora."); return { status: "error" }; }
    if (!groups.length) { await reply(context, "❌ Nenhum grupo permitido está disponível."); return { status: "empty" }; }
    const result = await flows.startFlow({ flowId: LIST_FLOW_ID, platform: context.platform || "whatsapp", conversationId: context.conversationId || context.groupId, userId: context.userId, step: "list_mode", data: { groups } });
    await menuSessions.closeMenu(context.platform || "whatsapp", context.conversationId || context.groupId, context.userId).catch(() => false);
    await reply(context, listModePrompt);
    return { status: "started", session: result.session };
  }

  async function advance(context, step, changes, prompt = PROMPTS[step]) {
    const session = await flows.advanceFlow(...flowArgs(context), step, changes);
    await reply(context, prompt);
    return { status: "advanced", session };
  }

  async function cancel(context) {
    const active = await flows.getActiveFlow(...flowArgs(context));
    await flows.cancelFlow(...flowArgs(context));
    await reply(context, active?.flowId === LIST_FLOW_ID ? "❌ Consulta de Raids cancelada." : "❌ Criação da Raid cancelada.");
    return { status: "cancelled" };
  }

  async function back(context, session) {
    const previous = await flows.goBack(...flowArgs(context));
    if (!previous || previous.cannotGoBack) {
      await reply(context, promptFor(session));
      return { status: "cannot_go_back", session };
    }
    await reply(context, promptFor(previous));
    return { status: "back", session: previous };
  }

  async function storeField(context, session, field, text, editing = false) {
    let value;
    if (field === "pokemon") {
      const resolved = resolvePokemonDetailed(text);
      if (["ambiguous", "suggestions"].includes(resolved.status)) {
        const mode = resolved.status === "suggestions" ? "suggestion" : "form";
        return advance(context, "pokemon_ambiguity", {
          pokemonOptions: resolved.options,
          pokemonOptionMode: mode
        }, pokemonAmbiguityPrompt(resolved.options, mode));
      }
      value = resolved.displayName;
      if (!value) { await reply(context, "❌ Pokémon não encontrado."); return { status: "validation_error" }; }
      const pokemonChanges = {
        pokemon: value,
        pokemonId: resolved.pokemonId,
        nomeOficial: resolved.nomeOficial,
        pokemonTypes: resolved.pokemonTypes
      };
      if (editing) {
        const updated = await flows.advanceFlow(...flowArgs(context), "review", { ...pokemonChanges, editingField: null });
        await reply(context, review(updated.data));
        return { status: "review", session: updated };
      }
      return advance(context, "coordinates", pokemonChanges);
    } else if (field === "coordinates") {
      value = parseCoordinates(text);
      if (!value) { await reply(context, "❌ Coordenadas inválidas.\n\nEnvie no formato:\n-7.163456,-38.501234"); return { status: "validation_error" }; }
    } else if (field === "startTime") {
      value = parseTime(text);
      if (!value) { await reply(context, "❌ Horário inválido.\n\nEnvie no formato 24 horas:\n18:30"); return { status: "validation_error" }; }
    } else if (field === "remainingMinutes") {
      value = parsePositiveInteger(text, 180);
      if (!value) { await reply(context, "❌ Informe a quantidade de minutos usando apenas números."); return { status: "validation_error" }; }
    } else if (field === "recommendedPlayers") {
      const normalized = inputResolver.normalizeInput(text);
      value = ["pular", "depois", "nao sei"].includes(normalized) ? null : parsePositiveInteger(text, 100);
      if (value === null && !["pular", "depois", "nao sei"].includes(normalized)) { await reply(context, "❌ Informe um número de jogadores ou responda pular."); return { status: "validation_error" }; }
    }
    if (editing) {
      const updated = await flows.advanceFlow(...flowArgs(context), "review", { [field]: value, editingField: null });
      await reply(context, review(updated.data));
      return { status: "review", session: updated };
    }
    const order = ["pokemon", "coordinates", "startTime", "remainingMinutes", "recommendedPlayers"];
    const next = order[order.indexOf(field) + 1];
    if (next) return advance(context, next, { [field]: value });
    const updated = await flows.advanceFlow(...flowArgs(context), "review", { [field]: value });
    await reply(context, review(updated.data));
    return { status: "review", session: updated };
  }

  async function confirm(context, session) {
    if (!await authorize(context)) { await reply(context, "❌ Você não tem mais permissão para criar esta Raid."); return { status: "denied" }; }
    if (!session.data.isGroup) {
      let groups;
      confirmLog(`flowHasGroupSelection=${Array.isArray(session.data.selectedGroups) && session.data.selectedGroups.length > 0}`);
      confirmLog(`selectedGroups=${Array.isArray(session.data.selectedGroups) ? session.data.selectedGroups.length : 0}`);
      confirmLog("callingGroupAccess=true");
      try { groups = await groupAccess.listAuthorizedGroups(context.client, actorIdentityFor(context, session)); }
      catch (_) { groups = null; }
      confirmLog(`groupsReturned=${Array.isArray(groups) ? groups.length : 0}`);
      confirmLog("creatingRaid=false");
      if (!groups) { await reply(context, "❌ Não foi possível consultar os grupos agora."); return { status: "error" }; }
      if (!groups.length) { await reply(context, "❌ Nenhum grupo autorizado está disponível."); return { status: "empty" }; }
      destinationLog("destinationMode=true");
      destinationLog(`selectedGroups=${Array.isArray(session.data.selectedGroups) ? session.data.selectedGroups.length : 0}`);
      destinationLog("publishTargets=0");
      destinationLog("fallbackCurrentGroup=false");
      return advance(context, "destination_mode", { groups }, destinationPrompt);
    }
    destinationLog("destinationMode=false");
    destinationLog("selectedGroups=0");
    destinationLog("publishTargets=1");
    destinationLog("fallbackCurrentGroup=true");
    return finalize(context, session, [{ id: session.data.sourceGroupId, name: "Grupo atual", chat: context.chat }], false);
  }

  async function finalize(context, session, selectedGroups, revalidateGroups = true) {
    const lockKey = flowArgs(context).join(":");
    if (confirmationLocks.has(lockKey)) return { status: "processing" };
    confirmationLocks.add(lockKey);
    try {
      confirmLog(`flowHasGroupSelection=${Array.isArray(selectedGroups) && selectedGroups.length > 0}`);
      confirmLog(`selectedGroups=${Array.isArray(selectedGroups) ? selectedGroups.length : 0}`);
      confirmLog(`callingGroupAccess=${Boolean(revalidateGroups)}`);
      destinationLog(`destinationMode=${Boolean(!session.data.isGroup)}`);
      destinationLog(`selectedGroups=${Array.isArray(selectedGroups) ? selectedGroups.length : 0}`);
      destinationLog(`publishTargets=${Array.isArray(selectedGroups) ? selectedGroups.length : 0}`);
      destinationLog(`fallbackCurrentGroup=${Boolean(session.data.isGroup && !revalidateGroups)}`);
      if (!await authorize(context)) {
        await reply(context, "❌ Você não tem mais permissão para criar esta Raid.");
        return { status: "denied" };
      }
      const allowedGroups = [];
      for (const group of selectedGroups) {
        if (!revalidateGroups) {
          allowedGroups.push(group);
          continue;
        }
        const access = await groupAccess.revalidate(context.client, group.id, actorIdentityFor(context, session));
        if (access.ok) allowedGroups.push({ ...group, chat: access.chat || group.chat });
      }
      confirmLog(`groupsReturned=${allowedGroups.length}`);
      if (!allowedGroups.length) {
        confirmLog("creatingRaid=false");
        await reply(context, "❌ Sua permissão ou participação nos grupos selecionados mudou. Nenhuma Raid foi criada.");
        return { status: "denied" };
      }
      confirmLog("creatingRaid=true");
      const result = await raids.createRaidFromMessage(context.message, {
        name: session.data.pokemon,
        pokemonId: session.data.pokemonId,
        nomeOficial: session.data.nomeOficial,
        pokemonTypes: session.data.pokemonTypes,
        coordinates: session.data.coordinates,
        startTime: session.data.startTime,
        remainingMinutes: session.data.remainingMinutes,
        groupId: allowedGroups[0].id,
        destinationGroupIds: allowedGroups.map(group => group.id)
      });
      const publication = await raids.publishRaidToGroups(context.client, result.raid, allowedGroups, {
        revalidate: revalidateGroups ? groupId => groupAccess.revalidate(context.client, groupId, actorIdentityFor(context, session)) : null
      });
      await flows.finishFlow(...flowArgs(context));
      await reply(context, raids.formatPublicationResult(publication));
      return { status: "created", raid: publication.raid, created: result.created, publication };
    } catch (_) {
      await reply(context, "❌ Não foi possível criar a Raid agora. Revise os dados e tente novamente.");
      return { status: "error" };
    } finally {
      confirmationLocks.delete(lockKey);
    }
  }

  async function handleAnswer(context, text) {
    const session = await flows.getActiveFlow(...flowArgs(context));
    if (!session || ![FLOW_ID, LIST_FLOW_ID].includes(session.flowId)) return { status: "ignored" };
    const navigation = inputResolver.resolveMenuNavigation(text, { canGoBack: true });
    if (navigation === "close") return cancel(context);
    if (navigation === "back") {
      if (session.step === "edit_select") {
        const updated = await flows.updateFlow(...flowArgs(context), { step: "review" });
        await reply(context, review(updated.data));
        return { status: "back", session: updated };
      }
      return back(context, session);
    }
    if (session.flowId === LIST_FLOW_ID) return handleListAnswer(context, session, text);
    if (session.step === "destination_mode") {
      const mode = inputResolver.resolveMenuOption(text, [
        { value: "one", number: 1 }, { value: "many", number: 2 }, { value: "all", number: 3 }
      ]);
      if (!mode) { await reply(context, "❌ Escolha 1, 2 ou 3."); return { status: "validation_error" }; }
      if (mode === "all") return advance(context, "destination_confirm", { selectionMode: "all", selectedGroups: session.data.groups }, selectionPrompt(session.data.groups, true));
      return advance(context, mode === "one" ? "select_group" : "select_groups", { selectionMode: mode }, groupPrompt(session.data.groups, mode === "many"));
    }
    if (session.step === "pokemon_ambiguity") {
      const options = session.data.pokemonOptions || [];
      const selected = inputResolver.resolveMenuOption(text, options.map((name, index) => ({
        value: name,
        number: index + 1,
        aliases: [name]
      })));
      if (!selected) {
        await reply(context, pokemonAmbiguityPrompt(options));
        return { status: "validation_error" };
      }
      const resolved = resolvePokemonDetailed(selected);
      const selectedResolution = resolved.status === "resolved"
        ? resolved
        : session.data.pokemonOptionMode === "form"
          ? pokemonMetadata(
            pokemonData.resolvePokemon?.(basePokemonName(selected)) ||
              pokemonData.getPokemonByName?.(basePokemonName(selected)),
            selected
          )
          : null;
      if (!selectedResolution?.displayName) {
        await reply(context, "❌ Pokémon não encontrado.");
        return { status: "validation_error" };
      }
      return advance(context, "coordinates", {
        pokemon: selectedResolution.displayName,
        pokemonId: selectedResolution.pokemonId,
        nomeOficial: selectedResolution.nomeOficial,
        pokemonTypes: selectedResolution.pokemonTypes,
        pokemonOptions: [],
        pokemonOptionMode: null
      }, PROMPTS.coordinates);
    }
    if (session.step === "select_group" || session.step === "select_groups") {
      const selected = parseGroupSelection(text, session.data.groups, session.step === "select_groups");
      if (!selected?.length) { await reply(context, "❌ Selecione somente opções válidas da lista."); return { status: "validation_error" }; }
      return advance(context, "destination_confirm", { selectedGroups: selected }, selectionPrompt(selected));
    }
    if (session.step === "destination_confirm") {
      const choice = inputResolver.resolveMenuOption(text, [
        { value: "confirm", number: 1, aliases: ["confirmar", "sim"] },
        { value: "alter", number: 2, aliases: ["alterar", "voltar"] },
        { value: "cancel", number: 3, aliases: ["cancelar", "nao"] }
      ]);
      if (choice === "confirm") return finalize(context, session, session.data.selectedGroups, true);
      if (choice === "alter") return advance(context, "destination_mode", { selectedGroups: [] }, destinationPrompt);
      if (choice === "cancel") return cancel(context);
      await reply(context, "❌ Escolha 1 para confirmar, 2 para alterar ou 3 para cancelar.");
      return { status: "validation_error" };
    }
    if (session.step === "review") {
      const choice = inputResolver.resolveMenuOption(text, [
        { value: "confirm", number: 1, aliases: ["confirmar", "sim"] },
        { value: "edit", number: 2, aliases: ["editar"] },
        { value: "cancel", number: 3, aliases: ["cancelar", "nao", "não"] }
      ]);
      if (choice === "confirm") return confirm(context, session);
      if (choice === "edit") return advance(context, "edit_select", {}, editPrompt);
      if (choice === "cancel") return cancel(context);
      await reply(context, "❌ Escolha 1 para confirmar, 2 para editar ou 3 para cancelar.");
      return { status: "validation_error" };
    }
    if (session.step === "edit_select") {
      const field = inputResolver.resolveMenuOption(text, [
        { value: "pokemon", number: 1 }, { value: "coordinates", number: 2 },
        { value: "startTime", number: 3 }, { value: "remainingMinutes", number: 4 },
        { value: "recommendedPlayers", number: 5 }
      ]);
      if (!field) { await reply(context, "❌ Escolha uma opção entre 1 e 5, ou 0 para voltar."); return { status: "validation_error" }; }
      return advance(context, `edit_${field}`, { editingField: field }, PROMPTS[field]);
    }
    if (session.step.startsWith("edit_")) return storeField(context, session, session.step.slice(5), text, true);
    return storeField(context, session, session.step, text, false);
  }

  async function handleListAnswer(context, session, text) {
    if (session.step === "list_mode") {
      const mode = inputResolver.resolveMenuOption(text, [
        { value: "one", number: 1 }, { value: "many", number: 2 }, { value: "all", number: 3 }
      ]);
      if (!mode) { await reply(context, "❌ Escolha 1, 2 ou 3."); return { status: "validation_error" }; }
      if (mode === "all") {
        await flows.finishFlow(...flowArgs(context));
        await reply(context, formatRaidGroups(session.data.groups));
        return { status: "listed", groups: session.data.groups };
      }
      return advance(context, mode === "one" ? "list_select_group" : "list_select_groups", { selectionMode: mode }, groupPrompt(session.data.groups, mode === "many"));
    }
    if (session.step === "list_select_group" || session.step === "list_select_groups") {
      const selected = parseGroupSelection(text, session.data.groups, session.step === "list_select_groups");
      if (!selected?.length) { await reply(context, "❌ Selecione somente opções válidas da lista."); return { status: "validation_error" }; }
      await flows.finishFlow(...flowArgs(context));
      await reply(context, formatRaidGroups(selected));
      return { status: "listed", groups: selected };
    }
    return { status: "ignored" };
  }

  async function hasActiveFlow(context) {
    if (!context?.groupId || !context?.userId) return false;
    const session = await flows.getActiveFlow(...flowArgs(context));
    return [FLOW_ID, LIST_FLOW_ID].includes(session?.flowId);
  }

  return { start, startList, handleAnswer, hasActiveFlow, resolvePokemon, parseCoordinates, parseTime, parsePositiveInteger, parseGroupSelection, review, FLOW_ID, LIST_FLOW_ID };
}

const service = createRaidGuidedFlowService();
module.exports = { ...service, createRaidGuidedFlowService, FLOW_ID, LIST_FLOW_ID };
