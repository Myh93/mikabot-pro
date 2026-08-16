"use strict";

const Message = require("whatsapp-web.js/src/structures/Message");

const state = { checked: false, status: "not_checked", errorCode: null, details: null };

function sanitizeQuotedDiagnostic(value) {
  return String(value || "unavailable")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\b\d{5,}\b/g, "[number]")
    .replace(/\b\S+@(?:lid|c\.us|g\.us)\b/gi, "[id]")
    .replace(/\b(?:true|false)_[^\s]+_[A-Fa-f0-9]{8,}(?:_[^\s]+)?\b/g, "[id]")
    .slice(0, 220);
}

function quotedErrorCode(error) {
  const text = `${error?.name || ""} ${error?.message || ""}`.toLowerCase();
  if (/dataerror|idbobjectstore|no key or key range/.test(text)) return "quoted_message_key_missing";
  if (/invalid serialized message id/.test(text)) return "quoted_message_key_invalid";
  return "quoted_message_lookup_failed";
}

function structuralMessageKey(message) {
  const source = message?._data?.id || message?.id;
  if (!source || typeof source !== "object") return null;
  const serializedWid = value => {
    if (typeof value === "string" && value.trim()) return value;
    if (value && typeof value === "object" && typeof value._serialized === "string" && value._serialized.trim()) {
      return value._serialized;
    }
    return null;
  };
  const remote = serializedWid(source.remote);
  const participant = serializedWid(source.participant);
  const id = typeof source.id === "string" && source.id.trim() ? source.id : null;
  if (!remote || !id || typeof source.fromMe !== "boolean") return null;
  return { fromMe: source.fromMe, remote, id, ...(participant ? { participant } : {}) };
}

function ensureMessageIdSerialized(message) {
  if (!message || (typeof message !== "object" && typeof message !== "function")) {
    return { ok: false, changed: false, serialized: null, errorCode: "message_invalid" };
  }
  const id = message.id;
  if (!id || (typeof id !== "object" && typeof id !== "function")) {
    return { ok: false, changed: false, serialized: null, errorCode: "message_id_missing" };
  }
  if (typeof id._serialized === "string" && id._serialized.trim()) {
    return { ok: true, changed: false, serialized: id._serialized, errorCode: null };
  }
  if (typeof id.toString !== "function") {
    return { ok: false, changed: false, serialized: null, errorCode: "message_id_to_string_unavailable" };
  }
  let serialized;
  try {
    serialized = id.toString.call(id);
  } catch (_) {
    return { ok: false, changed: false, serialized: null, errorCode: "message_id_to_string_failed" };
  }
  if (typeof serialized !== "string" || !serialized.trim() || serialized === "[object Object]") {
    return { ok: false, changed: false, serialized: null, errorCode: "message_id_to_string_invalid" };
  }
  try {
    id._serialized = serialized;
  } catch (_) {
    return { ok: false, changed: false, serialized: null, errorCode: "message_id_assignment_failed" };
  }
  if (id._serialized !== serialized) {
    return { ok: false, changed: false, serialized: null, errorCode: "message_id_assignment_failed" };
  }
  return { ok: true, changed: true, serialized, errorCode: null };
}

function validOfficialMessageId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized === "[object Object]" || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function validSerializedMessageId(value) {
  const normalized = validOfficialMessageId(value);
  if (!normalized) return null;
  return /^(?:true|false)_[^_\s]+@[^_\s]+_[^_\s]+(?:_[^_\s]+@[^_\s]+)?$/.test(normalized)
    ? normalized
    : null;
}

function inspectSerializedIdCandidate(value) {
  const result = {
    constructorName: typeof value?.constructor?.name === "string" ? value.constructor.name : "unavailable",
    ownKeys: safePropertyKeys(value),
    prototypeKeys: "none",
    hasSerialized: Boolean(validSerializedMessageId(value?._serialized)),
    hasToString: Boolean(value && typeof value.toString === "function"),
    toStringCallable: Boolean(value && typeof value.toString === "function"),
    toStringSucceeded: false,
    toStringReturnedString: false,
    toStringValidShape: false,
    toStringValue: null
  };
  try {
    const prototype = value && (typeof value === "object" || typeof value === "function")
      ? Object.getPrototypeOf(value)
      : null;
    result.prototypeKeys = prototype
      ? Object.getOwnPropertyNames(prototype).sort().join(",") || "none"
      : "none";
  } catch (_) {
    result.prototypeKeys = "unavailable";
  }
  if (!result.toStringCallable) return result;
  try {
    const converted = value.toString.call(value);
    result.toStringSucceeded = true;
    result.toStringReturnedString = typeof converted === "string";
    result.toStringValue = validSerializedMessageId(converted);
    result.toStringValidShape = Boolean(result.toStringValue);
  } catch (_) {
    // O diagnÃ³stico expÃµe apenas o resultado estrutural controlado.
  }
  return result;
}

function resolveSerializedMessageIdDetails(message) {
  const id = message?.id;
  const dataId = message?._data?.id;
  const idInspection = inspectSerializedIdCandidate(id);
  const dataIdInspection = inspectSerializedIdCandidate(dataId);
  const fromId = validSerializedMessageId(id?._serialized);
  const fromDataId = validSerializedMessageId(dataId?._serialized);
  if (fromId) return { serializedId: fromId, source: "id_serialized", idInspection, dataIdInspection };
  if (fromDataId) return { serializedId: fromDataId, source: "data_id_serialized", idInspection, dataIdInspection };
  if (idInspection.toStringValue) return { serializedId: idInspection.toStringValue, source: "id_toString", idInspection, dataIdInspection };
  if (dataIdInspection.toStringValue) return { serializedId: dataIdInspection.toStringValue, source: "data_id_toString", idInspection, dataIdInspection };
  return { serializedId: null, source: "none", idInspection, dataIdInspection };
}

function resolveSerializedMessageId(message) {
  return resolveSerializedMessageIdDetails(message).serializedId;
}

function messageKeyFactoryInput(source) {
  if (!source || typeof source !== "object") return null;
  if (typeof source.fromMe !== "boolean" || source.id == null || source.remote == null) return null;
  return {
    fromMe: source.fromMe,
    id: source.id,
    remote: source.remote,
    ...(source.participant != null ? { participant: source.participant } : {})
  };
}

async function resolveOfficialSerializedMessageIdDetails(message) {
  const directId = validSerializedMessageId(message?.id?._serialized);
  if (directId) return {
    serializedId: directId,
    source: "id_serialized",
    officialFactoryAvailable: false,
    officialFactoryName: "not_needed",
    officialFactoryAccepted: false
  };
  const directDataId = validSerializedMessageId(message?._data?.id?._serialized);
  if (directDataId) return {
    serializedId: directDataId,
    source: "data_id_serialized",
    officialFactoryAvailable: false,
    officialFactoryName: "not_needed",
    officialFactoryAccepted: false
  };

  const page = message?.client?.pupPage || message?._client?.pupPage;
  const unavailable = {
    serializedId: null,
    source: "none",
    officialFactoryAvailable: false,
    officialFactoryName: "unavailable",
    officialFactoryAccepted: false
  };
  if (!page || typeof page.evaluate !== "function") return unavailable;

  let lastDiagnostic = unavailable;
  for (const source of [message?.id, message?._data?.id]) {
    const input = messageKeyFactoryInput(source);
    if (!input) continue;
    try {
      const result = await page.evaluate(data => {
        let MsgKey;
        try { MsgKey = window.require("WAWebMsgKey"); } catch (_) { MsgKey = null; }
        if (typeof MsgKey !== "function") return {
          factoryAvailable: false,
          factoryName: "unavailable",
          factoryAccepted: false,
          serialized: null
        };
        const factoryName = typeof MsgKey.name === "string" && MsgKey.name ? MsgKey.name : "WAWebMsgKey";
        try {
          const WidFactory = window.require("WAWebWidFactory");
          const toOfficialWid = value => {
            if (value == null) return value;
            if (typeof WidFactory.createWidFromWidLike === "function" && typeof value === "object") {
              return WidFactory.createWidFromWidLike(value);
            }
            if (typeof value === "string") return WidFactory.createWid(value);
            if (typeof value?._serialized === "string") return WidFactory.createWid(value._serialized);
            return value;
          };
          const key = new MsgKey({
            fromMe: data.fromMe,
            id: data.id,
            remote: toOfficialWid(data.remote),
            ...(data.participant != null ? { participant: toOfficialWid(data.participant) } : {})
          });
          const serialized = typeof key?._serialized === "string"
            ? key._serialized
            : typeof key?.toString === "function" ? key.toString() : null;
          return { factoryAvailable: true, factoryName, factoryAccepted: true, serialized };
        } catch (_) {
          return { factoryAvailable: true, factoryName, factoryAccepted: false, serialized: null };
        }
      }, input);
      const factoryName = String(result?.factoryName || "unavailable").replace(/[^a-z0-9_$-]/gi, "_").slice(0, 80);
      const serializedId = validSerializedMessageId(result?.serialized);
      lastDiagnostic = {
        serializedId,
        source: serializedId ? "official_factory" : "none",
        officialFactoryAvailable: Boolean(result?.factoryAvailable),
        officialFactoryName: factoryName,
        officialFactoryAccepted: Boolean(result?.factoryAccepted)
      };
      if (serializedId) return lastDiagnostic;
    } catch (_) {
      lastDiagnostic = unavailable;
    }
  }
  return lastDiagnostic;
}

async function resolveOfficialSerializedMessageId(message) {
  return (await resolveOfficialSerializedMessageIdDetails(message)).serializedId;
}

function resolveOfficialMessageId(message) {
  if (!message || (typeof message !== "object" && typeof message !== "function")) return null;
  for (const source of [message.id, message._data?.id]) {
    const direct = validOfficialMessageId(source);
    if (direct) return direct;
    if (!source || (typeof source !== "object" && typeof source !== "function")) continue;
    const serialized = validOfficialMessageId(source._serialized);
    if (serialized) return serialized;
    const stanzaId = validOfficialMessageId(source.id);
    if (stanzaId) return stanzaId;
    if (typeof source.toString === "function") {
      try {
        const converted = validOfficialMessageId(source.toString.call(source));
        if (converted) return converted;
      } catch (_) {
        // Continua tentando somente as demais representações oficiais.
      }
    }
  }
  return null;
}

function resolveDirectQuotedMessageId(message) {
  const quotedModel = message?._data?.quotedMsg;
  if (!quotedModel || (typeof quotedModel !== "object" && typeof quotedModel !== "function")) {
    return null;
  }
  return resolveOfficialMessageId(quotedModel);
}

function safePropertyKeys(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return "none";
  try {
    return Object.keys(value).sort().join(",") || "none";
  } catch (_) {
    return "unavailable";
  }
}

function describeOfficialMessageIdShape(message) {
  const resultType = Array.isArray(message) ? "array" : message === null ? "null" : typeof message;
  const hasId = Boolean(message && Object.prototype.hasOwnProperty.call(Object(message), "id"));
  const id = hasId ? message.id : undefined;
  const hasData = Boolean(message && Object.prototype.hasOwnProperty.call(Object(message), "_data"));
  const dataId = hasData ? message?._data?.id : undefined;
  const constructorName = typeof message?.constructor?.name === "string"
    ? message.constructor.name
    : "unknown";
  return [
    `resultType=${resultType}`,
    `hasId=${hasId}`,
    `idType=${id === null ? "null" : typeof id}`,
    `idKeys=${safePropertyKeys(id)}`,
    `hasData=${hasData}`,
    `dataIdType=${dataId === null ? "null" : typeof dataId}`,
    `dataIdKeys=${safePropertyKeys(dataId)}`,
    `hasSerialized=${Boolean(validOfficialMessageId(id?._serialized) || validOfficialMessageId(dataId?._serialized))}`,
    `hasToString=${Boolean(
      (id && typeof id.toString === "function") ||
      (dataId && typeof dataId.toString === "function")
    )}`,
    `constructorName=${constructorName}`
  ];
}

async function getQuotedMessageSafe(message, options = {}) {
  const log = text => console.log(`[QUOTED] ${text}`);
  const failure = errorCode => ({
    ok: false,
    messageId: null,
    quotedMessage: null,
    source: null,
    errorCode
  });
  const hasQuotedMsg = Boolean(message?.hasQuotedMsg || message?._data?.quotedMsg);
  const methodAvailable = typeof message?.getQuotedMessage === "function";
  const before = typeof message?.id?._serialized === "string" && Boolean(message.id._serialized.trim());
  const idToStringType = typeof message?.id?.toString === "function" ? "function" : "other";
  log("iniciou=true");
  log(`hasQuotedMsg=${hasQuotedMsg}`);
  log(`methodAvailable=${methodAvailable}`);
  log(`hasSerializedBefore=${before}`);
  log(`idToStringType=${idToStringType}`);
  if (!hasQuotedMsg) {
    log("ensureOk=false");
    log("ensureCode=quoted_message_absent");
    log(`hasSerializedAfter=${before}`);
    log("getQuotedStarted=false");
    log("getQuotedSuccess=false");
    return failure("quoted_message_absent");
  }
  const directMessageId = resolveDirectQuotedMessageId(message);
  if (directMessageId && options.allowIdOnly === true) {
    log("ensureOk=true");
    log("ensureCode=none");
    log(`hasSerializedAfter=${before}`);
    log("getQuotedStarted=false");
    log("getQuotedSuccess=false");
    return {
      ok: true,
      messageId: directMessageId,
      quotedMessage: null,
      source: "direct",
      errorCode: null
    };
  }
  if (!methodAvailable) {
    log("ensureOk=false");
    log("ensureCode=quoted_message_method_unavailable");
    log(`hasSerializedAfter=${before}`);
    log("getQuotedStarted=false");
    log("getQuotedSuccess=false");
    return failure("quoted_message_method_unavailable");
  }

  const ensured = ensureMessageIdSerialized(message);
  const after = typeof message?.id?._serialized === "string" && Boolean(message.id._serialized.trim());
  log(`ensureOk=${ensured.ok}`);
  log(`ensureCode=${ensured.errorCode || "none"}`);
  log(`hasSerializedAfter=${after}`);

  let directError = null;
  if (ensured.ok) {
    log("getQuotedStarted=true");
    try {
      const quotedMessage = await message.getQuotedMessage();
      if (quotedMessage) {
        log("getQuotedSuccess=true");
        return {
          ok: true,
          messageId: resolveOfficialMessageId(quotedMessage),
          quotedMessage,
          source: "quoted_object",
          errorCode: null
        };
      }
      directError = new Error("quoted message unavailable");
    } catch (error) {
      directError = error;
    }
    log("getQuotedSuccess=false");
    log(`errorName=${sanitizeQuotedDiagnostic(directError?.name || "Error")}`);
    log(`errorCode=${quotedErrorCode(directError)}`);
    log(`errorMessage=${sanitizeQuotedDiagnostic(directError?.message)}`);
    log(`stackFirstLine=${sanitizeQuotedDiagnostic(String(directError?.stack || "").split(/\r?\n/, 1)[0])}`);
  } else {
    log("getQuotedStarted=false");
    log("getQuotedSuccess=false");
  }

  const keyData = structuralMessageKey(message);
  const page = message?.client?.pupPage || message?._client?.pupPage;
  const eligibleFallback = Boolean(
    keyData &&
    page &&
    typeof page.evaluate === "function" &&
    (!directError || ["quoted_message_key_missing", "quoted_message_key_invalid"].includes(quotedErrorCode(directError)))
  );
  if (!eligibleFallback) {
    return failure(ensured.ok ? quotedErrorCode(directError) : ensured.errorCode);
  }

  try {
    const quotedMessage = await page.evaluate(async data => {
      const MsgKey = window.require("WAWebMsgKey");
      const WidFactory = window.require("WAWebWidFactory");
      const key = new MsgKey({
        ...data,
        remote: WidFactory.createWid(data.remote),
        ...(data.participant ? { participant: WidFactory.createWid(data.participant) } : {})
      });
      const serialized = key?._serialized || (typeof key?.toString === "function" ? key.toString() : null);
      if (typeof serialized !== "string" || !serialized) return null;
      const collections = window.require("WAWebCollections");
      const commandMessage = collections.Msg.get(serialized) ||
        (await collections.Msg.getMessagesById([serialized]))?.messages?.[0];
      if (!commandMessage) return null;
      const quoted = window.require("WAWebQuotedMsgModelUtils").getQuotedMsgObj(commandMessage);
      return quoted ? window.WWebJS.getMessageModel(quoted) : null;
    }, keyData);
    if (quotedMessage) {
      log("getQuotedSuccess=true");
      const client = message?.client || message?._client;
      return {
        ok: true,
        messageId: resolveOfficialMessageId(quotedMessage),
        quotedMessage: client ? new Message(client, quotedMessage) : quotedMessage,
        source: "quoted_object",
        errorCode: null
      };
    }
    return failure("quoted_message_not_found");
  } catch (error) {
    log(`errorName=${sanitizeQuotedDiagnostic(error?.name || "Error")}`);
    log(`errorCode=${quotedErrorCode(error)}`);
    log(`errorMessage=${sanitizeQuotedDiagnostic(error?.message)}`);
    log(`stackFirstLine=${sanitizeQuotedDiagnostic(String(error?.stack || "").split(/\r?\n/, 1)[0])}`);
    return failure(quotedErrorCode(error));
  }
}

function classifyBrowserError(error) {
  const text = `${error?.name || ""} ${error?.message || ""}`.toLowerCase();
  if (/target closed/.test(text)) return "target_closed";
  if (/execution context/.test(text)) return "execution_context_destroyed";
  if (/browser.*disconnect|session closed/.test(text)) return "chromium_disconnected";
  if (/wwebjs.*missing/.test(text)) return "wwebjs_injection_missing";
  if (/getchat.*missing/.test(text)) return "wwebjs_getchat_missing";
  if (/getchats.*missing/.test(text)) return "wwebjs_getchats_missing";
  if (/wawebcollections.*missing/.test(text)) return "wawebcollections_missing";
  if (/chat collection.*missing/.test(text)) return "chat_collection_missing";
  if (/group metadata.*missing/.test(text)) return "group_metadata_collection_missing";
  if (/idbobjectstore|no key or key range/.test(text)) return "incompatible_web_version";
  if (/evaluation failed|evaluate/.test(text)) return "puppeteer_evaluation_failed";
  return "unknown_browser_error";
}

function requirePage(client) {
  if (!client?.pupBrowser?.connected) throw new Error("browser disconnected");
  if (!client?.pupPage || client.pupPage.isClosed()) throw new Error("target closed");
  return client.pupPage;
}

async function verifyWWebJSInjection(client) {
  return requirePage(client).evaluate(() => ({
    injected: typeof window.WWebJS === "object",
    getChat: typeof window.WWebJS?.getChat === "function",
    getChats: typeof window.WWebJS?.getChats === "function",
    require: typeof window.require === "function"
  }));
}

async function verifyChatApis(client) {
  const injection = await verifyWWebJSInjection(client);
  if (!injection.injected) throw new Error("wwebjs missing");
  if (!injection.getChat) throw new Error("getChat missing");
  if (!injection.getChats) throw new Error("getChats missing");
  return requirePage(client).evaluate(() => {
    const collections = window.require("WAWebCollections");
    if (!collections) throw new Error("WAWebCollections missing");
    if (!collections.Chat) throw new Error("chat collection missing");
    return {
      collections: true,
      chatCollection: true,
      chatCount: typeof collections.Chat.getModelsArray === "function"
        ? collections.Chat.getModelsArray().length
        : 0
    };
  });
}

async function verifyGroupMetadataAccess(client) {
  return requirePage(client).evaluate(async () => {
    const collections = window.require("WAWebCollections");
    const metadataCollection =
      collections?.GroupMetadata || collections?.WAWebGroupMetadataCollection;
    if (!metadataCollection) throw new Error("group metadata collection missing");
    const chats = typeof collections.Chat?.getModelsArray === "function"
      ? collections.Chat.getModelsArray()
      : [];
    const group = chats.find(chat => chat?.groupMetadata);
    if (!group) return { groupAvailable: false, participantsArray: false, participantsCount: 0 };
    const wid = window.require("WAWebWidFactory").createWid(group.id._serialized);
    await metadataCollection.update(wid);
    const metadata = group.groupMetadata.serialize();
    return {
      groupAvailable: true,
      participantsArray: Array.isArray(metadata?.participants),
      participantsCount: Array.isArray(metadata?.participants) ? metadata.participants.length : 0
    };
  });
}

async function installChatSerializationCompatibility(client) {
  return requirePage(client).evaluate(() => {
    if (window.WWebJS?.__mikaChatSerializationCompatibility === true) {
      return { installed: true, alreadyInstalled: true };
    }
    if (typeof window.WWebJS?.getChatModel !== "function") throw new Error("getChat missing");
    const original = window.WWebJS.getChatModel;
    window.WWebJS.getChatModel = async function compatibleGetChatModel(chat, options) {
      const key = chat?.lastReceivedKey;
      if (key && typeof key._serialized !== "string" && typeof key.toString === "function") {
        const serialized = key.toString();
        if (typeof serialized === "string" && serialized) key._serialized = serialized;
      }
      return original(chat, options);
    };
    window.WWebJS.__mikaChatSerializationCompatibility = true;
    return { installed: true, alreadyInstalled: false };
  });
}

function logWWebSendDiagnostic(details) {
  const safeType = value => String(value || "unknown").replace(/[^a-z0-9_$.-]/gi, "").slice(0, 80) || "unknown";
  const safeKeyList = value => Array.isArray(value)
    ? value.map(safeType).filter(Boolean).slice(0, 40).join(",") || "none"
    : "none";
  const safeKeys = Array.isArray(details?.sendResultKeys)
    ? details.sendResultKeys.map(safeType).filter(Boolean).slice(0, 30).join(",") || "none"
    : "none";
  console.log(`[WWEB_SEND] newMsgKeyPresent=${Boolean(details?.newMsgKeyPresent)}`);
  console.log(`[WWEB_SEND] serializedKeyPresent=${Boolean(details?.serializedKeyPresent)}`);
  console.log(`[WWEB_SEND] msgPromiseResolved=${Boolean(details?.msgPromiseResolved)}`);
  console.log(`[WWEB_SEND] sendResultResolved=${Boolean(details?.sendResultResolved)}`);
  console.log(`[WWEB_SEND] sendResultType=${safeType(details?.sendResultType)}`);
  console.log(`[WWEB_SEND] sendResultHasId=${Boolean(details?.sendResultHasId)}`);
  console.log(`[WWEB_SEND] collectionImmediateFound=${Boolean(details?.collectionImmediateFound)}`);
  console.log(`[WWEB_SEND] collectionAfterSendFound=${Boolean(details?.collectionAfterSendFound)}`);
  console.log(`[WWEB_SEND] modelSerializationSucceeded=${Boolean(details?.modelSerializationSucceeded)}`);
  console.log(`[WWEB_SEND] exactKeyAttemptCount=${Number.isInteger(details?.exactKeyAttemptCount) ? details.exactKeyAttemptCount : 0}`);
  console.log(`[WWEB_SEND] exactKeyEventuallyFound=${Boolean(details?.exactKeyEventuallyFound)}`);
  console.log(`[WWEB_SEND] sendResultKeys=${safeKeys}`);
  console.log(`[WWEB_SEND] sendResultConstructor=${safeType(details?.sendResultConstructor)}`);
  console.log(`[WWEB_SEND] sendResultContainsMessageModel=${Boolean(details?.sendResultContainsMessageModel)}`);
  console.log(`[WWEB_SEND] sendResultContainsKey=${Boolean(details?.sendResultContainsKey)}`);
  const key = details?.newMsgKeyShape || {};
  console.log(`[NEW_MSG_KEY] type=${safeType(key.type)}`);
  console.log(`[NEW_MSG_KEY] constructorName=${safeType(key.constructorName)}`);
  console.log(`[NEW_MSG_KEY] ownKeys=${safeKeyList(key.ownKeys)}`);
  console.log(`[NEW_MSG_KEY] prototypeKeys=${safeKeyList(key.prototypeKeys)}`);
  console.log(`[NEW_MSG_KEY] hasSerialized=${Boolean(key.hasSerialized)}`);
  console.log(`[NEW_MSG_KEY] hasToString=${Boolean(key.hasToString)}`);
  console.log(`[NEW_MSG_KEY] toStringOwner=${safeType(key.toStringOwner)}`);
  console.log(`[NEW_MSG_KEY] hasId=${Boolean(key.hasId)}`);
  console.log(`[NEW_MSG_KEY] hasRemote=${Boolean(key.hasRemote)}`);
  console.log(`[NEW_MSG_KEY] hasParticipant=${Boolean(key.hasParticipant)}`);
  console.log(`[NEW_MSG_KEY] hasFromMe=${Boolean(key.hasFromMe)}`);
  console.log(`[NEW_MSG_KEY] hasMethodSerialize=${Boolean(key.hasMethodSerialize)}`);
  console.log(`[NEW_MSG_KEY] hasMethodToJSON=${Boolean(key.hasMethodToJSON)}`);
  console.log(`[NEW_MSG_KEY] toStringCallable=${Boolean(key.toStringCallable)}`);
  console.log(`[NEW_MSG_KEY] toStringSucceeded=${Boolean(key.toStringSucceeded)}`);
  console.log(`[NEW_MSG_KEY] toStringReturnedString=${Boolean(key.toStringReturnedString)}`);
  console.log(`[NEW_MSG_KEY] toStringEmpty=${Boolean(key.toStringEmpty)}`);
  console.log(`[NEW_MSG_KEY] toStringObjectDefault=${Boolean(key.toStringObjectDefault)}`);
  console.log(`[NEW_MSG_KEY] toStringHasControlCharacters=${Boolean(key.toStringHasControlCharacters)}`);
  console.log(`[NEW_MSG_KEY] toStringValidShape=${Boolean(key.toStringValidShape)}`);
  console.log(`[NEW_MSG_KEY] toJSONSucceeded=${Boolean(key.toJSONSucceeded)}`);
  console.log(`[NEW_MSG_KEY] toJSONType=${safeType(key.toJSONType)}`);
  console.log(`[NEW_MSG_KEY] toJSONKeys=${safeKeyList(key.toJSONKeys)}`);
  const reference = details?.referenceMessageIdShape || {};
  console.log(`[NEW_MSG_KEY] referenceAvailable=${Boolean(details?.referenceMessageIdShape)}`);
  console.log(`[NEW_MSG_KEY] referenceConstructorName=${safeType(reference.constructorName)}`);
  console.log(`[NEW_MSG_KEY] referenceOwnKeys=${safeKeyList(reference.ownKeys)}`);
  console.log(`[NEW_MSG_KEY] referencePrototypeKeys=${safeKeyList(reference.prototypeKeys)}`);
  console.log(`[NEW_MSG_KEY] referenceHasSerialized=${Boolean(reference.hasSerialized)}`);
  console.log(`[NEW_MSG_KEY] referenceToStringOwner=${safeType(reference.toStringOwner)}`);
  console.log(`[NEW_MSG_KEY] referenceToStringValidShape=${Boolean(reference.toStringValidShape)}`);
  console.log(`[NEW_MSG_KEY] sameConstructor=${Boolean(details?.sameConstructor)}`);
  console.log(`[NEW_MSG_KEY] samePrototype=${Boolean(details?.samePrototype)}`);
  console.log(`[NEW_MSG_KEY] factoryAvailable=${Boolean(details?.factoryAvailable)}`);
  console.log(`[NEW_MSG_KEY] factoryType=${safeType(details?.factoryType)}`);
  console.log(`[NEW_MSG_KEY] factoryConstructorName=${safeType(details?.factoryConstructorName)}`);
  console.log(`[NEW_MSG_KEY] keyInstanceOfFactory=${Boolean(details?.keyInstanceOfFactory)}`);
  console.log(`[NEW_MSG_KEY] factoryObjectAccepted=${Boolean(details?.factoryObjectAccepted)}`);
  console.log(`[NEW_MSG_KEY] factoryReturnsOfficialKey=${Boolean(details?.factoryReturnsOfficialKey)}`);
  console.log(`[NEW_MSG_KEY] collectionByToStringAfterMsgFound=${Boolean(details?.collectionByToStringAfterMsgFound)}`);
  console.log(`[NEW_MSG_KEY] collectionByToStringAfterSendFound=${Boolean(details?.collectionByToStringAfterSendFound)}`);
  console.log(`[NEW_MSG_KEY] toStringExactAttemptCount=${Number.isInteger(details?.toStringExactAttemptCount) ? details.toStringExactAttemptCount : 0}`);
  console.log(`[NEW_MSG_KEY] collectionByToStringEventuallyFound=${Boolean(details?.collectionByToStringEventuallyFound)}`);
  console.log(`[NEW_MSG_KEY] toStringModelSerializationSucceeded=${Boolean(details?.toStringModelSerializationSucceeded)}`);
  console.log(`[NEW_MSG_KEY] raidCompatibilityRequested=${Boolean(details?.raidCompatibilityRequested)}`);
  console.log(`[NEW_MSG_KEY] officialKeyApplied=${Boolean(details?.officialKeyApplied)}`);
}

async function installWWebSendDiagnostic(client) {
  const page = requirePage(client);
  if (typeof page.exposeFunction === "function") {
    try {
      await page.exposeFunction("onMikaWWebSendDiagnostic", logWWebSendDiagnostic);
    } catch (error) {
      if (!/already exists|already registered|binding/i.test(String(error?.message || ""))) throw error;
    }
  }
  return page.evaluate(() => {
    if (window.WWebJS?.__mikaWWebSendDiagnostic === true) {
      return { installed: true, alreadyInstalled: true };
    }
    const sendAction = window.require("WAWebSendMsgChatAction");
    if (!sendAction || typeof sendAction.addAndSendMsgToChat !== "function") {
      throw new Error("send message action missing");
    }
    const propertyNames = value => {
      if (!value || (typeof value !== "object" && typeof value !== "function")) return [];
      try { return Object.getOwnPropertyNames(value).sort(); } catch (_) { return []; }
    };
    const inspectKey = value => {
      const prototype = value && (typeof value === "object" || typeof value === "function")
        ? Object.getPrototypeOf(value)
        : null;
      const hasOwnToString = Boolean(value && Object.prototype.hasOwnProperty.call(value, "toString"));
      const prototypeOwnsToString = Boolean(
        prototype &&
        prototype !== Object.prototype &&
        Object.prototype.hasOwnProperty.call(prototype, "toString")
      );
      const toStringMethod = value?.toString;
      const shape = {
        type: Array.isArray(value) ? "array" : value === null ? "null" : typeof value,
        constructorName: typeof value?.constructor?.name === "string" ? value.constructor.name : "unknown",
        ownKeys: propertyNames(value),
        prototypeKeys: propertyNames(prototype),
        hasSerialized: typeof value?._serialized === "string" && Boolean(value._serialized),
        hasToString: typeof toStringMethod === "function",
        toStringOwner: hasOwnToString
          ? "own"
          : prototypeOwnsToString
            ? "prototype"
            : toStringMethod === Object.prototype.toString
              ? "object_default"
              : typeof toStringMethod === "function"
                ? "prototype"
                : "none",
        hasId: Boolean(value && "id" in Object(value)),
        hasRemote: Boolean(value && "remote" in Object(value)),
        hasParticipant: Boolean(value && "participant" in Object(value)),
        hasFromMe: Boolean(value && "fromMe" in Object(value)),
        hasMethodSerialize: typeof value?.serialize === "function",
        hasMethodToJSON: typeof value?.toJSON === "function",
        toStringCallable: typeof toStringMethod === "function",
        toStringSucceeded: false,
        toStringReturnedString: false,
        toStringEmpty: false,
        toStringObjectDefault: false,
        toStringHasControlCharacters: false,
        toStringValidShape: false,
        toJSONSucceeded: false,
        toJSONType: "undefined",
        toJSONKeys: []
      };
      if (shape.toStringCallable) {
        try {
          const result = toStringMethod.call(value);
          shape.toStringSucceeded = true;
          shape.toStringReturnedString = typeof result === "string";
          if (typeof result === "string") {
            shape.toStringEmpty = !result.trim();
            shape.toStringObjectDefault = result === "[object Object]";
            shape.toStringHasControlCharacters = /[\u0000-\u001f\u007f]/.test(result);
            const parts = result.split("_");
            shape.toStringValidShape = !shape.toStringEmpty &&
              !shape.toStringObjectDefault &&
              !shape.toStringHasControlCharacters &&
              (parts.length === 3 || parts.length === 4);
          }
        } catch (_) {
          shape.toStringSucceeded = false;
        }
      }
      if (shape.hasMethodToJSON) {
        try {
          const json = value.toJSON();
          shape.toJSONSucceeded = true;
          shape.toJSONType = Array.isArray(json) ? "array" : json === null ? "null" : typeof json;
          shape.toJSONKeys = propertyNames(json);
        } catch (_) {
          shape.toJSONSucceeded = false;
        }
      }
      return { shape, prototype };
    };
    const originalGetMessageModel = window.WWebJS.getMessageModel;
    window.WWebJS.getMessageModel = function diagnosticGetMessageModel(message) {
      const model = originalGetMessageModel.apply(this, arguments);
      window.WWebJS.__mikaReferenceMessageIdShape = inspectKey(model?.id);
      return model;
    };
    const original = sendAction.addAndSendMsgToChat;
    sendAction.addAndSendMsgToChat = function diagnosticAddAndSend(chat, message) {
      const newMsgKey = message?.id;
      const raidCompatibilityRequested = message?.mikaRaidResolveOfficialMessageKey === true;
      if (message && Object.prototype.hasOwnProperty.call(message, "mikaRaidResolveOfficialMessageKey")) {
        delete message.mikaRaidResolveOfficialMessageKey;
      }
      const inspectedNewKey = inspectKey(newMsgKey);
      const serializedKey = typeof newMsgKey?._serialized === "string" && Boolean(newMsgKey._serialized);
      let toStringKey = null;
      if (inspectedNewKey.shape.toStringValidShape) {
        try {
          const candidate = newMsgKey.toString();
          if (typeof candidate === "string" && candidate) toStringKey = candidate;
        } catch (_) {
          toStringKey = null;
        }
      }
      let factory;
      try { factory = window.require("WAWebMsgKey"); } catch (_) { factory = null; }
      const reference = window.WWebJS.__mikaReferenceMessageIdShape || null;
      const state = {
        newMsgKeyPresent: Boolean(newMsgKey),
        serializedKeyPresent: serializedKey,
        msgPromiseResolved: false,
        sendResultResolved: false,
        sendResultType: "undefined",
        sendResultHasId: false,
        collectionImmediateFound: false,
        collectionAfterSendFound: false,
        modelSerializationSucceeded: false,
        exactKeyAttemptCount: 0,
        exactKeyEventuallyFound: false,
        sendResultKeys: [],
        sendResultConstructor: "unknown",
        sendResultContainsMessageModel: false,
        sendResultContainsKey: false,
        newMsgKeyShape: inspectedNewKey.shape,
        referenceMessageIdShape: reference?.shape || null,
        sameConstructor: Boolean(reference?.shape?.constructorName === inspectedNewKey.shape.constructorName),
        samePrototype: Boolean(reference?.prototype && reference.prototype === inspectedNewKey.prototype),
        factoryAvailable: Boolean(factory),
        factoryType: factory === null ? "null" : typeof factory,
        factoryConstructorName: typeof factory?.name === "string"
          ? factory.name
          : typeof factory?.constructor?.name === "string"
            ? factory.constructor.name
            : "unknown",
        keyInstanceOfFactory: false,
        factoryObjectAccepted: false,
        factoryReturnsOfficialKey: inspectedNewKey.shape.hasSerialized || inspectedNewKey.shape.toStringValidShape,
        collectionByToStringAfterMsgFound: false,
        collectionByToStringAfterSendFound: false,
        toStringExactAttemptCount: 0,
        collectionByToStringEventuallyFound: false,
        toStringModelSerializationSucceeded: false
      };
      if (typeof factory === "function") {
        try {
          state.keyInstanceOfFactory = newMsgKey instanceof factory;
          state.factoryObjectAccepted = state.keyInstanceOfFactory;
        } catch (_) {
          state.keyInstanceOfFactory = false;
        }
      }
      let officialKeyApplied = false;
      if (
        raidCompatibilityRequested &&
        !serializedKey &&
        state.keyInstanceOfFactory &&
        toStringKey
      ) {
        try {
          newMsgKey._serialized = toStringKey;
          officialKeyApplied = newMsgKey._serialized === toStringKey;
        } catch (_) {
          officialKeyApplied = false;
        }
      }
      state.raidCompatibilityRequested = raidCompatibilityRequested;
      state.officialKeyApplied = officialKeyApplied;
      const pair = original.call(this, chat, message);
      if (!Array.isArray(pair)) return pair;
      const [msgPromise, sendResultPromise] = pair;
      const collections = window.require("WAWebCollections");
      const readExact = () => serializedKey ? collections?.Msg?.get(newMsgKey._serialized) : undefined;
      const readToStringExact = () => toStringKey ? collections?.Msg?.get(toStringKey) : undefined;
      const wrappedMsgPromise = Promise.resolve(msgPromise).then(result => {
        state.msgPromiseResolved = true;
        state.collectionImmediateFound = Boolean(readExact());
        state.collectionByToStringAfterMsgFound = Boolean(readToStringExact());
        return result;
      });
      const reportAfterSend = async result => {
        state.sendResultResolved = true;
        state.sendResultType = Array.isArray(result) ? "array" : result === null ? "null" : typeof result;
        if (result && (typeof result === "object" || typeof result === "function")) {
          try { state.sendResultKeys = Object.keys(result).sort(); } catch (_) { state.sendResultKeys = []; }
          state.sendResultConstructor = typeof result?.constructor?.name === "string"
            ? result.constructor.name
            : "unknown";
          state.sendResultHasId = Boolean(result.id);
          state.sendResultContainsMessageModel = Boolean(result.message || result.msg || result.messageModel);
          state.sendResultContainsKey = Boolean(result.key || result.id || result.messageId || result.msgKey);
        }
        let model = readExact();
        state.exactKeyAttemptCount = serializedKey ? 1 : 0;
        state.collectionAfterSendFound = Boolean(model);
        for (let attempt = 1; !model && serializedKey && attempt < 4; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 25));
          state.exactKeyAttemptCount += 1;
          model = readExact();
        }
        state.exactKeyEventuallyFound = Boolean(model);
        if (model && typeof window.WWebJS?.getMessageModel === "function") {
          try {
            state.modelSerializationSucceeded = Boolean(window.WWebJS.getMessageModel(model));
          } catch (_) {
            state.modelSerializationSucceeded = false;
          }
        }
        let toStringModel = readToStringExact();
        state.toStringExactAttemptCount = toStringKey ? 1 : 0;
        state.collectionByToStringAfterSendFound = Boolean(toStringModel);
        for (let attempt = 1; !toStringModel && toStringKey && attempt < 4; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 25));
          state.toStringExactAttemptCount += 1;
          toStringModel = readToStringExact();
        }
        state.collectionByToStringEventuallyFound = Boolean(toStringModel);
        if (toStringModel && typeof window.WWebJS?.getMessageModel === "function") {
          try {
            state.toStringModelSerializationSucceeded = Boolean(window.WWebJS.getMessageModel(toStringModel));
          } catch (_) {
            state.toStringModelSerializationSucceeded = false;
          }
        }
        if (typeof window.onMikaWWebSendDiagnostic === "function") {
          await window.onMikaWWebSendDiagnostic(state);
        }
      };
      const wrappedSendResultPromise = Promise.resolve(sendResultPromise).then(result => {
        void reportAfterSend(result);
        return result;
      });
      return [wrappedMsgPromise, wrappedSendResultPromise];
    };
    window.WWebJS.__mikaWWebSendDiagnostic = true;
    return { installed: true, alreadyInstalled: false };
  });
}

async function diagnoseClientHealth(client) {
  if (state.checked) return getClientHealthStatus();
  state.checked = true;
  try {
    const injection = await verifyWWebJSInjection(client);
    const chatApis = await verifyChatApis(client);
    const metadata = await verifyGroupMetadataAccess(client);
    const compatibility = await installChatSerializationCompatibility(client);
    const sendDiagnostic = await installWWebSendDiagnostic(client);
    const chats = await client.getChats();
    state.status = "healthy";
    state.errorCode = null;
    state.details = {
      browserConnected: Boolean(client?.pupBrowser?.connected),
      pageActive: !client?.pupPage?.isClosed(),
      injection,
      chatApis: { ...chatApis, chatsArray: Array.isArray(chats) },
      metadata,
      compatibility,
      sendDiagnostic
    };
  } catch (error) {
    state.status = "unhealthy";
    state.errorCode = classifyBrowserError(error);
    state.details = {
      browserConnected: Boolean(client?.pupBrowser?.connected),
      pageActive: Boolean(client?.pupPage && !client.pupPage.isClosed())
    };
  }
  return getClientHealthStatus();
}

function getClientHealthStatus() {
  return JSON.parse(JSON.stringify(state));
}

function resetClientHealthForTests() {
  state.checked = false;
  state.status = "not_checked";
  state.errorCode = null;
  state.details = null;
}

module.exports = {
  ensureMessageIdSerialized,
  resolveSerializedMessageId,
  resolveSerializedMessageIdDetails,
  resolveOfficialSerializedMessageId,
  resolveOfficialSerializedMessageIdDetails,
  resolveOfficialMessageId,
  resolveDirectQuotedMessageId,
  describeOfficialMessageIdShape,
  getQuotedMessageSafe,
  diagnoseClientHealth,
  verifyWWebJSInjection,
  verifyChatApis,
  verifyGroupMetadataAccess,
  classifyBrowserError,
  getClientHealthStatus,
  installChatSerializationCompatibility,
  installWWebSendDiagnostic,
  resetClientHealthForTests
};
