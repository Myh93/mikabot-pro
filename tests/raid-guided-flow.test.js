"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createGuidedFlowService } = require("../src/services/guidedFlowService");
const { createRaidGuidedFlowService } = require("../src/services/raidGuidedFlowService");
const { createRaidService } = require("../src/services/raidService");
const { createRepository } = require("../src/repositories/raidRepository");

async function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-raid-flow-"));
  let now = new Date("2026-07-25T15:00:00.000Z");
  let allowed = options.allowed !== false;
  let calls = 0;
  const repository = createRepository(path.join(root, "raids.json"));
  const official = createRaidService(repository, {
    listRegistrations: async () => [],
    getRegistrationByIdentity: async () => null
  });
  const raidService = options.raidService || {
    ...official,
    createRaidFromMessage: async (...args) => {
      calls += 1;
      return official.createRaidFromMessage(...args);
    }
  };
  const guided = createGuidedFlowService({
    filePath: path.join(root, "flows.json"),
    ttlMs: 15 * 60 * 1000,
    clock: () => new Date(now)
  });
  let menuClosed = 0;
  const confirmLogs = [];
  const aliasLogs = [];
  const destinationLogs = [];
  const flow = createRaidGuidedFlowService({
    guidedFlowService: guided,
    raidService,
    authorize: async () => allowed,
    raidGroupAccessService: options.raidGroupAccessService,
    confirmLog: value => confirmLogs.push(value),
    aliasLog: value => aliasLogs.push(value),
    destinationLog: value => destinationLogs.push(value),
    menuSessionService: { closeMenu: async () => { menuClosed += 1; return true; } },
    raidPokemonCatalogService: options.raidPokemonCatalogService || {
      resolve: value => {
        const normalized = String(value).trim().toLowerCase();
        if (normalized === "25" || normalized === "pikachu") return "Pikachu";
        if (normalized === "rayquaza") return "Rayquaza";
        return null;
      }
    },
    pokemonDataService: {
      getPokemonByNumber: number => number === 25 ? { nome: "Pikachu" } : null,
      getPokemonByName: name => {
        const normalized = String(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        return ({ pikachu: { nome: "Pikachu" }, rayquaza: { nome: "Rayquaza" } })[normalized] || null;
      }
    }
  });
  return {
    root, repository, official, raidService, guided, flow,
    calls: () => calls,
    confirmLogs,
    aliasLogs,
    destinationLogs,
    menuClosed: () => menuClosed,
    setAllowed: value => { allowed = value; },
    advanceClock: milliseconds => { now = new Date(now.getTime() + milliseconds); }
  };
}

function context(overrides = {}) {
  const replies = [];
  const groupId = overrides.groupId || "group-a@g.us";
  const userId = overrides.userId || "user-a";
  return {
    platform: "whatsapp", groupId, conversationId: groupId, userId, isGroup: true, replies,
    message: {
      from: groupId,
      author: `${userId}@lid`,
      getContact: async () => ({ number: userId })
    },
    client: {
      sendMessage: async () => ({ id: { _serialized: `message-${Date.now()}-${Math.random()}` } })
    },
    replyText: async text => { replies.push(String(text)); return text; },
    ...overrides
  };
}

async function reachReview(flow, ctx, players = "5") {
  await flow.start(ctx);
  await flow.handleAnswer(ctx, "Rayquaza");
  await flow.handleAnswer(ctx, "-7.163456,-38.501234");
  await flow.handleAnswer(ctx, "18:30");
  await flow.handleAnswer(ctx, "45");
  return flow.handleAnswer(ctx, players);
}

test("validadores aceitam Pokémon, Pokédex, coordenadas, horário e inteiros válidos", async () => {
  const { flow } = await fixture();
  assert.equal(flow.resolvePokemon("Pikachu"), "Pikachu");
  assert.equal(flow.resolvePokemon("25"), "Pikachu");
  assert.equal(flow.parseCoordinates("-7.163456,-38.501234"), "-7.163456,-38.501234");
  assert.equal(flow.parseCoordinates(" -7.163456   -38.501234 "), "-7.163456,-38.501234");
  assert.equal(flow.parseTime("23:59"), "23:59");
  assert.equal(flow.parsePositiveInteger("45", 180), 45);
});

test("validadores rejeitam Pokémon, coordenadas, horário e minutos inválidos", async () => {
  const { flow } = await fixture();
  assert.equal(flow.resolvePokemon("inexistente"), null);
  assert.equal(flow.parseCoordinates("91,0"), null);
  assert.equal(flow.parseCoordinates("0,181"), null);
  assert.equal(flow.parseTime("24:00"), null);
  assert.equal(flow.parseTime("18h30"), null);
  assert.equal(flow.parsePositiveInteger("0", 180), null);
  assert.equal(flow.parsePositiveInteger("181", 180), null);
  assert.equal(flow.parsePositiveInteger("texto", 180), null);
});

test("forma ambígua abre seleção e continua para coordenadas após escolha", async () => {
  const f = await fixture({
    raidPokemonCatalogService: {
      resolve: () => null,
      resolveDetailed: value => String(value).toLowerCase() === "mega charizard"
        ? { status: "ambiguous", value: null, options: ["Mega Charizard X", "Mega Charizard Y"] }
        : { status: "invalid", value: null, options: [] }
    }
  });
  const ctx = context();
  await f.flow.start(ctx);
  const ambiguous = await f.flow.handleAnswer(ctx, "Mega Charizard");
  assert.equal(ambiguous.session.step, "pokemon_ambiguity");
  assert.match(ctx.replies.at(-1), /Mega Charizard X[\s\S]*Mega Charizard Y/);
  const selected = await f.flow.handleAnswer(ctx, "2");
  assert.equal(selected.session.step, "coordinates");
  assert.equal(selected.session.data.pokemon, "Mega Charizard Y");
});

test("fluxo coleta campos, mostra revisão e cria pela função oficial uma única vez", async () => {
  const f = await fixture();
  const ctx = context();
  const review = await reachReview(f.flow, ctx);
  assert.equal(review.status, "review");
  assert.match(ctx.replies.at(-1), /Rayquaza/);
  assert.match(ctx.replies.at(-1), /-7\.163456,-38\.501234/);
  assert.match(ctx.replies.at(-1), /18:30/);
  assert.match(ctx.replies.at(-1), /45 minutos/);
  assert.match(ctx.replies.at(-1), /5/);
  const result = await f.flow.handleAnswer(ctx, "confirmar");
  assert.equal(result.status, "created");
  assert.equal(f.calls(), 1);
  assert.equal(f.repository.listActiveRaids(ctx.groupId).length, 1);
  assert.equal(await f.flow.hasActiveFlow(ctx), false);
});

test("jogadores recomendados podem ser pulados sem alterar o modelo persistido", async () => {
  const f = await fixture();
  const ctx = context();
  await reachReview(f.flow, ctx, "não sei");
  assert.match(ctx.replies.at(-1), /Não informado/);
  await f.flow.handleAnswer(ctx, "1");
  const [raid] = f.repository.listActiveRaids(ctx.groupId);
  assert.equal(Object.hasOwn(raid, "recommendedPlayers"), false);
});

test("erros mantêm a etapa e permitem nova resposta", async () => {
  const f = await fixture();
  const ctx = context();
  await f.flow.start(ctx);
  for (const [invalid, valid, expected] of [
    ["MissingNo", "Pikachu", "coordinates"],
    ["91,181", "-7 -38", "startTime"],
    ["25:90", "08:05", "remainingMinutes"],
    ["texto", "30", "recommendedPlayers"],
    ["-1", "pular", "review"]
  ]) {
    assert.equal((await f.flow.handleAnswer(ctx, invalid)).status, "validation_error");
    await f.flow.handleAnswer(ctx, valid);
    const session = await f.guided.getActiveFlow("whatsapp", ctx.groupId, ctx.userId);
    assert.equal(session.step, expected);
  }
});

test("edição altera cada campo isoladamente e retorna à revisão", async () => {
  const f = await fixture();
  const ctx = context();
  await reachReview(f.flow, ctx);
  const edits = [
    ["1", "Pikachu", "pokemon", "Pikachu"],
    ["2", "-8,-39", "coordinates", "-8,-39"],
    ["3", "20:15", "startTime", "20:15"],
    ["4", "60", "remainingMinutes", 60],
    ["5", "pular", "recommendedPlayers", null]
  ];
  for (const [choice, value, field, expected] of edits) {
    await f.flow.handleAnswer(ctx, "editar");
    await f.flow.handleAnswer(ctx, choice);
    const result = await f.flow.handleAnswer(ctx, value);
    assert.equal(result.status, "review");
    assert.equal(result.session.data[field], expected);
  }
});

test("voltar usa histórico e cancelar encerra sem criar", async () => {
  const f = await fixture();
  const ctx = context();
  await f.flow.start(ctx);
  await f.flow.handleAnswer(ctx, "Pikachu");
  const back = await f.flow.handleAnswer(ctx, "voltar");
  assert.equal(back.session.step, "pokemon");
  const cancelled = await f.flow.handleAnswer(ctx, "sair");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(f.repository.listActiveRaids(ctx.groupId).length, 0);
});

test("menu é fechado ao iniciar e fluxo existente é retomado", async () => {
  const f = await fixture();
  const ctx = context();
  assert.equal((await f.flow.start(ctx)).status, "started");
  assert.equal(f.menuClosed(), 1);
  assert.equal((await f.flow.start(ctx)).status, "resumed");
  assert.equal(f.menuClosed(), 1);
});

test("outro fluxo não é sobrescrito silenciosamente", async () => {
  const f = await fixture();
  const ctx = context();
  await f.guided.startFlow({ flowId: "registration", platform: "whatsapp", conversationId: ctx.groupId, userId: ctx.userId, step: "nick", data: {} });
  assert.equal((await f.flow.start(ctx)).status, "conflict");
  assert.equal((await f.guided.getActiveFlow("whatsapp", ctx.groupId, ctx.userId)).flowId, "registration");
});

test("sessões isolam dois usuários, dois grupos e privado", async () => {
  const f = await fixture();
  const contexts = [
    context({ userId: "a" }),
    context({ userId: "b" }),
    context({ userId: "a", groupId: "group-b@g.us" }),
    context({ userId: "a", groupId: "private-a", conversationId: "private-a", isGroup: false })
  ];
  for (const ctx of contexts) await f.flow.start(ctx);
  for (const ctx of contexts) assert.equal(await f.flow.hasActiveFlow(ctx), true);
});

test("confirmação privada reutiliza a identidade completa salva no início do fluxo", async () => {
  const accessCalls = [];
  const groups = [{ id: "group-a", name: "Grupo A", aliases: [] }];
  const f = await fixture({
    raidGroupAccessService: {
      listAuthorizedGroups: async (_client, identity) => {
        accessCalls.push(identity);
        return identity?.candidates?.includes("confirmed-private@lid") ? groups : [];
      },
      revalidate: async () => ({ ok: true })
    }
  });
  const initial = context({
    groupId: "private-user",
    conversationId: "private-user",
    userId: "5511999999999",
    isGroup: false,
    identity: {
      id: "5511999999999",
      candidates: ["5511999999999", "confirmed-private@lid"]
    }
  });
  await reachReview(f.flow, initial);
  const rebuilt = {
    ...initial,
    identity: { id: "5511999999999", candidates: ["5511999999999"] }
  };
  const result = await f.flow.handleAnswer(rebuilt, "1");
  assert.equal(result.status, "advanced");
  assert.equal(result.session.step, "destination_mode");
  assert.equal(accessCalls.length, 1);
  assert.ok(accessCalls[0].candidates.includes("confirmed-private@lid"));
  assert.deepEqual(f.confirmLogs, [
    "flowHasGroupSelection=false",
    "selectedGroups=0",
    "callingGroupAccess=true",
    "groupsReturned=1",
    "creatingRaid=false"
  ]);
  assert.deepEqual(f.aliasLogs, [
    "sessionIdentityUsed=true",
    "currentMessageIdentityUsed=false"
  ]);
  assert.deepEqual(f.destinationLogs, [
    "destinationMode=true",
    "selectedGroups=0",
    "publishTargets=0",
    "fallbackCurrentGroup=false"
  ]);
});

test("timeout padrão expira o progresso depois de quinze minutos", async () => {
  const f = await fixture();
  const ctx = context();
  await f.flow.start(ctx);
  f.advanceClock(15 * 60 * 1000 + 1);
  assert.equal(await f.flow.hasActiveFlow(ctx), false);
});

test("permissão é validada no início e novamente antes da gravação", async () => {
  const denied = await fixture({ allowed: false });
  assert.equal((await denied.flow.start(context())).status, "denied");
  assert.equal(denied.calls(), 0);

  const f = await fixture();
  const ctx = context();
  await reachReview(f.flow, ctx);
  f.setAllowed(false);
  assert.equal((await f.flow.handleAnswer(ctx, "sim")).status, "denied");
  assert.equal(f.calls(), 0);
  assert.equal(await f.flow.hasActiveFlow(ctx), true);
});

test("falha de persistência é segura e não encerra o fluxo", async () => {
  const f = await fixture({
    raidService: {
      createRaidFromMessage: async () => { throw new Error("database secret"); },
      formatCreatedRaid: () => assert.fail("não deve formatar")
    }
  });
  const ctx = context();
  await reachReview(f.flow, ctx);
  assert.equal((await f.flow.handleAnswer(ctx, "1")).status, "error");
  assert.equal(await f.flow.hasActiveFlow(ctx), true);
  assert.doesNotMatch(ctx.replies.at(-1), /database secret|@g\.us|@lid/);
});

test("a função oficial evita Raid ativa duplicada e preserva campos guiados", async () => {
  const f = await fixture();
  const msg = context().message;
  const first = await f.official.createRaidFromMessage(msg, {
    name: "Pikachu", coordinates: "-7,-38", startTime: "18:30", remainingMinutes: 45
  });
  const second = await f.official.createRaidFromMessage(msg, {
    name: "Pikachu", coordinates: "-7,-38", startTime: "18:30", remainingMinutes: 45
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.raid.id, second.raid.id);
  assert.equal(f.repository.listActiveRaids("group-a@g.us").length, 1);
  assert.equal(first.raid.coordinates, "-7,-38");
  assert.equal(first.raid.startTime, "18:30");
  assert.equal(first.raid.remainingMinutes, 45);
});

test("comando com argumento usa atalho oficial e sem argumento inicia fluxo", async () => {
  const commands = require("../src/commands/raid");
  const raidService = require("../src/services/raidService");
  const guided = require("../src/services/raidGuidedFlowService");
  const command = commands.find(item => item.name === "criar raid");
  const originalCreate = raidService.createRaidFromMessage;
  const originalFormat = raidService.formatCreatedRaid;
  const originalStart = guided.start;
  const calls = [];
  raidService.createRaidFromMessage = async (_msg, input) => {
    calls.push(["quick", input.name]);
    return { raid: { id: "R1024", name: input.name, participants: [] }, created: true };
  };
  raidService.formatCreatedRaid = () => "oficial";
  guided.start = async input => { calls.push(["guided", input.message.from]); return { status: "started" }; };
  try {
    const replies = [];
    const msg = { from: "group-a@g.us", author: "user@lid", reply: async text => replies.push(text) };
    await command.execute({}, msg, ["Pikachu"], { commandName: "criar raid" });
    await command.execute({}, msg, [], {
      commandName: "criar raid",
      platformContext: context({ message: msg })
    });
    assert.deepEqual(calls, [["quick", "pikachu"], ["guided", "group-a@g.us"]]);
    assert.deepEqual(replies, ["oficial"]);
  } finally {
    raidService.createRaidFromMessage = originalCreate;
    raidService.formatCreatedRaid = originalFormat;
    guided.start = originalStart;
  }
});
