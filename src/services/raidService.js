const raidRepository = require("../repositories/raidRepository");
const registrationServiceDefault = require("./registrationService");
const identityServiceDefault = require("./identityService");
const pokemonDataDefault = require("./pokemonDataService");
const raidPokemonCatalogDefault = require("./raidPokemonCatalogService");
const {
  getQuotedMessageSafe,
  resolveOfficialMessageId,
  describeOfficialMessageIdShape
} = require("./whatsappClientHealthService");

class RaidResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RaidResolutionError";
    this.code = code;
  }
}

function normalizeUserId(value) {
  if (!value) return "";
  const serialized = typeof value === "object"
    ? value._serialized || value.user || ""
    : String(value);
  const normalized = serialized.trim().toLowerCase();
  if (!normalized) return "";

  const [rawUser, rawDomain] = normalized.split("@");
  const user = rawUser.split(":")[0];
  if (!rawDomain || rawDomain === "c.us" || rawDomain === "s.whatsapp.net") return user;
  if (rawDomain === "lid") return `${user}@lid`;
  return `${user}@${rawDomain}`;
}

function createRaidService(repository = raidRepository, registrationService = registrationServiceDefault, identityService = identityServiceDefault, serviceOptions = {}) {
  const clock = serviceOptions.clock || (() => new Date());
  const pokemonData = serviceOptions.pokemonDataService || pokemonDataDefault;
  const pokemonCatalog = serviceOptions.raidPokemonCatalogService || raidPokemonCatalogDefault;
  const duplicateWindowMs = Number.isFinite(serviceOptions.duplicateWindowMs)
    ? Math.max(0, serviceOptions.duplicateWindowMs)
    : 15 * 60 * 1000;
  const publishLog = serviceOptions.publishLog || (value => console.log(`[RAID_PUBLISH] ${value}`));
  const messageIdShapeLog = serviceOptions.messageIdShapeLog ||
    (value => console.log(`[MSG_ID_SHAPE] ${value}`));
  const joinLog = serviceOptions.joinLog || (value => console.log(`[RAID_JOIN] ${value}`));
  const identityLog = serviceOptions.identityLog ||
    (value => console.log(`[RAID_IDENTITY] ${value}`));
  const quoteLog = serviceOptions.quoteLog ||
    (value => console.log(`[RAID_QUOTE] ${value}`));
  function logLookup(raid, groupId, stage) {
    const publicationFound = Boolean(
      Array.isArray(raid?.publications) &&
      raid.publications.some(item => item.groupId === groupId)
    );
    joinLog(`activeRaidFound=${Boolean(raid)}`);
    joinLog(`publicationFound=${publicationFound}`);
    joinLog(`lookupStage=${stage}`);
  }
  async function loadRegistrations() { return registrationService.listRegistrations(); }
  function registrationKey(registration) {
    return registration?.registrationId ||
      identityService.normalizeUserId(registration?.primaryIdentity) ||
      "";
  }

  async function findRegistrationMatches(candidates) {
    const candidateSet = new Set(
      (candidates || []).map(identityService.normalizeUserId).filter(Boolean)
    );
    if (!candidateSet.size) return [];

    const registrations = typeof registrationService.listRegistrations === "function"
      ? await registrationService.listRegistrations()
      : [];
    let matches = (registrations || []).filter(registration => {
      const aliases = [
        registration.primaryIdentity,
        ...(registration.identityAliases || [])
      ].map(identityService.normalizeUserId).filter(Boolean);
      return aliases.some(alias => candidateSet.has(alias));
    });

    // Compatibilidade com serviços injetados que oferecem apenas consulta exata.
    if (!registrations?.length && typeof registrationService.getRegistrationByIdentity === "function") {
      const queried = await Promise.all([...candidateSet].map(candidate =>
        registrationService.getRegistrationByIdentity(candidate)
      ));
      matches = queried.filter(Boolean);
    }

    return [...new Map(matches.map(item => [registrationKey(item) || item, item])).values()];
  }

  async function findRegistration(candidates) {
    const matches = await findRegistrationMatches(candidates);
    return matches.length === 1 ? matches[0] : null;
  }

  function registrationAliases(registration) {
    return [
      registration?.primaryIdentity,
      ...(registration?.identityAliases || [])
    ].flatMap(identityService.collectCanonicalIdentityCandidates).filter(Boolean);
  }

  async function resolveSafeRegistration(authorCandidates) {
    const registrations = typeof registrationService.listRegistrations === "function"
      ? await registrationService.listRegistrations()
      : [];
    const candidates = new Set(authorCandidates);
    const exactMatches = (registrations || []).filter(registration =>
      identityService.collectCanonicalIdentityCandidates(registration.primaryIdentity)
        .some(identity => candidates.has(identity))
    );
    const exactKeys = new Set(exactMatches.map(registrationKey));
    const aliasMatches = (registrations || []).filter(registration =>
      !exactKeys.has(registrationKey(registration)) &&
      registrationAliases(registration).some(identity => candidates.has(identity))
    );
    const registration = exactMatches.length === 1
      ? exactMatches[0]
      : exactMatches.length === 0 && aliasMatches.length === 1
        ? aliasMatches[0]
        : null;

    return { registration, exactMatches, aliasMatches };
  }

  async function resolveUserIdentity(msg) {
    let contact = null;
    if (typeof msg?.getContact === "function") {
      try { contact = await msg.getContact(); } catch (_) { contact = null; }
    }

    const resolved = await identityService.resolveIdentity(msg, contact);
    const isGroup = String(msg?.from || "").endsWith("@g.us");
    const authoritativeSource = isGroup ? msg?.author : msg?.from;
    const authorCandidates = identityService.collectCanonicalIdentityCandidates(
      authoritativeSource,
      msg?._data?.author,
      msg?._data?.participant,
      msg?.id?.participant
    );
    const candidates = authorCandidates.length
      ? authorCandidates
      : [...new Set((resolved.candidates || []).filter(Boolean))];
    const { registration, exactMatches, aliasMatches } =
      await resolveSafeRegistration(candidates);
    const ambiguous = exactMatches.length > 1 ||
      (exactMatches.length === 0 && aliasMatches.length > 1);
    const id = registration
      ? identityService.normalizeUserId(registration.primaryIdentity)
      : candidates[0] || resolved.id;
    const name = await resolveParticipantPublicName(id, {
      registration,
      contact,
      msg,
      expectedRegistrationKey: registrationKey(registration)
    });
    const participantCanonical = Boolean(
      registration &&
      identityService.identitiesMatch(id, registration.primaryIdentity)
    );

    identityLog(`exactRegistrationMatches=${exactMatches.length}`);
    identityLog(`aliasRegistrationMatches=${aliasMatches.length}`);
    identityLog(`participantCanonical=${participantCanonical}`);
    identityLog("cacheUsed=false");

    return {
      id,
      candidates,
      registration,
      name,
      ambiguous,
      errorCode: ambiguous ? "identity_ambiguous" : !resolved.id ? "identity_unresolved" : null
    };
  }

  function validateResolvedRaid(raid, groupId) {
    if (!raid) {
      throw new RaidResolutionError(
        "RAID_NOT_FOUND",
        "❌ Raid não encontrada.\n\nConfira o ID e tente novamente.\nExemplo: !lista R1042"
      );
    }
    if (!isRaidCurrentlyActive(raid)) {
      throw new RaidResolutionError(
        "RAID_NOT_PUBLISHED",
        "❌ Esta Raid não está publicada e ativa."
      );
    }
    const belongs = Array.isArray(raid.publications) && raid.publications.length
      ? raid.publications.some(item => item.groupId === groupId)
      : raid.groupId === groupId || raid.primaryGroupId === groupId;
    if (!belongs) {
      throw new RaidResolutionError(
        "RAID_GROUP_MISMATCH",
        "❌ Esta raid não pertence a este grupo."
      );
    }
    return raid;
  }

  function isRaidCurrentlyActive(raid, now = Date.now()) {
    if (!raid || raid.status !== "published") return false;
    const expiresAt = Date.parse(raid.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= now) return false;
    const remainingMinutes = Number(raid.remainingMinutes);
    if (Number.isFinite(remainingMinutes) && remainingMinutes > 0) {
      const reference = Date.parse(raid.publishedAt || raid.createdAt);
      if (Number.isFinite(reference) &&
          reference + remainingMinutes * 60 * 1000 <= now) return false;
    }
    return true;
  }

  function parseRaidId(args = []) {
    const tokens = (args || []).map(value => String(value || "").trim()).filter(Boolean);
    if (!tokens.length) return null;
    if (/^raid$/i.test(tokens[0])) tokens.shift();
    if (tokens.length !== 1 || !/^r\d+$/i.test(tokens[0])) return "";
    return tokens[0].toUpperCase();
  }

  async function resolveRaid(msg, args = []) {
    const groupId = typeof msg?.from === "string" && msg.from.endsWith("@g.us")
      ? msg.from
      : null;
    if (!groupId) {
      throw new RaidResolutionError(
        "GROUP_ONLY",
        "❌ Este comando só pode ser usado em grupos."
      );
    }

    const informedId = parseRaidId(args);
    if (informedId === "") {
      throw new RaidResolutionError(
        "RAID_NOT_FOUND",
        "❌ Raid não encontrada.\n\nConfira o ID e tente novamente.\nExemplo: !lista R1042"
      );
    }
    if (informedId) {
      const informedRaid = repository.getRaidById(informedId);
      logLookup(informedRaid, groupId, "join");
      return validateResolvedRaid(informedRaid, groupId);
    }

    const hasQuotedMessage = typeof msg.hasQuotedMsg === "function"
      ? await msg.hasQuotedMsg()
      : Boolean(msg.hasQuotedMsg);

    quoteLog(`hasQuoted=${hasQuotedMessage}`);
    if (hasQuotedMessage) {
      const directQuotedIdPresent = Boolean(msg?._data?.quotedMsg &&
        resolveOfficialMessageId(msg._data.quotedMsg));
      quoteLog(`directQuotedIdPresent=${directQuotedIdPresent}`);
      const quoted = await getQuotedMessageSafe(msg, { allowIdOnly: true });
      quoteLog(`getQuotedAttempted=${quoted.source !== "direct"}`);
      quoteLog(`getQuotedSucceeded=${Boolean(quoted.quotedMessage)}`);
      quoteLog(`officialMessageIdResolved=${Boolean(quoted.messageId)}`);
      quoteLog(`source=${quoted.source || "none"}`);
      quoteLog(`errorCode=${quoted.errorCode || "none"}`);
      if (!quoted.ok || !quoted.messageId) {
        quoteLog("publicationFound=false");
        throw new RaidResolutionError(
          "QUOTED_MESSAGE_UNAVAILABLE",
          "❌ Não foi possível consultar a mensagem respondida agora."
        );
      }
      const quotedRaid = repository.findRaidByMessageId(quoted.messageId);
      quoteLog(`publicationFound=${Boolean(quotedRaid)}`);
      logLookup(quotedRaid, groupId, "join");
      return validateResolvedRaid(quotedRaid, groupId);
    }

    const publishedRaids = repository.getPublishedRaidByGroup(groupId)
      .filter(raid => isRaidCurrentlyActive(raid));
    logLookup(publishedRaids[0] || null, groupId, "join");
    if (publishedRaids.length === 1) return publishedRaids[0];
    if (publishedRaids.length > 1) {
      throw new RaidResolutionError(
        "MULTIPLE_RAIDS",
        "⚠️ Existem várias Raids ativas neste grupo.\n\n" +
        "Responda à mensagem da Raid desejada ou use:\n!vou R1042"
      );
    }

    throw new RaidResolutionError(
      "NO_PUBLISHED_RAID",
      "⚠️ Não há raid publicada ativa neste grupo."
    );
  }

  async function resolveParticipantPublicName(participantId, options = {}) {
    identityLog("cacheUsed=false");
    let registration = options.registration || null;
    if (!registration) {
      const matches = await findRegistrationMatches([participantId]);
      registration = matches.length === 1 ? matches[0] : null;
    }
    identityLog(`publicRegistrationSame=${Boolean(
      registration &&
      (!options.expectedRegistrationKey ||
        registrationKey(registration) === options.expectedRegistrationKey)
    )}`);
    const nickname = identityService.validPublicName(
      registration?.mainAccount?.nick || registration?.nick
    );
    if (nickname) {
      identityLog("publicNameSource=main_nick");
      return nickname;
    }
    const registeredName = identityService.validPublicName(registration?.name || registration?.nome);
    if (registeredName) {
      identityLog("publicNameSource=registered_name");
      return registeredName;
    }
    const resolved = await identityService.resolveDisplayName(participantId, {
      registrationService,
      msg: options.msg,
      contact: options.contact,
      displayName: options.displayName
    });
    const source = resolved === "Treinador" ? "fallback" : "contact_name";
    identityLog(`publicNameSource=${source}`);
    return resolved;
  }

  async function getParticipantName(participantId, options = {}) {
    return resolveParticipantPublicName(participantId, options);
  }

  function findExistingParticipant(raid, identity) {
    const candidates = new Set(
      [identity?.id, ...(identity?.candidates || [])]
        .map(normalizeUserId)
        .filter(Boolean)
    );
    return raid.participants.find(participantId =>
      candidates.has(normalizeUserId(participantId))
    ) || null;
  }

  async function senderId(message) {
    let contact = null;
    if (typeof message?.getContact === "function") {
      try { contact = await message.getContact(); } catch (_) { contact = null; }
    }
    const source = contact?.number || contact?.id?._serialized || message?.author || message?.from || "";
    return identityService.normalizeUserId(source);
  }

  async function createRaidFromMessage(message, input = {}) {
    const informedName = String(input.name || "").trim();
    let officialPokemon = input.pokemonId
      ? pokemonData.getPokemonByNumber?.(input.pokemonId)
      : pokemonData.resolvePokemon?.(informedName) || pokemonData.getPokemonByName?.(informedName);
    let canonicalName = informedName;
    if (!officialPokemon) {
      const catalog = pokemonCatalog.resolveDetailed?.(informedName);
      if (catalog?.status === "resolved") {
        canonicalName = catalog.value;
        const baseName = canonicalName
          .replace(/^(?:mega|dynamax|gigantamax|shadow)\s+/i, "")
          .replace(/\s+[xy]$/i, "")
          .trim();
        officialPokemon = pokemonData.resolvePokemon?.(baseName) || pokemonData.getPokemonByName?.(baseName);
      } else if (catalog?.status === "ambiguous") {
        throw new RaidResolutionError("POKEMON_AMBIGUOUS", "⚠️ Selecione uma das formas sugeridas no fluxo guiado.");
      } else {
        throw new RaidResolutionError("POKEMON_NOT_FOUND", "❌ Pokémon não encontrado.");
      }
    }
    const name = String(canonicalName || officialPokemon?.nome || "").trim().toLowerCase();
    if (!name) throw new RaidResolutionError("RAID_NAME_REQUIRED", "❌ Informe o Pokémon da Raid.");
    const groupId = String(input.groupId || message?.from || "").trim();
    const creatorId = await senderId(message);
    const targetGroupIds = [...new Set(
      (Array.isArray(input.destinationGroupIds) && input.destinationGroupIds.length
        ? input.destinationGroupIds
        : [groupId]).map(value => String(value || "").trim()).filter(Boolean)
    )].sort();
    const normalizedCoordinates = String(input.coordinates || "").trim();
    const normalizedStartTime = String(input.startTime || "").trim();
    const normalizedRemainingMinutes = Number.isInteger(input.remainingMinutes) ? input.remainingMinutes : null;
    const sameTargets = raid => {
      const existing = [...new Set(
        (Array.isArray(raid.targetGroupIds) && raid.targetGroupIds.length
          ? raid.targetGroupIds
          : raid.publishedGroupIds?.length
            ? raid.publishedGroupIds
            : [raid.primaryGroupId || raid.groupId]).filter(Boolean)
      )].sort();
      return JSON.stringify(existing) === JSON.stringify(targetGroupIds);
    };
    const now = clock();
    const startsAt = (() => {
      const match = /^(\d{1,2}):(\d{2})$/.exec(normalizedStartTime);
      if (!match) return null;
      const value = new Date(now.getTime());
      value.setHours(Number(match[1]), Number(match[2]), 0, 0);
      return value.toISOString();
    })();
    const expiresAt = normalizedRemainingMinutes && normalizedRemainingMinutes > 0
      ? new Date(now.getTime() + normalizedRemainingMinutes * 60 * 1000).toISOString()
      : null;
    const duplicate = repository.listActiveRaids(groupId).find(raid =>
      raid.name === name &&
      sameTargets(raid) &&
      String(raid.coordinates || "").trim() === normalizedCoordinates &&
      String(raid.startTime || "").trim() === normalizedStartTime &&
      (Number.isInteger(raid.remainingMinutes) ? raid.remainingMinutes : null) === normalizedRemainingMinutes &&
      Number.isFinite(Date.parse(raid.createdAt)) &&
      now.getTime() - Date.parse(raid.createdAt) <= duplicateWindowMs
    );
    if (duplicate) {
      logLookup(duplicate, groupId, "create");
      return { raid: duplicate, created: false };
    }
    const raid = repository.createRaid({
      name, groupId, primaryGroupId: groupId, targetGroupIds, creatorId, participants: [], status: "active",
      coordinates: input.coordinates, startTime: input.startTime,
      remainingMinutes: input.remainingMinutes, startsAt, expiresAt,
      pokemonId: officialPokemon?.numero || input.pokemonId || null,
      nomeOficial: officialPokemon?.nome || input.nomeOficial || canonicalName,
      pokemonTypes: officialPokemon?.tipo || input.pokemonTypes || []
    });
    logLookup(raid, groupId, "create");
    return { raid, created: true };
  }

  async function formatCreatedRaid(raid) {
    let list = `🔥 *RAID: ${String(raid.nomeOficial || raid.name || "").toUpperCase()}* 🔥\n🆔 *ID:* ${raid.id}\n`;
    if (raid.pokemonTypes?.length) list += `🏷️ Tipo(s): ${raid.pokemonTypes.join(" / ")}\n`;
    list += "\n👤 *LISTA DE TREINADORES:*\n";
    const names = await Promise.all((raid.participants || []).map(getParticipantName));
    names.forEach((name, index) => { list += `${index + 1}. ${name}\n`; });
    if (!names.length) list += "Nenhum participante confirmado.\n";
    return list;
  }

  async function formatPublication(raid) {
    const names = await Promise.all((raid.participants || []).map(getParticipantName));
    return [
      `⚔️ *RAID ${raid.id}*`, "",
      `👾 Pokémon: ${String(raid.name || raid.nomeOficial || "").split(" ").map(part => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ")}`,
      raid.pokemonTypes?.length ? `🏷️ Tipo(s): ${raid.pokemonTypes.join(" / ")}` : null,
      raid.coordinates ? `📍 Coordenadas: ${raid.coordinates}` : null,
      raid.startTime ? `🕒 Início: ${raid.startTime}` : null,
      raid.remainingMinutes ? `⏱️ Restante: ${raid.remainingMinutes} minutos` : null,
      "", "👤 *LISTA DE TREINADORES:*",
      ...(names.length ? names.map((name, index) => `${index + 1}. ${name}`) : ["Nenhum participante confirmado."]),
      "", "Para participar, responda esta mensagem com:", "✅ !vou", "❌ !desistir", "📋 !lista"
    ].filter(value => value !== null).join("\n");
  }

  async function publishRaidToGroups(client, raidOrId, destinations, options = {}) {
    const raid = typeof raidOrId === "string" ? repository.getRaidById(raidOrId) : raidOrId;
    if (!raid) throw new RaidResolutionError("RAID_NOT_FOUND", "❌ Raid não encontrada.");
    const unique = [...new Map((destinations || []).filter(Boolean).map(group => {
      const groupId = typeof group === "string" ? group : group.id;
      return [groupId, typeof group === "string" ? { id: groupId, name: "Grupo selecionado" } : group];
    })).values()];
    const successes = [];
    const failures = [];
    for (const group of unique) {
      let sendAttempt = false;
      let sendSucceeded = false;
      let messageIdResolved = false;
      let publishRepositoryCalled = false;
      let publishRepositorySucceeded = false;
      let publicationPersisted = false;
      const emitAudit = () => {
        publishLog(`sendAttempt=${sendAttempt}`);
        publishLog(`sendSucceeded=${sendSucceeded}`);
        publishLog(`messageIdResolved=${messageIdResolved}`);
        publishLog(`publishRepositoryCalled=${publishRepositoryCalled}`);
        publishLog(`publishRepositorySucceeded=${publishRepositorySucceeded}`);
        publishLog(`publicationPersisted=${publicationPersisted}`);
      };
      const current = repository.getRaidById(raid.id) || raid;
      if ((current.publications || []).some(item => item.groupId === group.id)) {
        publicationPersisted = true;
        emitAudit();
        logLookup(current, group.id, "publish");
        successes.push({ ...group, skipped: true });
        continue;
      }
      try {
        const destinationValid = typeof group.id === "string" && group.id.endsWith("@g.us");
        if (!destinationValid) throw new Error("invalid_group_destination");
        let resolvedGroup = group.chat || null;
        if (!resolvedGroup && typeof client?.getChatById === "function") {
          try { resolvedGroup = await client.getChatById(group.id); } catch (_) { resolvedGroup = null; }
        }
        const botCanSend = resolvedGroup?.isReadOnly !== true &&
          (typeof resolvedGroup?.sendMessage === "function" || typeof client?.sendMessage === "function");
        if (!botCanSend) throw new Error("group_send_unavailable");
        if (options.revalidate && !(await options.revalidate(group.id)).ok) throw new Error("group_access_lost");
        const message = await formatPublication(current);
        const sendOptions = {
          waitUntilMsgSent: true,
          extra: { mikaRaidResolveOfficialMessageKey: true }
        };
        sendAttempt = true;
        const sent = typeof resolvedGroup?.sendMessage === "function"
          ? await resolvedGroup.sendMessage(message, sendOptions)
          : await client.sendMessage(group.id, message, sendOptions);
        sendSucceeded = true;
        describeOfficialMessageIdShape(sent).forEach(messageIdShapeLog);
        const messageId = resolveOfficialMessageId(sent);
        messageIdResolved = Boolean(messageId);
        if (!messageId) throw new Error("message_id_unavailable");
        publishRepositoryCalled = true;
        repository.publishRaid(raid.id, { groupId: group.id, messageId, publishedAt: new Date().toISOString() });
        publishRepositorySucceeded = true;
        const persisted = repository.getRaidById(raid.id);
        publicationPersisted = Boolean(
          persisted?.publications?.some(item => item.groupId === group.id && item.messageId === messageId)
        );
        successes.push(group);
      } catch (_) {
        failures.push(group);
      } finally {
        emitAudit();
        logLookup(repository.getRaidById(raid.id), group.id, "publish");
      }
    }
    return { raid: repository.getRaidById(raid.id), successes, failures };
  }

  function formatPublicationResult(result) {
    const lines = [
      "📣 *PUBLICAÇÃO CONCLUÍDA*", "",
      `✅ Publicada em ${result.successes.length} grupo(s)`,
      `⚠️ Falhou em ${result.failures.length} grupo(s)`
    ];
    if (result.successes.length) lines.push("", "Sucesso:", ...result.successes.map(item => `• ${item.name}`));
    if (result.failures.length) lines.push("", "Falha:", ...result.failures.map(item => `• ${item.name}`));
    return lines.join("\n");
  }

  function listActiveRaids(groupId) {
    return repository.listActiveRaids(groupId);
  }

  return {
    loadRegistrations,
    findRegistration,
    findRegistrationMatches,
    resolveUserIdentity,
    resolveRaid,
    parseRaidId,
    isRaidCurrentlyActive,
    getParticipantName,
    resolveParticipantPublicName,
    findExistingParticipant,
    createRaidFromMessage,
    formatCreatedRaid,
    formatPublication,
    publishRaidToGroups,
    formatPublicationResult,
    listActiveRaids
  };
}

const defaultService = createRaidService();

module.exports = {
  ...defaultService,
  createRaidService,
  normalizeUserId,
  RaidResolutionError
};
