"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const legacyConfig = require("../config.json");
const {
  createPermissionService,
  ROLE_RANK
} = require("../src/services/permissionService");
const {
  createConfigurationService
} = require("../src/services/configurationService");
const {
  createConfigurationRepository
} = require("../src/repositories/configurationRepository");

const LEGACY = Object.freeze({
  protectedOwnerNumber: "5511999999999",
  ownerNumbers: ["5511888888888"],
  trustedGroupCreatorNumber: "5511777777777",
  adminNumbers: ["5511666666666"]
});

function configuration(values = {}, error = null) {
  return {
    getResolved(key) {
      if (error) throw error;
      return { key, value: values[key], source: "test" };
    }
  };
}

function groupContext(identity, participant = {}) {
  return {
    identity,
    msg: { from: "group@g.us" },
    chat: {
      isGroup: true,
      participants: [{ id: identity, ...participant }]
    },
    client: { info: { wid: "bot@c.us" } }
  };
}

test("preserva comportamento legado e APIs públicas síncronas", async () => {
  const service = createPermissionService(LEGACY, { configurationService: null });
  assert.equal(service.isProtectedOwner(LEGACY.protectedOwnerNumber), true);
  assert.equal(service.isOwner(LEGACY.ownerNumbers[0]), true);
  assert.equal(
    service.isTrustedGroupCreator(
      LEGACY.trustedGroupCreatorNumber,
      groupContext(LEGACY.trustedGroupCreatorNumber, { isSuperAdmin: true })
    ),
    true
  );
  assert.equal(service.isGroupAdmin("admin@lid", groupContext("admin@lid", {
    isAdmin: true
  })), true);
  assert.equal(typeof service.isOwner("member@lid"), "boolean");
  assert.equal(typeof service.isProtectedOwner("member@lid"), "boolean");
  assert.deepEqual(Object.keys(service).sort(), [
    "hasPermission",
    "isGroupAdmin",
    "isModerator",
    "isOwner",
    "isProtectedOwner",
    "isTrustedGroupCreator",
    "resolveRole"
  ]);

  const defaultService = createPermissionService();
  assert.equal(
    defaultService.isProtectedOwner(legacyConfig.protectedOwnerNumber),
    true
  );
});

test("usa fallback legado com serviço ausente, exceção, undefined e tipos inválidos", () => {
  const cases = [
    null,
    configuration({}, new Error("configuration unavailable")),
    configuration({}),
    configuration({
      "permissions.protectedOwnerNumber": null,
      "permissions.ownerNumbers": "owner",
      "permissions.trustedGroupCreatorNumber": " ",
      "permissions.adminNumbers": {}
    })
  ];

  for (const configurationService of cases) {
    const service = createPermissionService(LEGACY, { configurationService });
    assert.equal(service.isProtectedOwner(LEGACY.protectedOwnerNumber), true);
    assert.equal(service.isOwner(LEGACY.ownerNumbers[0]), true);
    assert.equal(
      service.isTrustedGroupCreator(
        LEGACY.trustedGroupCreatorNumber,
        groupContext(LEGACY.trustedGroupCreatorNumber, { isSuperAdmin: true })
      ),
      true
    );
  }
});

test("override runtime altera somente as quatro configurações administrativas", async () => {
  const configService = createConfigurationService();
  configService.set("permissions.protectedOwnerNumber", "runtime-owner@lid");
  configService.set("permissions.ownerNumbers", ["runtime-extra@lid"]);
  configService.set(
    "permissions.trustedGroupCreatorNumber",
    "runtime-creator@lid"
  );
  configService.set("permissions.adminNumbers", ["runtime-admin@lid"]);
  const service = createPermissionService(LEGACY, {
    configurationService: configService
  });

  assert.equal((await service.resolveRole(groupContext("runtime-owner@lid"))).name,
    "protectedOwner");
  assert.equal((await service.resolveRole(groupContext("runtime-extra@lid"))).name,
    "owner");
  assert.equal((await service.resolveRole(groupContext(
    "runtime-creator@lid",
    { isSuperAdmin: true }
  ))).name, "trustedGroupCreator");
  assert.equal((await service.resolveRole(groupContext("runtime-admin@lid"))).name,
    "admin");
});

test("override persistente global é consumido sem alterar bancos existentes", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-permission-config-"));
  try {
    const repository = createConfigurationRepository({
      databaseDir: path.join(root, "database"),
      backupRoot: path.join(root, "backups")
    });
    const configService = createConfigurationService();
    configService.attachRepository(repository);
    await configService.initialize();
    await configService.setPersistent(
      "permissions.ownerNumbers",
      ["persistent-owner@lid"]
    );
    const service = createPermissionService(LEGACY, {
      configurationService: configService
    });
    assert.equal(
      (await service.resolveRole(groupContext("persistent-owner@lid"))).name,
      "owner"
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("preserva admin real, moderador, membro e número conectado", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-permission-roles-"));
  const rolesFile = path.join(root, "roles.json");
  await fsp.writeFile(rolesFile, JSON.stringify({ mods: ["moderator@lid"] }));
  try {
    const service = createPermissionService(LEGACY, {
      configurationService: configuration({}),
      rolesFile
    });
    assert.equal((await service.resolveRole(groupContext(
      "whatsapp-admin@lid",
      { isAdmin: true }
    ))).name, "admin");
    assert.equal((await service.resolveRole(
      groupContext("moderator@lid")
    )).name, "moderator");
    assert.equal((await service.resolveRole(
      groupContext("ordinary@lid")
    )).name, "member");
    assert.equal((await service.resolveRole({
      ...groupContext("bot@c.us"),
      client: { info: { wid: "bot@c.us" } }
    })).name, "member");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("preserva identidades @lid e variantes brasileiras seguras", () => {
  const service = createPermissionService({
    ...LEGACY,
    protectedOwnerNumber: "protected@lid",
    ownerNumbers: ["5511987654321"]
  }, { configurationService: null });

  assert.equal(service.isProtectedOwner("protected@lid"), true);
  assert.equal(service.isOwner("551187654321"), true);
  assert.equal(service.isOwner("5511987654321@c.us"), true);
  assert.equal(service.isOwner("987654321"), false);
});

test("ROLE_RANK e hasPermission permanecem inalterados", () => {
  assert.deepEqual(ROLE_RANK, {
    member: 0,
    moderator: 1,
    admin: 2,
    trustedGroupCreator: 3,
    owner: 4,
    protectedOwner: 5
  });
  const service = createPermissionService(LEGACY, { configurationService: null });
  assert.equal(service.hasPermission({ name: "protectedOwner", rank: 5 }, {
    protectedOwnerOnly: true
  }), true);
  assert.equal(service.hasPermission({ name: "owner", rank: 4 }, {
    protectedOwnerOnly: true
  }), false);
  assert.equal(service.hasPermission({ name: "owner", rank: 4 }, {
    ownerOnly: true
  }), true);
  assert.equal(service.hasPermission({ name: "admin", rank: 2 }, {
    adminOnly: true
  }), true);
  assert.equal(service.hasPermission({ name: "moderator", rank: 1 }, {
    moderatorOnly: true
  }), true);
  assert.equal(service.hasPermission({ name: "member", rank: 0 }, {}), true);
});
