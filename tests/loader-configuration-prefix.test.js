"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const actualConfigurationService = require("../src/services/configurationService");

const loaderPath = require.resolve("../src/loader");
const dependencyPaths = {
  configuration: require.resolve("../src/services/configurationService"),
  platformContext: require.resolve("../src/utils/platformContext"),
  groupDirectory: require.resolve("../src/services/groupDirectoryService"),
  warningLimiter: require.resolve("../src/utils/whatsappWarningLimiter"),
  marathon: require.resolve("../src/services/quizMarathonService"),
  antiLink: require.resolve("../src/services/antiLinkService"),
  joinRequest: require.resolve("../src/services/joinRequestService"),
  memberLeave: require.resolve("../src/services/memberLeaveService"),
  quizAnswer: require.resolve("../src/events/quizAnswer"),
  menuAnswer: require.resolve("../src/events/menuAnswer"),
  guidedFlow: require.resolve("../src/events/guidedFlowAnswer"),
  registrationFlow: require.resolve("../src/events/registrationGuidedFlowAnswer")
  , registrationAccess: require.resolve("../src/services/registrationAccessService")
};

function loadFixture(options = {}) {
  const originals = new Map();
  const controls = {
    antiLinkCalls: 0,
    quizCalls: 0,
    guidedCalls: 0,
    registrationCalls: 0,
    menuCalls: 0,
    quizActive: false,
    guidedActive: false,
    registrationActive: false,
    menuActive: false
  };

  function mock(modulePath, exports) {
    originals.set(modulePath, require.cache[modulePath]);
    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports
    };
  }

  const prefixResolver = options.getResolved || (() => ({
    key: "system.commandPrefix",
    value: "!",
    source: "default"
  }));
  mock(dependencyPaths.configuration, {
    ...actualConfigurationService,
    getResolved(key, context) {
      return key === "system.commandPrefix"
        ? prefixResolver(key, context)
        : actualConfigurationService.getResolved(key, context);
    }
  });
  mock(dependencyPaths.platformContext, {
    createPlatformContext: async (_client, msg) => ({
      platform: msg.context?.platform ?? "whatsapp",
      groupId: msg.context?.groupId ?? msg.from,
      communityId: msg.context?.communityId,
      userId: msg.author || msg.from,
      isGroup: String(msg.from || "").endsWith("@g.us")
    })
  });
  mock(dependencyPaths.groupDirectory, { registerSeenGroup: async () => null });
  mock(dependencyPaths.warningLimiter, { warn: () => undefined });
  mock(dependencyPaths.marathon, { resume: async () => null });
  mock(dependencyPaths.antiLink, {
    handleIncomingMessage: async () => {
      controls.antiLinkCalls += 1;
      return options.antiLinkResult || { status: "allowed" };
    }
  });
  mock(dependencyPaths.joinRequest, {
    start: () => undefined,
    stop: () => undefined,
    handleEvent: async () => undefined
  });
  mock(dependencyPaths.memberLeave, {
    handleNotification: async () => undefined,
    handleJoinNotification: async () => undefined
  });
  mock(dependencyPaths.quizAnswer, {
    hasActiveRound: async () => controls.quizActive,
    handleQuizAnswer: async () => { controls.quizCalls += 1; }
  });
  mock(dependencyPaths.guidedFlow, {
    hasActiveFlow: async () => controls.guidedActive,
    handleGuidedFlowAnswer: async () => { controls.guidedCalls += 1; }
  });
  mock(dependencyPaths.registrationFlow, {
    hasActiveFlow: async () => controls.registrationActive,
    handleRegistrationGuidedFlowAnswer: async () => {
      controls.registrationCalls += 1;
    }
  });
  mock(dependencyPaths.registrationAccess, {
    MESSAGE: "registration required",
    authorize: async () => ({ allowed: true, state: "active" })
  });
  mock(dependencyPaths.menuAnswer, {
    hasActiveMenu: async () => controls.menuActive,
    handleMenuAnswer: async () => { controls.menuCalls += 1; }
  });

  const previousLoader = require.cache[loaderPath];
  delete require.cache[loaderPath];
  const loader = require(loaderPath);
  const executed = [];
  loader.__prefixProbe = {
    name: "prefixprobe",
    aliases: [],
    async execute(_client, _msg, args) {
      executed.push(args);
    }
  };
  loader.statusmembro = {
    name: "statusmembro",
    aliases: [],
    async execute(_client, _msg, args) {
      executed.push(args);
    }
  };

  const listeners = new Map();
  const client = {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(listener);
    },
    sendMessage: async () => undefined
  };
  loader.attach(client);

  async function send(body, context = {}) {
    const message = {
      fromMe: false,
      from: context.from || "group@g.us",
      author: "user@lid",
      body,
      context,
      reply: async () => undefined
    };
    await listeners.get("message")[0](message);
  }

  function cleanup() {
    loader.detach(client);
    delete require.cache[loaderPath];
    if (previousLoader) require.cache[loaderPath] = previousLoader;
    for (const [modulePath, original] of originals) {
      if (original) require.cache[modulePath] = original;
      else delete require.cache[modulePath];
    }
  }

  return { loader, client, listeners, controls, executed, send, cleanup };
}

test("usa o default ! e resolve o prefixo somente uma vez por mensagem", async () => {
  let resolutions = 0;
  const fixture = loadFixture({
    getResolved(key, context) {
      resolutions += 1;
      assert.equal(key, "system.commandPrefix");
      assert.deepEqual(context, {
        communityId: "community-1",
        platform: "whatsapp",
        groupId: "group@g.us"
      });
      return { key, value: "!", source: "default" };
    }
  });
  try {
    await fixture.send("!prefixprobe argumento", { communityId: "community-1" });
    assert.equal(resolutions, 1);
    assert.deepEqual(fixture.executed, [["argumento"]]);
  } finally {
    fixture.cleanup();
  }
});

test("reutiliza o mesmo override runtime em startsWith e slice", async () => {
  let resolutions = 0;
  const fixture = loadFixture({
    getResolved: () => {
      resolutions += 1;
      return { value: "::", source: "runtime" };
    }
  });
  try {
    await fixture.send("::prefixprobe primeiro segundo");
    assert.equal(resolutions, 1);
    assert.deepEqual(fixture.executed, [["primeiro", "segundo"]]);
  } finally {
    fixture.cleanup();
  }
});

test("aceita override persistente resolvido para grupo, comunidade e plataforma", async () => {
  const cases = [
    [{ groupId: "group@g.us", communityId: "c1", platform: "whatsapp" }, "%%"],
    [{ groupId: "", communityId: "c1", platform: "whatsapp" }, "$$"],
    [{ groupId: "", communityId: undefined, platform: "telegram" }, "##"]
  ];
  let currentPrefix = "!";
  const seen = [];
  const fixture = loadFixture({
    getResolved(_key, context) {
      seen.push(context);
      return { value: currentPrefix, source: "persistent" };
    }
  });
  try {
    for (const [context, prefix] of cases) {
      currentPrefix = prefix;
      await fixture.send(`${prefix}prefixprobe ${prefix}`, context);
    }
    assert.deepEqual(fixture.executed, [[ "%%" ], [ "$$" ], [ "##" ]]);
    assert.deepEqual(seen, cases.map(([context]) => context));
  } finally {
    fixture.cleanup();
  }
});

test("usa fallback ! quando o ConfigurationService falha ou retorna valor inválido", async () => {
  let shouldThrow = true;
  const fixture = loadFixture({
    getResolved() {
      if (shouldThrow) throw new Error("repository unavailable");
      return { value: "" };
    }
  });
  try {
    await fixture.send("!prefixprobe erro");
    shouldThrow = false;
    await fixture.send("!prefixprobe invalido");
    assert.deepEqual(fixture.executed, [["erro"], ["invalido"]]);
  } finally {
    fixture.cleanup();
  }
});

test("preserva comandos disciplinares com / e ignora mensagens comuns", async () => {
  const fixture = loadFixture({ getResolved: () => ({ value: "::" }) });
  try {
    await fixture.send("/statusmembro alvo");
    await fixture.send("prefixprobe conversa");
    assert.deepEqual(fixture.executed, [["alvo"]]);
  } finally {
    fixture.cleanup();
  }
});

test("preserva a ordem Anti-Link, Quiz, Cadastro, Guided Flow e Menu", async () => {
  const fixture = loadFixture();
  try {
    fixture.controls.quizActive = true;
    await fixture.send("resposta quiz");
    assert.equal(fixture.controls.quizCalls, 1);
    assert.equal(fixture.controls.antiLinkCalls, 1);

    fixture.controls.quizActive = false;
    fixture.controls.registrationActive = true;
    await fixture.send("resposta cadastro");
    assert.equal(fixture.controls.registrationCalls, 1);

    fixture.controls.registrationActive = false;
    fixture.controls.guidedActive = true;
    await fixture.send("resposta guiada");
    assert.equal(fixture.controls.guidedCalls, 1);

    fixture.controls.guidedActive = false;
    fixture.controls.menuActive = true;
    await fixture.send("1");
    assert.equal(fixture.controls.menuCalls, 1);
    assert.equal(fixture.controls.antiLinkCalls, 4);
  } finally {
    fixture.cleanup();
  }
});

test("mensagem prefixada não é tratada como resposta de Quiz ou menu", async () => {
  const fixture = loadFixture();
  try {
    fixture.controls.quizActive = true;
    fixture.controls.menuActive = true;
    await fixture.send("!prefixprobe");
    assert.equal(fixture.executed.length, 1);
    assert.equal(fixture.controls.quizCalls, 0);
    assert.equal(fixture.controls.menuCalls, 0);
  } finally {
    fixture.cleanup();
  }
});

test("mantém um único listener central após múltiplos attach", () => {
  const fixture = loadFixture();
  try {
    fixture.loader.attach(fixture.client);
    assert.equal(fixture.listeners.get("message").length, 1);
  } finally {
    fixture.cleanup();
  }
});
