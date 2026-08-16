"use strict";

const serializedId = value => {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value._serialized || value.id?._serialized || value.id || "");
};

async function isGroupMessage(message, chat = null) {
  let resolvedChat = chat;
  if (!resolvedChat && typeof message?.getChat === "function") {
    try { resolvedChat = await message.getChat(); } catch (_) { resolvedChat = null; }
  }
  if (resolvedChat?.isGroup === true) return true;
  if (serializedId(resolvedChat?.id).endsWith("@g.us")) return true;
  if (serializedId(message?.from).endsWith("@g.us")) return true;
  if (serializedId(message?.to).endsWith("@g.us")) return true;
  return false;
}

module.exports = { isGroupMessage };
