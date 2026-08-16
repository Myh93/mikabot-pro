"use strict";

const assert = require("assert");
const test = require("node:test");
const identityService = require("../src/services/identityService");
const { createGroupMemberResolverService } = require("../src/services/groupMemberResolverService");
const { createRaidGroupAccessService } = require("../src/services/raidGroupAccessService");

function fixture(chatDefinitions, options = {}) {
  const groups = Object.keys(chatDefinitions).map((id, index) => ({
    groupId: id,
    name: `Grupo ${index + 1}`,
    active: true,
    aliases: index === 0 ? ["principal"] : []
  }));
  const calls = [];
  const logs = [];
  const groupChatResolver = {
    clearCache: () => undefined,
    resolveGroupChatWithParticipants: async ({ message, chat }) => {
      calls.push("group_chat");
      const resolvedChat = chat || chatDefinitions[message.from] || null;
      return resolvedChat
        ? { chat: resolvedChat, participants: resolvedChat.participants, source: "test", errorCode: null }
        : { chat: null, participants: null, source: null, errorCode: "group_unavailable" };
    }
  };
  const groupMemberResolver = createGroupMemberResolverService({
    identityService,
    groupChatResolverService: groupChatResolver
  });
  const originalResolve = groupMemberResolver.resolveGroupMember;
  groupMemberResolver.resolveGroupMember = async input => {
    calls.push("group_member");
    return originalResolve(input);
  };
  const service = createRaidGroupAccessService({
    groupDirectoryService: {
      listActiveGroups: async () => groups,
      getGroupById: async id => groups.find(group => group.groupId === id) || null,
      formatGroupDisplayName: group => group.name
    },
    groupChatResolverService: groupChatResolver,
    groupMemberResolverService: groupMemberResolver,
    registrationService: {
      getRegistrationByIdentity: async () => options.registration || null
    },
    permissionService: {
      resolveRole: async ({ chat }) => ({ name: chat.permissionDenied ? "denied" : "member" }),
      hasPermission: role => role.name !== "denied"
    },
    log: value => logs.push(value),
    memberLog: value => logs.push(`member:${value}`),
    aliasLog: value => logs.push(`alias:${value}`),
    maxGroups: options.maxGroups || 10
  });
  return { service, calls, logs, groups };
}

test("reutiliza groupMemberResolver para usuário @lid em um e vários grupos", async () => {
  const f = fixture({
    "a@g.us": { isGroup: true, participants: [{ id: "user@lid" }] },
    "b@g.us": { isGroup: true, participants: [{ id: { _serialized: "user@lid" } }] }
  });
  const groups = await f.service.listAuthorizedGroups({}, { id: "user@lid" });
  assert.deepEqual(groups.map(group => group.name), ["Grupo 1", "Grupo 2"]);
  assert.equal(f.calls.filter(call => call === "group_member").length, 2);
});

test("aceita identidade @c.us e alias confirmado entre @lid e @c.us", async () => {
  const f = fixture({
    "a@g.us": { isGroup: true, participants: [{ id: "5511999999999@c.us" }] },
    "b@g.us": { isGroup: true, participants: [{ id: "5511999999999@c.us" }] }
  });
  const traditional = await f.service.revalidate({}, "a@g.us", "5511999999999@c.us");
  const aliased = await f.service.revalidate({}, "b@g.us", {
    id: "alias@lid",
    candidates: ["alias@lid", "5511999999999@c.us"]
  });
  assert.equal(traditional.ok, true);
  assert.equal(aliased.ok, true);
});

test("usa aliases confirmados do cadastro ao comparar ator privado com participante @lid", async () => {
  const f = fixture({
    "a@g.us": { isGroup: true, participants: [{ id: "private-user@lid" }] }
  }, {
    registration: {
      primaryIdentity: "5511999999999",
      identityAliases: ["5511999999999@c.us", "private-user@lid"]
    }
  });
  const groups = await f.service.listAuthorizedGroups({}, {
    id: "5511999999999",
    candidates: ["5511999999999"]
  });
  assert.equal(groups.length, 1);
  assert.ok(f.logs.includes("groupsAfterMembership=1"));
  assert.ok(f.logs.includes("member:matched=true"));
  assert.ok(f.logs.includes("member:resultFieldUsed=ok"));
});

test("incorpora @lid somente quando confirmado pelo Contact retornado pelo WhatsApp", async () => {
  const f = fixture({
    "a@g.us": { isGroup: true, participants: [{ id: "confirmed-contact@lid" }] }
  }, {
    registration: {
      primaryIdentity: "5511999999999",
      identityAliases: [
        "5511999999999",
        "5511999999999@c.us",
        "5511999999999@s.whatsapp.net"
      ]
    }
  });
  const client = {
    getContactById: async () => ({
      id: { _serialized: "5511999999999@c.us" },
      lid: { _serialized: "confirmed-contact@lid" }
    })
  };
  const groups = await f.service.listAuthorizedGroups(client, {
    id: "5511999999999",
    candidates: ["5511999999999"]
  });
  assert.equal(groups.length, 1);
  assert.ok(f.logs.includes("alias:registrationFound=true"));
  assert.ok(f.logs.includes("alias:primaryIdentityPresent=true"));
  assert.ok(f.logs.includes("alias:storedAliasCount=3"));
  assert.ok(f.logs.includes("alias:validAliasCount=3"));
  const finalCount = Number(f.logs.find(value => value.startsWith("alias:finalCandidateCount=")).split("=")[1]);
  assert.ok(finalCount > 1);
});

test("cadastro sem alias ou Contact confirmado não presume equivalência com @lid", async () => {
  const f = fixture({
    "a@g.us": { isGroup: true, participants: [{ id: "unconfirmed@lid" }] }
  }, {
    registration: {
      primaryIdentity: "5511999999999",
      identityAliases: []
    }
  });
  const result = await f.service.listAuthorizedGroups({
    getContactById: async () => { throw new Error("unavailable"); }
  }, "5511999999999");
  assert.deepEqual(result, []);
  assert.ok(f.logs.includes("alias:storedAliasCount=0"));
  assert.ok(f.logs.includes("alias:validAliasCount=0"));
  const finalCount = Number(f.logs.find(value => value.startsWith("alias:finalCandidateCount=")).split("=")[1]);
  assert.ok(finalCount >= 1);
});

test("passa o GroupChat candidato e não usa o chat privado como fonte de participantes", async () => {
  const groupChat = { isGroup: true, participants: [{ id: "user@lid" }] };
  const f = fixture({ "a@g.us": groupChat });
  let received = null;
  const observingResolver = {
    resolveGroupMember: async input => {
      received = input;
      return {
        ok: true,
        participant: groupChat.participants[0],
        canonicalUserId: "user@lid",
        source: "mention"
      };
    }
  };
  const service = createRaidGroupAccessService({
    groupDirectoryService: {
      getGroupById: async () => f.groups[0],
      formatGroupDisplayName: group => group.name
    },
    groupChatResolverService: {
      clearCache: () => undefined,
      resolveGroupChatWithParticipants: async () => ({
        chat: groupChat,
        participants: groupChat.participants,
        source: "context_chat"
      })
    },
    groupMemberResolverService: observingResolver,
    registrationService: { getRegistrationByIdentity: async () => null },
    permissionService: {
      resolveRole: async () => ({ name: "member" }),
      hasPermission: () => true
    },
    log: () => undefined,
    memberLog: () => undefined
  });
  assert.equal((await service.revalidate({}, "a@g.us", "user@lid")).ok, true);
  assert.equal(received.chat, groupChat);
  assert.equal(received.message.from, "a@g.us");
  assert.equal(received.message.mentionedIds, undefined);
  assert.deepEqual(received.mentionedId.candidates, ["user@lid"]);
});

test("descarta usuário ausente, identidade vazia, grupo inacessível e bot fora", async () => {
  const f = fixture({
    "a@g.us": { isGroup: true, participants: [{ id: "other@lid" }] },
    "b@g.us": { isGroup: true, isReadOnly: true, participants: [{ id: "user@lid" }] },
    "c@g.us": null
  });
  assert.equal((await f.service.revalidate({}, "a@g.us", "user@lid")).code, "user_not_member");
  assert.equal((await f.service.revalidate({}, "a@g.us", null)).code, "identity_not_resolved");
  assert.equal((await f.service.revalidate({}, "b@g.us", "user@lid")).code, "bot_not_member");
  assert.equal((await f.service.revalidate({}, "c@g.us", "user@lid")).ok, false);
  assert.deepEqual(await f.service.listAuthorizedGroups({}, "missing@lid"), []);
});

test("não acrescenta permissão inexistente e respeita negação explícita", async () => {
  const f = fixture({
    "a@g.us": { isGroup: true, participants: [{ id: "user@lid" }] },
    "b@g.us": { isGroup: true, permissionDenied: true, participants: [{ id: "user@lid" }] }
  });
  const groups = await f.service.listAuthorizedGroups({}, "user@lid");
  assert.deepEqual(groups.map(group => group.name), ["Grupo 1"]);
  assert.ok(f.logs.includes("discardReason=permission_denforced"));
});

test("logs mostram somente contadores e motivos controlados", async () => {
  const f = fixture({
    "secret-a@g.us": { isGroup: true, participants: [{ id: "private-user@lid" }] },
    "secret-b@g.us": { isGroup: true, participants: [{ id: "other@lid" }] }
  });
  await f.service.listAuthorizedGroups({}, "private-user@lid");
  const output = f.logs.join("\n");
  assert.match(output, /groupsFound=2/);
  assert.match(output, /groupsAfterMembership=1/);
  assert.match(output, /groupsAfterPermission=1/);
  assert.match(output, /groupsAvailable=1/);
  assert.match(output, /discardReason=user_not_member/);
  assert.match(output, /member:actorResolved=true/);
  assert.match(output, /member:targetCandidates=1/);
  assert.match(output, /member:participantCount=1/);
  assert.match(output, /member:participantCandidates=1/);
  assert.match(output, /member:resultFieldUsed=ok/);
  assert.match(output, /alias:registrationFound=false/);
  assert.match(output, /alias:storedAliasCount=0/);
  assert.match(output, /alias:finalCandidateCount=1/);
  assert.doesNotMatch(output, /secret|private-user|@lid|@c\.us|@g\.us|\d{7,}/);
});
