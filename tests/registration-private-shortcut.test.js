"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const shortcut = require("../src/services/registrationPrivateShortcutService");
const { UNREGISTERED_MESSAGE } = require("../src/services/joinRequestService");
const experience = require("../src/services/memberExperienceService");
const publicQuery = require("../src/services/registrationPublicQueryService");

test("WhatsApp usa fallback porque não há link oficial seguro sem telefone", () => {
  const result = shortcut.buildWhatsAppPrivateShortcut({ botIdentity: "secret@lid", phone: "5511999999999" });
  assert.equal(result.supported, false); assert.equal(result.url, null); assert.equal(result.command, "cadastro");
  assert.equal(result.fallback, "Envie no privado:\n\ncadastro");
  assert.doesNotMatch(JSON.stringify(result), /secret@lid|5511999999999|wa\.me|api\.whatsapp/i);
});

test("Telegram fica preparado com username validado e start fixo", () => {
  const result = shortcut.buildTelegramPrivateShortcut({ botUsername: "MikaBot", startParameter: "banir" });
  assert.equal(result.supported, true); assert.equal(result.url, "https://t.me/MikaBot?start=cadastro"); assert.equal(result.command, "cadastro");
  for (const botUsername of ["", "https://evil.test", "user/name", "12345", "admin"]) assert.equal(shortcut.buildTelegramPrivateShortcut({ botUsername }).supported, false);
});

test("mensagens sem cadastro e Join Request mantêm fallback sem dados técnicos", () => {
  const messages = [shortcut.privateRegistrationFallback(), UNREGISTERED_MESSAGE, experience.registrationRequiredMessage(), publicQuery.NOT_FOUND];
  for (const message of messages) { assert.match(message, /cadastro/i); assert.doesNotMatch(message, /@lid|@c\.us|@g\.us|wa\.me|\+?\d{10,}/i); }
});

test("atalho nunca executa comando automaticamente", () => {
  let executions = 0;
  const result = shortcut.buildTelegramPrivateShortcut({ botUsername: "MikaBot", execute: () => { executions += 1; } });
  assert.equal(executions, 0); assert.equal(result.command, "cadastro"); assert.equal(Object.hasOwn(result, "execute"), false);
});
