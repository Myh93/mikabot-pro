"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createConfigurationRepository } = require("../src/repositories/configurationRepository");
const { createConfigurationService } = require("../src/services/configurationService");
const {
  createConfigurationAdministrationService
} = require("../src/services/configurationAdministrationService");
const {
  createConfigurationObservabilityService
} = require("../src/services/configurationObservabilityService");

test("escrita administrativa executa uma única validação persistente", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-config-audit-"));
  try {
    const repository = createConfigurationRepository({
      databaseDir: path.join(root, "database"),
      backupRoot: path.join(root, "backups")
    });
    const configurationService = createConfigurationService();
    const observability = createConfigurationObservabilityService();
    configurationService.attachRepository(repository);
    configurationService.attachObservability(observability);
    await configurationService.initialize();
    const administration = createConfigurationAdministrationService({
      configurationService,
      authorize: async () => true
    });
    await administration.setConfiguration("quiz.ranking.pageSize", 20, {
      authorCanonical: "canonical-owner",
      origin: "architecture-audit"
    });
    assert.equal(
      observability.getMetrics()["configuration.validation.success"],
      1
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("reload de comunidade+plataforma exige ambos os escopos", async () => {
  const definition = Object.freeze({
    key: "sample.platformOnly",
    namespace: "sample",
    type: "integer",
    allowedScopes: ["platform"],
    sensitivity: "operational",
    overrideAllowed: true,
    invariant: false,
    secret: false,
    nullable: false
  });
  const catalog = {
    hasDefinition: (key) => key === definition.key,
    getDefinition: (key) => key === definition.key ? definition : null,
    getDefault: () => 1,
    listDefinitions: () => [definition],
    listNamespaces: () => ["sample"]
  };
  const service = createConfigurationService({ catalog });
  service.attachRepository({
    async initialize() {},
    async readGlobal() { return { values: {} }; },
    async readCommunities() { return { communities: {} }; },
    async readPlatforms() {
      return {
        platforms: {
          "community-1:whatsapp": {
            values: { "sample.platformOnly": 2 }
          }
        }
      };
    },
    async readGroups() { return { groups: {} }; }
  });
  await assert.rejects(
    service.reload(),
    (error) => error.code === "CONFIGURATION_SCOPE_INVALID"
  );
});
