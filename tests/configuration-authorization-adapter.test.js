"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createAuthorizationCallback,
  ACTION_PERMISSIONS,
  PERMISSION_REQUIREMENTS
} = require("../src/services/configurationAuthorizationAdapter");

function permissionMock(options = {}) {
  const calls = [];
  return {
    calls,
    service: {
      async resolveRole(context) {
        calls.push({ method: "resolveRole", context });
        if (options.resolveError) throw new Error("internal details");
        return options.role || { name: "owner", rank: 4 };
      },
      async hasPermission(role, requirement) {
        calls.push({ method: "hasPermission", role, requirement });
        if (options.permissionError) throw new Error("sensitive details");
        return options.allowed !== false;
      }
    }
  };
}

const GLOBAL = { identity: { canonicalId: "owner" } };

test("autoriza e nega leitura usando adminOnly", async () => {
  const accepted = permissionMock();
  assert.equal(
    await createAuthorizationCallback(accepted.service)("getConfiguration", GLOBAL),
    true
  );
  assert.deepEqual(accepted.calls[1].requirement, { adminOnly: true });

  const denied = permissionMock({ allowed: false });
  await assert.rejects(
    createAuthorizationCallback(denied.service)("configuration.read", GLOBAL),
    (error) => error.code === "CONFIGURATION_AUTHORIZATION_DENIED"
  );
});

test("autoriza e nega escrita usando ownerOnly", async () => {
  const accepted = permissionMock();
  await createAuthorizationCallback(accepted.service)("setConfiguration", GLOBAL);
  assert.deepEqual(accepted.calls[1].requirement, { ownerOnly: true });

  const denied = permissionMock({ allowed: false });
  await assert.rejects(
    createAuthorizationCallback(denied.service)("configuration.write", GLOBAL),
    (error) => error.code === "CONFIGURATION_AUTHORIZATION_DENIED"
  );
});

test("autoriza e nega remoção usando ownerOnly", async () => {
  const accepted = permissionMock();
  await createAuthorizationCallback(accepted.service)("removeConfiguration", GLOBAL);
  assert.deepEqual(accepted.calls[1].requirement, { ownerOnly: true });

  const denied = permissionMock({ allowed: false });
  await assert.rejects(
    createAuthorizationCallback(denied.service)("configuration.remove", GLOBAL),
    (error) => error.code === "CONFIGURATION_AUTHORIZATION_DENIED"
  );
});

test("mapeia listagem e validação para permissões administrativas", async () => {
  const item = permissionMock();
  const authorize = createAuthorizationCallback(item.service);
  await authorize("listConfigurations", GLOBAL);
  await authorize("listOverrides", GLOBAL);
  await authorize("validateConfiguration", GLOBAL);
  assert.deepEqual(
    item.calls.filter((call) => call.method === "hasPermission")
      .map((call) => call.requirement),
    [{ adminOnly: true }, { adminOnly: true }, { adminOnly: true }]
  );
  assert.equal(ACTION_PERMISSIONS.getConfigurationSource, "configuration.read");
  assert.deepEqual(PERMISSION_REQUIREMENTS["configuration.validate"], { adminOnly: true });
});

test("normaliza e encaminha todos os escopos", async () => {
  const item = permissionMock();
  const authorize = createAuthorizationCallback(item.service);
  const cases = [
    [{ user: "owner" }, "global"],
    [{ user: "owner", communityId: " community-1 " }, "community"],
    [{ user: "owner", platform: " WhatsApp " }, "platform"],
    [{
      user: "owner", communityId: "community-1", platform: " WhatsApp "
    }, "communityPlatform"],
    [{
      user: "owner", platform: " WhatsApp ", groupId: " group-1 "
    }, "group"]
  ];
  for (const [context, scope] of cases) {
    await authorize("configuration.read", context);
    const received = item.calls.filter((call) => call.method === "resolveRole").at(-1).context;
    assert.equal(received.scope, scope);
    assert.equal(received.platform, context.platform ? "whatsapp" : "");
    if (context.groupId) assert.equal(received.groupId, "group-1");
    if (context.communityId) assert.equal(received.communityId, "community-1");
  }
});

test("rejeita contexto inválido antes de consultar permissões", async () => {
  const item = permissionMock();
  const authorize = createAuthorizationCallback(item.service);
  for (const context of [
    null,
    {},
    { user: "owner", scope: "community" },
    { user: "owner", scope: "platform" },
    { user: "owner", scope: "communityPlatform", communityId: "c1" },
    { user: "owner", scope: "group" }
  ]) {
    await assert.rejects(
      authorize("configuration.read", context),
      (error) => error.code === "CONFIGURATION_AUTHORIZATION_INVALID_CONTEXT"
    );
  }
  assert.equal(item.calls.length, 0);
});

test("rejeita ação sem mapeamento", async () => {
  const item = permissionMock();
  await assert.rejects(
    createAuthorizationCallback(item.service)("unknownAction", GLOBAL),
    (error) => error.code === "CONFIGURATION_AUTHORIZATION_INVALID_CONTEXT"
  );
  assert.equal(item.calls.length, 0);
});

test("callback inexistente ou PermissionService incompleto gera erro padronizado", () => {
  for (const service of [
    null,
    {},
    { resolveRole() {} },
    { hasPermission() {} }
  ]) {
    assert.throws(
      () => createAuthorizationCallback(service),
      (error) => error.code === "CONFIGURATION_AUTHORIZATION_INTERNAL_ERROR"
    );
  }
});

test("não propaga erro interno do PermissionService", async () => {
  for (const options of [{ resolveError: true }, { permissionError: true }]) {
    const item = permissionMock(options);
    await assert.rejects(
      createAuthorizationCallback(item.service)("configuration.read", GLOBAL),
      (error) =>
        error.code === "CONFIGURATION_AUTHORIZATION_INTERNAL_ERROR" &&
        !error.message.includes("details")
    );
  }
});

test("preserva contexto necessário ao PermissionService sem dependência circular", async () => {
  const item = permissionMock();
  const chat = { isGroup: true, participants: [] };
  const participant = { isAdmin: true };
  const msg = { from: "group@g.us" };
  await createAuthorizationCallback(item.service)("configuration.read", {
    authorCanonical: "canonical-owner",
    platform: "whatsapp",
    groupId: "group-1",
    chat,
    participant,
    msg
  });
  const received = item.calls[0].context;
  assert.equal(received.identity, "canonical-owner");
  assert.equal(received.chat, chat);
  assert.equal(received.participant, participant);
  assert.equal(received.msg, msg);
});
