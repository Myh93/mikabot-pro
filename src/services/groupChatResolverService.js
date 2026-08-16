"use strict";

const Chat = require("whatsapp-web.js/src/structures/Chat");
const GroupChat = require("whatsapp-web.js/src/structures/GroupChat");

const DEFAULT_TTL_MS = 45 * 1000;

function createGroupChatResolverService(options = {}) {
  const clock = options.clock || (() => Date.now());
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const cache = new Map();

  const cleanClassName = chat => String(chat?.constructor?.name || "unknown").replace(/[^a-z0-9_$-]/gi, "").slice(0, 60) || "unknown";
  function readParticipants(chat) {
    try {
      const participants = chat?.participants;
      return { participants, valid: Array.isArray(participants) && participants.length > 0 };
    } catch (_) {
      return { participants: undefined, valid: false };
    }
  }
  function logStructure(diagnostic, source, chat, refreshSucceeded = false, refreshErrorCode = "none") {
    if (typeof diagnostic !== "function") return;
    const snapshot = readParticipants(chat);
    const type = Array.isArray(snapshot.participants) ? "array" : snapshot.participants === undefined ? "undefined" : "other";
    const metadata = chat?.groupMetadata;
    const metadataParticipants = metadata?.participants;
    const dataMetadata = chat?._data?.groupMetadata;
    const dataParticipants = dataMetadata?.participants;
    const legacyMetadata = chat?.__x_groupMetadata;
    const legacyParticipants = legacyMetadata?.participants;
    const valueType = value => Array.isArray(value) ? "array" : value === undefined ? "undefined" : value === null ? "null" : typeof value;
    const valueCount = value => Array.isArray(value) ? value.length : 0;
    let hasParticipantsProperty = false;
    try { hasParticipantsProperty = Boolean(chat) && "participants" in Object(chat); } catch (_) { hasParticipantsProperty = false; }
    diagnostic(`groupchat resolução source=${source}`);
    diagnostic(`groupchat className=${cleanClassName(chat)}`);
    diagnostic(`groupchat isGroup=${Boolean(chat?.isGroup)}`);
    diagnostic(`groupchat hasParticipantsProperty=${hasParticipantsProperty}`);
    diagnostic(`groupchat participantsType=${type}`);
    diagnostic(`groupchat participantsCount=${Array.isArray(snapshot.participants) ? snapshot.participants.length : 0}`);
    diagnostic(`groupchat hasId=${Boolean(chat?.id)}`);
    diagnostic(`groupchat estrutura hasGroupMetadata=${Boolean(metadata)} groupMetadataType=${valueType(metadata)} metadataHasParticipants=${Boolean(metadata && "participants" in Object(metadata))}`);
    diagnostic(`groupchat estrutura metadataParticipantsType=${valueType(metadataParticipants)} metadataParticipantsCount=${valueCount(metadataParticipants)}`);
    diagnostic(`groupchat estrutura hasData=${Boolean(chat?._data)} dataHasGroupMetadata=${Boolean(dataMetadata)} dataMetadataParticipantsType=${valueType(dataParticipants)} dataMetadataParticipantsCount=${valueCount(dataParticipants)}`);
    diagnostic(`groupchat estrutura hasLegacyGroupMetadata=${Boolean(legacyMetadata)} legacyParticipantsType=${valueType(legacyParticipants)} legacyParticipantsCount=${valueCount(legacyParticipants)}`);
    diagnostic(`groupchat estrutura directParticipantsType=${valueType(snapshot.participants)} directParticipantsCount=${valueCount(snapshot.participants)}`);
    diagnostic("groupchat refreshMethod=none");
    diagnostic(`groupchat refreshSucceeded=${Boolean(refreshSucceeded)}`);
    diagnostic(`groupchat refreshErrorCode=${refreshErrorCode}`);
  }
  function validGroupChat(chat) {
    const snapshot = readParticipants(chat);
    return Boolean(chat?.isGroup) && snapshot.valid;
  }
  function getCached(groupId) {
    const entry = cache.get(groupId);
    if (!entry) return null;
    if (clock() - entry.cachedAt > ttlMs || !validGroupChat(entry.chat)) {
      cache.delete(groupId);
      return null;
    }
    return entry.chat;
  }
  function store(groupId, chat) {
    if (validGroupChat(chat)) cache.set(groupId, { chat, cachedAt: clock() });
  }
  const safeConstructor = value => String(value?.constructor?.name || "unknown").replace(/[^a-z0-9_$-]/gi, "").slice(0, 60) || "unknown";
  const safeKeys = value => {
    try { return Object.keys(Object(value)).map(key => String(key).replace(/[^a-z0-9_$-]/gi, "")).filter(Boolean).slice(0, 80).join(",") || "none"; }
    catch (_) { return "unavailable"; }
  };
  function logReturnedChat(diagnostic, source, chat) {
    if (typeof diagnostic !== "function") return;
    let participantsExists = false;
    try { participantsExists = chat?.participants !== undefined; } catch (_) { participantsExists = false; }
    const id = chat?.id;
    diagnostic(`getchat retorno source=${source} constructor.name=${safeConstructor(chat)}`);
    diagnostic(`getchat retorno source=${source} Object.keys(chat)=${safeKeys(chat)}`);
    diagnostic(`getchat retorno source=${source} typeof chat=${chat === null ? "null" : typeof chat}`);
    diagnostic(`getchat retorno source=${source} chat instanceof GroupChat=${chat instanceof GroupChat}`);
    diagnostic(`getchat retorno source=${source} chat instanceof Chat=${chat instanceof Chat}`);
    diagnostic(`getchat retorno source=${source} chat.id exists=${id !== undefined && id !== null} type=${id === null ? "null" : typeof id} constructor=${safeConstructor(id)} keys=${safeKeys(id)}`);
    diagnostic(`getchat retorno source=${source} chat.isGroup=${Boolean(chat?.isGroup)}`);
    diagnostic(`getchat retorno source=${source} chat.serialize existe=${typeof chat?.serialize === "function"}`);
    diagnostic(`getchat retorno source=${source} chat.groupMetadata existe=${chat?.groupMetadata !== undefined && chat?.groupMetadata !== null}`);
    diagnostic(`getchat retorno source=${source} chat.participants existe=${participantsExists}`);
  }
  const safeErrorName = error => String(error?.name || "Error").replace(/[^a-z0-9_$-]/gi, "").slice(0, 60) || "Error";
  const firstStackLine = error => String(error?.stack || "").split(/\r?\n/, 1)[0] || "unavailable";
  const rawErrorMessage = error => String(error?.message || "unavailable");
  function executionPhase(error) {
    const text = `${String(error?.name || "")} ${String(error?.message || "")} ${firstStackLine(error)}`.toLowerCase();
    if (/evaluation failed|execution context|target closed|session closed|browser|puppeteer|protocol error/.test(text)) {
      return "during_window_WWebJS_getChat";
    }
    if (/not a function|illegal invocation|incompatible receiver|client_missing|method_missing/.test(text)) {
      return "before_window_WWebJS_getChat";
    }
    return "indeterminate";
  }
  function classifyError(error) {
    const code = String(error?.code || "").toLowerCase();
    const message = String(error?.message || "").toLowerCase();
    if (/method.*missing|not a function/.test(message)) return "method_missing";
    if (/illegal invocation|incompatible receiver/.test(message)) return "illegal_invocation";
    if (/evaluation failed|evaluate/.test(message)) return "evaluation_failed";
    if (/wid|invalid.*id|chat.*id/.test(`${code} ${message}`)) return "wid_error";
    if (/execution context|target closed|session closed|browser|page.*closed/.test(message)) return "browser_context_error";
    return "unknown_error";
  }
  function serializeChatId(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && typeof value._serialized === "string") return value._serialized;
    return null;
  }
  function chatMatchesGroupId(chat, groupId) {
    return serializeChatId(chat?.id) === groupId;
  }
  function resolveChatId(message) {
    const candidates = [
      ["from", message?.from],
      ["id_remote", message?.id?.remote],
      ["data_id_remote", message?._data?.id?.remote]
    ];
    for (const [source, raw] of candidates) {
      const serialized = serializeChatId(raw);
      if (serialized?.endsWith("@g.us")) {
        return { value: serialized, source, type: raw && typeof raw === "object" ? "object" : "string" };
      }
    }
    if (typeof message?._getChatId === "function") {
      try {
        const raw = message._getChatId();
        const serialized = serializeChatId(raw);
        if (serialized?.endsWith("@g.us")) return { value: serialized, source: "internal", type: raw && typeof raw === "object" ? "object" : "string" };
      } catch (_) {
        // Método interno é apenas o último fallback e nunca altera a falha segura.
      }
    }
    return { value: null, source: "none", type: "null" };
  }

  async function resolveGroupChatWithParticipants({ message, chat, client, diagnostic } = {}) {
    const chatId = resolveChatId(message);
    const groupId = chatId.value;
    const messageClient = message?.client;
    const clientOriginal = typeof client?.getChatById === "function"
      ? client
      : typeof messageClient?.getChatById === "function"
        ? messageClient
        : client;
    if (typeof diagnostic === "function") {
      diagnostic(`getchat messageMethodAvailable=${typeof message?.getChat === "function"}`);
      diagnostic(`getchat messageConstructor=${safeConstructor(message)}`);
      diagnostic(`getchat messageHasClient=${Boolean(messageClient)}`);
      diagnostic(`getchat clientAvailable=${Boolean(clientOriginal)}`);
      diagnostic(`getchat clientConstructor=${safeConstructor(clientOriginal)}`);
      diagnostic(`getchat clientMethodAvailable=${typeof clientOriginal?.getChatById === "function"}`);
      diagnostic(`getchat chatIdSource=${chatId.source}`);
      diagnostic(`getchat chatIdType=${chatId.type}`);
    }
    if (!groupId) {
      if (typeof diagnostic === "function") {
        diagnostic("getchat messageErrorName=none");
        diagnostic("getchat messageErrorCode=invalid_chat_id");
        diagnostic("getchat clientErrorName=none");
        diagnostic("getchat clientErrorCode=invalid_chat_id");
      }
      return { chat: null, participants: null, source: null, errorCode: "invalid_chat_id" };
    }

    if (validGroupChat(chat)) {
      logStructure(diagnostic, "context_chat", chat);
      store(groupId, chat);
      return { chat, participants: readParticipants(chat).participants, source: "context_chat", errorCode: null };
    }

    const cached = getCached(groupId);
    if (cached) {
      logStructure(diagnostic, "context_chat", cached);
      return { chat: cached, participants: readParticipants(cached).participants, source: "context_chat", errorCode: null, cached: true };
    }

    let messageChat = null;
    let messageError = null;
    if (typeof message?.getChat === "function") {
      if (typeof diagnostic === "function") diagnostic("getchat cadeia=message.getChat phase=before_message_getChat");
      try {
        messageChat = await message.getChat();
        if (typeof diagnostic === "function") diagnostic("getchat cadeia=message.getChat phase=after_window_WWebJS_getChat");
        logReturnedChat(diagnostic, "message_getChat", messageChat);
        if (typeof diagnostic === "function") {
          diagnostic("getchat messageErrorName=none");
          diagnostic("getchat messageErrorCode=none");
        }
      }
      catch (error) {
        messageError = classifyError(error);
        if (typeof diagnostic === "function") {
          diagnostic(`getchat cadeia=message.getChat phase=${executionPhase(error)}`);
          diagnostic(`getchat message err.message=${rawErrorMessage(error)}`);
          diagnostic(`getchat message stack.firstLine=${firstStackLine(error)}`);
          diagnostic(`getchat messageErrorName=${safeErrorName(error)}`);
          diagnostic(`getchat messageErrorCode=${messageError}`);
        }
      }
      logStructure(diagnostic, "message_getChat", messageChat, Boolean(messageChat), messageError || (messageChat ? "none" : "group_chat_fetch_failed"));
      if (validGroupChat(messageChat)) {
        store(groupId, messageChat);
        return { chat: messageChat, participants: readParticipants(messageChat).participants, source: "message_getChat", errorCode: null };
      }
    } else if (typeof diagnostic === "function") {
      messageError = "method_missing";
      diagnostic("getchat messageErrorName=none");
      diagnostic("getchat messageErrorCode=method_missing");
    }

    let clientChat = null;
    let clientError = null;
    if (typeof clientOriginal?.getChatById === "function") {
      if (typeof diagnostic === "function") diagnostic("getchat cadeia=client.getChatById phase=before_client_getChatById");
      try {
        clientChat = await clientOriginal.getChatById(groupId);
        if (typeof diagnostic === "function") diagnostic("getchat cadeia=client.getChatById phase=after_window_WWebJS_getChat");
        logReturnedChat(diagnostic, "client_getChatById", clientChat);
        if (typeof diagnostic === "function") {
          diagnostic("getchat clientErrorName=none");
          diagnostic("getchat clientErrorCode=none");
        }
      }
      catch (error) {
        clientError = classifyError(error);
        if (typeof diagnostic === "function") {
          diagnostic(`getchat cadeia=client.getChatById phase=${executionPhase(error)}`);
          diagnostic(`getchat client err.message=${rawErrorMessage(error)}`);
          diagnostic(`getchat client stack.firstLine=${firstStackLine(error)}`);
          diagnostic(`getchat clientErrorName=${safeErrorName(error)}`);
          diagnostic(`getchat clientErrorCode=${clientError}`);
        }
      }
      logStructure(diagnostic, "client_getChatById", clientChat, Boolean(clientChat), clientError || (clientChat ? "none" : "group_chat_fetch_failed"));
      if (validGroupChat(clientChat)) {
        store(groupId, clientChat);
        return { chat: clientChat, participants: readParticipants(clientChat).participants, source: "client_getChatById", errorCode: null };
      }
    } else if (typeof diagnostic === "function") {
      clientError = clientOriginal ? "method_missing" : "client_missing";
      diagnostic("getchat clientErrorName=none");
      diagnostic(`getchat clientErrorCode=${clientError}`);
    }

    let loadedChatsError = null;
    if (typeof clientOriginal?.getChats === "function") {
      if (typeof diagnostic === "function") diagnostic("getchat cadeia=client.getChats phase=before_client_getChats");
      try {
        const loadedChats = await clientOriginal.getChats();
        if (typeof diagnostic === "function") {
          diagnostic("getchat cadeia=client.getChats phase=after_window_WWebJS_getChats");
          diagnostic(`getchat getChatsArray=${Array.isArray(loadedChats)} getChatsCount=${Array.isArray(loadedChats) ? loadedChats.length : 0}`);
        }
        const loadedGroupChat = Array.isArray(loadedChats)
          ? loadedChats.find(candidate => chatMatchesGroupId(candidate, groupId))
          : null;
        logReturnedChat(diagnostic, "client_getChats", loadedGroupChat);
        logStructure(diagnostic, "client_getChats", loadedGroupChat, Boolean(loadedGroupChat), loadedGroupChat ? "none" : "group_not_found");
        if (validGroupChat(loadedGroupChat)) {
          store(groupId, loadedGroupChat);
          return { chat: loadedGroupChat, participants: readParticipants(loadedGroupChat).participants, source: "client_getChats", errorCode: null };
        }
      } catch (error) {
        loadedChatsError = classifyError(error);
        if (typeof diagnostic === "function") {
          diagnostic(`getchat cadeia=client.getChats phase=${executionPhase(error)}`);
          diagnostic(`getchat getChats err.message=${rawErrorMessage(error)}`);
          diagnostic(`getchat getChats stack.firstLine=${firstStackLine(error)}`);
          diagnostic(`getchat getChatsErrorName=${safeErrorName(error)}`);
          diagnostic(`getchat getChatsErrorCode=${loadedChatsError}`);
        }
      }
    } else if (typeof diagnostic === "function") {
      diagnostic("getchat getChatsErrorName=none");
      diagnostic(`getchat getChatsErrorCode=${clientOriginal ? "method_missing" : "client_missing"}`);
    }

    cache.delete(groupId);
    const lastChat = clientChat || messageChat || chat || null;
    const snapshot = readParticipants(lastChat);
    const errorCode = loadedChatsError || clientError || messageError ||
      (Array.isArray(snapshot.participants) ? "participants_empty" :
        snapshot.participants === undefined ? "participants_property_missing" : "group_metadata_unavailable");
    return { chat: lastChat, participants: null, source: clientChat ? "client_getChatById" : messageChat ? "message_getChat" : "context_chat", errorCode };
  }

  return { resolveGroupChatWithParticipants, clearCache: () => cache.clear(), _cache: cache };
}

const service = createGroupChatResolverService();
module.exports = { ...service, createGroupChatResolverService, DEFAULT_TTL_MS };
