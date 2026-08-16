"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const identityService = require("../src/services/identityService");
const { createGroupMemberResolverService } = require("../src/services/groupMemberResolverService");

function fixture() {
  const participants = [
    { id: { _serialized: "member@lid", user: "member", server: "lid" }, isAdmin: false },
    { id: "admin@lid", isAdmin: true },
    { id: "owner@lid", isAdmin: true, isSuperAdmin: true },
    { id: "bot@lid", isAdmin: true }
  ];
  const chat = { isGroup: true, participants };
  const groupChatResolverService = {
    resolveGroupChatWithParticipants: async input => input.chat?.participants
      ? { chat: input.chat, participants: input.chat.participants, source: "context_chat" }
      : { chat: null, participants: null, source: null }
  };
  const resolver = createGroupMemberResolverService({
    identityService: {
      ...identityService,
      resolveDisplayName: async id => id === "member@lid" ? "Membro" : "Treinador"
    },
    groupChatResolverService
  });
  return { resolver, chat };
}

test("resolve menção @lid por mentionedIds", async () => {
  const f = fixture();
  const result = await f.resolver.resolveGroupMember({
    message: { from: "group@g.us", mentionedIds: ["member@lid"] },
    chat: f.chat
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "mention");
  assert.equal(result.canonicalUserId, "member@lid");
  assert.equal(result.displayName, "Membro");
});

test("resolve menção por Contact retornado de getMentions", async () => {
  const f = fixture();
  const result = await f.resolver.resolveGroupMember({
    message: {
      from: "group@g.us",
      mentionedIds: [{ id: { _serialized: "member@lid" } }],
      getMentions: async () => [{ id: { _serialized: "member@lid" }, lid: "member@lid" }]
    },
    chat: f.chat
  });
  assert.equal(result.ok, true);
  assert.equal(result.source, "mention");
});

test("resolve autor @lid contra participante @c.us somente com alias confirmado pelo contato", async () => {
  const f = fixture();
  const chat = {
    isGroup: true,
    participants: [{ id: { _serialized: "5511999999999@c.us", user: "5511999999999", server: "c.us" } }]
  };
  const message = {
    from: "group@g.us",
    id: { _serialized: "MESSAGE-ID" },
    mentionedIds: [],
    hasQuotedMsg: true,
    getQuotedMessage: async () => ({
      author: "opaque-member@lid",
      getContact: async () => ({
        id: { _serialized: "5511999999999@c.us" },
        lid: "opaque-member@lid",
        number: "5511999999999"
      })
    })
  };
  const result = await f.resolver.resolveGroupMember({ message, chat });
  assert.equal(result.ok, true);
  assert.equal(result.source, "reply");
  assert.equal(result.canonicalUserId, "opaque-member@lid");
});

test("não presume equivalência entre @lid e @c.us sem alias confirmado", async () => {
  const f = fixture();
  const chat = {
    isGroup: true,
    participants: [{ id: "5511999999999@c.us" }]
  };
  const result = await f.resolver.resolveGroupMember({
    message: {
      from: "group@g.us",
      id: { _serialized: "MESSAGE-ID" },
      hasQuotedMsg: true,
      getQuotedMessage: async () => ({ author: "opaque-member@lid" })
    },
    chat
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "target_not_in_group");
});

for (const [label, quoted] of [
  ["author", { author: "member@lid" }],
  ["_data.author", { _data: { author: "member@lid" } }],
  ["id.participant", { id: { participant: "member@lid" } }]
]) {
  test(`resolve resposta usando ${label}`, async () => {
    const f = fixture();
    const message = {
      from: "group@g.us",
      id: { toString: () => "MESSAGE-ID" },
      mentionedIds: [],
      hasQuotedMsg: true,
      getQuotedMessage: async () => quoted
    };
    const result = await f.resolver.resolveGroupMember({ message, chat: f.chat });
    assert.equal(result.ok, true);
    assert.equal(result.source, "reply");
    assert.equal(result.canonicalUserId, "member@lid");
    assert.equal(message.id._serialized, "MESSAGE-ID");
  });
}

test("diferencia ausência, participantes indisponíveis e membro fora do grupo", async () => {
  const f = fixture();
  const missing = await f.resolver.resolveGroupMember({
    message: { from: "group@g.us", mentionedIds: [] },
    chat: f.chat
  });
  assert.equal(missing.errorCode, "target_missing");
  const unavailable = await f.resolver.resolveGroupMember({
    message: { from: "group@g.us", mentionedIds: ["member@lid"] },
    chat: null
  });
  assert.equal(unavailable.errorCode, "participants_unavailable");
  const absent = await f.resolver.resolveGroupMember({
    message: { from: "group@g.us", mentionedIds: ["absent@lid"] },
    chat: f.chat
  });
  assert.equal(absent.errorCode, "target_not_in_group");
});

test("retorna proteções estruturais sem expor IDs em nomes", async () => {
  const f = fixture();
  const admin = await f.resolver.resolveGroupMember({
    message: { from: "group@g.us", mentionedIds: ["admin@lid"] },
    chat: f.chat
  });
  const owner = await f.resolver.resolveGroupMember({
    message: { from: "group@g.us", mentionedIds: ["owner@lid"] },
    chat: f.chat
  });
  assert.equal(admin.isAdmin, true);
  assert.equal(owner.isOwner, true);
  assert.doesNotMatch(String(admin.displayName), /@lid|@g\.us|@c\.us/);
});
