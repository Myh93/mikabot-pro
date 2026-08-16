"use strict";

const {
  createConfigurationRepository
} = require("../repositories/configurationRepository");
const configurationServiceDefault = require("./configurationService");
const {
  createConfigurationAdministrationService
} = require("./configurationAdministrationService");
const {
  createConfigurationObservabilityService
} = require("./configurationObservabilityService");
const {
  createAuthorizationCallback
} = require("./configurationAuthorizationAdapter");
const permissionServiceDefault = require("./permissionService");

function freezeResult(result) {
  return Object.freeze({ ...result });
}

function createConfigurationBootstrap(options = {}) {
  const hasRepository = !Object.prototype.hasOwnProperty.call(options, "repository") ||
    Boolean(options.repository);
  const repository = Object.prototype.hasOwnProperty.call(options, "repository")
    ? options.repository
    : createConfigurationRepository(options.repositoryOptions);
  const configurationService =
    options.configurationService || configurationServiceDefault;
  const observability = Object.prototype.hasOwnProperty.call(options, "observability")
    ? options.observability
    : createConfigurationObservabilityService(options.observabilityOptions);
  const permissionService = Object.prototype.hasOwnProperty.call(options, "permissionService")
    ? options.permissionService
    : permissionServiceDefault;
  const administrationFactory =
    options.createAdministrationService || createConfigurationAdministrationService;
  const authorizationFactory =
    options.createAuthorizationCallback || createAuthorizationCallback;
  const reportError = options.logError || (() => undefined);
  let initialization = null;
  let state = freezeResult({
    status: "idle",
    persistenceEnabled: false,
    observabilityEnabled: false,
    administrationService: null
  });

  function disableInfrastructure() {
    try { configurationService.detachRepository?.(); } catch (_) {}
    try { configurationService.detachObservability?.(); } catch (_) {}
  }

  async function performInitialization() {
    if (!hasRepository) {
      disableInfrastructure();
      return freezeResult({
        status: "degraded",
        persistenceEnabled: false,
        observabilityEnabled: false,
        administrationService: null,
        reasonCode: "CONFIGURATION_REPOSITORY_UNAVAILABLE"
      });
    }
    try {
      await repository.initialize();
      configurationService.attachRepository(repository);
      await configurationService.initialize();

      let observabilityEnabled = false;
      if (observability) {
        observabilityEnabled = Boolean(
          configurationService.attachObservability(observability)
        );
      }

      const authorize = authorizationFactory(permissionService, observability);
      if (typeof authorize !== "function") {
        const error = new Error("Callback de autorização indisponível.");
        error.code = "CONFIGURATION_AUTHORIZATION_CALLBACK_UNAVAILABLE";
        throw error;
      }
      const administrationService = administrationFactory({
        configurationService,
        authorize
      });
      if (!administrationService) {
        const error = new Error("Serviço administrativo indisponível.");
        error.code = "CONFIGURATION_ADMINISTRATION_UNAVAILABLE";
        throw error;
      }
      return freezeResult({
        status: "ready",
        persistenceEnabled: true,
        observabilityEnabled,
        administrationService
      });
    } catch (error) {
      disableInfrastructure();
      try {
        reportError("Erro ao inicializar a infraestrutura de configuração:", error);
      } catch (_) {}
      return freezeResult({
        status: "degraded",
        persistenceEnabled: false,
        observabilityEnabled: false,
        administrationService: null,
        reasonCode: String(error?.code || error?.name || "CONFIGURATION_BOOTSTRAP_FAILED")
      });
    }
  }

  function initialize() {
    if (!initialization) {
      initialization = performInitialization().then((result) => {
        state = result;
        return result;
      });
    }
    return initialization;
  }

  function getState() {
    return state;
  }

  return Object.freeze({ initialize, getState });
}

const defaultBootstrap = createConfigurationBootstrap();

module.exports = {
  createConfigurationBootstrap,
  initializeConfigurationInfrastructure: defaultBootstrap.initialize,
  getConfigurationInfrastructureState: defaultBootstrap.getState
};
