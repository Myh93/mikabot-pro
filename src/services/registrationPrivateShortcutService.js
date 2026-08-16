"use strict";

const COMMAND = "cadastro";
const FALLBACK = `Envie no privado:\n\n${COMMAND}`;

function buildWhatsAppPrivateShortcut() {
  return { supported: false, platform: "whatsapp", command: COMMAND, url: null, reason: "safe_prefilled_link_unavailable", fallback: FALLBACK };
}

function buildTelegramPrivateShortcut(input = {}) {
  const username = String(input.botUsername || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z][A-Za-z0-9_]{3,30}[Bb][Oo][Tt]$/.test(username)) return { supported: false, platform: "telegram", command: COMMAND, url: null, reason: "trusted_bot_username_unavailable", fallback: FALLBACK };
  return { supported: true, platform: "telegram", command: COMMAND, url: `https://t.me/${username}?start=${COMMAND}`, reason: null, fallback: FALLBACK };
}

function privateRegistrationFallback(prefix = "") {
  return [String(prefix || "").trim(), FALLBACK].filter(Boolean).join("\n\n");
}

module.exports = { COMMAND, FALLBACK, buildWhatsAppPrivateShortcut, buildTelegramPrivateShortcut, privateRegistrationFallback };
