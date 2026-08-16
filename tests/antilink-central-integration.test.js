"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const { createModerationRepository } = require("../src/repositories/moderationRepository");
const { createModerationService } = require("../src/services/moderationService");
const { createAntiLinkService } = require("../src/services/antiLinkService");
const { createGroupChatResolverService } = require("../src/services/groupChatResolverService");
const identityService = require("../src/services/identityService");

async function fixture(enabled = true) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "antilink-central-"));
  const repository = createModerationRepository({ dataDir: path.join(root, "mod"), backupRoot: path.join(root, "back") });
  const moderation = createModerationService({ repository });
  await moderation.updateGroupConfig("area51@g.us", { settings: { antiLink: { enabled } } });
  const groupChatResolver = createGroupChatResolverService();
  const antiLink = createAntiLinkService({
    moderationService: moderation,
    groupChatResolverService: groupChatResolver
  });
  const member = { id: "member@lid", isAdmin: false, isSuperAdmin: false };
  const bot = { id: "bot@lid", isAdmin: true, isSuperAdmin: false };
  const state = { deleted: 0, replies: [], calls: 0 };
  function message(overrides = {}) {
    return {
      from: "area51@g.us",
      author: member.id,
      body: "https://example.com",
      fromMe: false,
      id: { _serialized: overrides.messageId || "CENTRAL-1" },
      getChat: async () => ({ isGroup: true, id: { _serialized: "area51@g.us" }, participants: [member, bot] }),
      delete: async () => { if (overrides.deleteFails) throw new Error("falha"); state.deleted++; },
      reply: async text => state.replies.push(text),
      ...overrides
    };
  }
  return { root, repository, moderation, antiLink, groupChatResolver, member, bot, state, message };
}

async function runThroughCentralListener(f, msg) {
  const loaderPath = require.resolve("../src/loader");
  const antiPath = require.resolve("../src/services/antiLinkService");
  const directoryPath = require.resolve("../src/services/groupDirectoryService");
  const marathonPath = require.resolve("../src/services/quizMarathonService");
  delete require.cache[loaderPath];
  const originals = new Map([antiPath, directoryPath, marathonPath].map(key => [key, require.cache[key]]));
  require.cache[antiPath] = { id: antiPath, filename: antiPath, loaded: true, exports: {
    handleIncomingMessage: async context => { f.state.calls++; return f.antiLink.handleIncomingMessage(context); }
  }};
  require.cache[directoryPath] = { id: directoryPath, filename: directoryPath, loaded: true, exports: { registerSeenGroup: async () => null } };
  require.cache[marathonPath] = { id: marathonPath, filename: marathonPath, loaded: true, exports: { resume: async () => null } };
  const loader = require(loaderPath);
  let handler;
  const client = { info: { wid: "bot@lid" }, on: (event, callback) => { if (event === "message") handler = callback; }, sendMessage: async () => null };
  loader.attach(client);
  await handler(msg);
  delete require.cache[loaderPath];
  for (const [key, value] of originals) { if (value) require.cache[key] = value; else delete require.cache[key]; }
}

test("listener central processa link comum no grupo Área 51 sem prefixo", async () => {
  const f = await fixture(true);
  await runThroughCentralListener(f, f.message());
  assert.equal(f.state.calls, 1);
  assert.equal(f.state.deleted, 1);
  assert.equal(await f.moderation.getWarningCount("area51@g.us", f.member.id), 1);
  assert.match(f.state.replies[0], /LINK NÃO AUTORIZADO/);
  assert.equal((await f.repository.listHistory({ action: "anti_link_detected" })).total, 1);
});

test("listener central aceita legenda de imagem sem body", async () => {
  const f = await fixture(true);
  await runThroughCentralListener(f, f.message({ body: undefined, caption: "https://example.com", id: { _serialized: "CAPTION-1" } }));
  assert.equal(f.state.deleted, 1);
  assert.equal(await f.moderation.getWarningCount("area51@g.us", f.member.id), 1);
});

test("sem link e Antilink desligado não executam ação", async () => {
  let f = await fixture(true);
  await runThroughCentralListener(f, f.message({ body: "Boa noite", id: { _serialized: "TEXT-1" } }));
  assert.equal(f.state.deleted, 0);
  assert.equal(await f.moderation.getWarningCount("area51@g.us", f.member.id), 0);
  f = await fixture(false);
  await runThroughCentralListener(f, f.message({ id: { _serialized: "OFF-1" } }));
  assert.equal(f.state.deleted, 0);
});

test("fromMe e publicação do MikaBot não são processados", async () => {
  const f = await fixture(true);
  await runThroughCentralListener(f, f.message({ fromMe: true, author: f.bot.id, id: { _serialized: "BOT-1" } }));
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.deleted, 0);
});

test("falha ao excluir mantém advertência e orientação correta", async () => {
  const f = await fixture(true);
  await runThroughCentralListener(f, f.message({ deleteFails: true, id: { _serialized: "FAIL-1" } }));
  assert.equal(f.state.deleted, 0);
  assert.equal(await f.moderation.getWarningCount("area51@g.us", f.member.id), 1);
  assert.match(f.state.replies[0], /Não consegui remover/);
});

test("mesma mensagem no fluxo central é idempotente", async () => {
  const f = await fixture(true), msg = f.message({ id: { _serialized: "SAME-1" } });
  await runThroughCentralListener(f, msg);
  await runThroughCentralListener(f, msg);
  assert.equal(await f.moderation.getWarningCount("area51@g.us", f.member.id), 1);
});

test("integração usa o único listener existente", async () => {
  const loader = await fsp.readFile(path.join(__dirname, "..", "src", "loader.js"), "utf8");
  assert.equal((loader.match(/client\.on\(\s*["']message/g) || []).length, 1);
  assert.ok(loader.indexOf("antiLinkService.handleIncomingMessage") < loader.indexOf("body.startsWith(commandPrefix)"));
});

test("logs temporários mostram todas as etapas sem dados sensíveis", async () => {
  const f = await fixture(true), output = [], original = console.log;
  console.log = message => output.push(String(message));
  try {
    await f.antiLink.handleIncomingMessage({
      isGroup: true,
      client: { info: { wid: "bot@lid" } },
      message: f.message({ id: { _serialized: "LOG-1" } })
    });
  } finally {
    console.log = original;
  }
  const joined = output.join("\n");
  for (const expected of [
    "[ANTI] serviço iniciado",
    "[ANTI] contexto grupo=true fromMe=false",
    "configuração enabled=true approval=false",
    "texto body=true caption=false",
    "detector link encontrado=true",
    "participante authorCandidates=",
    "decisão allowed=false reason=member_common",
    "ação apagar=true",
    "advertência criada=true",
    "processamento concluído"
  ]) assert.match(joined, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(joined, /https?:\/\/|@g\.us|@lid|\d{9,}/);
});

test("WhatsApp real resolve membro comum por @lid reutilizando o chat já consultado", async () => {
  const f = await fixture(true);
  let chatCalls = 0;
  const member = { id: { _serialized: "member@lid" }, isAdmin: false, isSuperAdmin: false };
  const bot = { id: { _serialized: "bot@lid" }, isAdmin: true, isSuperAdmin: false };
  const msg = f.message({
    body: "https://youtube.com/watch?v=teste",
    author: "member@lid",
    id: { _serialized: "REAL-LID-1" },
    getChat: async () => {
      chatCalls++;
      if (chatCalls > 1) throw new Error("consulta temporariamente indisponível");
      return { isGroup: true, id: { _serialized: "area51@g.us" }, participants: [member, bot] };
    }
  });

  await runThroughCentralListener(f, msg);

  assert.equal(chatCalls, 1);
  assert.equal(f.state.deleted, 1);
  assert.equal(await f.moderation.getWarningCount("area51@g.us", "member@lid"), 1);
});

test("autor admin por @lid recebe bypass e dono permanece protegido", async () => {
  const f = await fixture(true);
  const output = [];
  const original = console.log;
  const bot = { id: { _serialized: "bot@lid" }, isAdmin: true, isSuperAdmin: false };
  const admin = { id: { _serialized: "admin@lid" }, isAdmin: true, isSuperAdmin: false };
  const owner = { id: { _serialized: "owner@lid" }, isAdmin: true, isSuperAdmin: true };
  console.log = message => output.push(String(message));
  try {
    for (const participant of [admin, owner]) {
      await f.antiLink.handleIncomingMessage({
        isGroup: true,
        chat: { isGroup: true, participants: [participant, bot] },
        client: { info: { wid: "bot@lid" } },
        message: f.message({
          author: participant.id._serialized,
          body: "https://youtube.com/watch?v=teste",
          id: { _serialized: `ROLE-${participant.isSuperAdmin ? "OWNER" : "ADMIN"}` }
        })
      });
    }
  } finally {
    console.log = original;
  }

  assert.equal(f.state.deleted, 0);
  assert.match(output.join("\n"), /decisão allowed=true reason=admin_bypass/);
  assert.match(output.join("\n"), /decisão allowed=true reason=owner_protected/);
  assert.doesNotMatch(output.join("\n"), /@lid|@g\.us|https?:\/\//);
});

test("falha real de consulta de participantes continua segura e informa motivo controlado", async () => {
  const f = await fixture(true);
  const output = [];
  const original = console.log;
  console.log = message => output.push(String(message));
  let result;
  try {
    result = await f.antiLink.handleIncomingMessage({
      isGroup: true,
      client: { info: { wid: "bot@lid" } },
      message: f.message({
        id: { _serialized: "CHAT-FAIL-1" },
        getChat: async () => { throw new Error("consulta indisponível"); }
      })
    });
  } finally {
    console.log = original;
  }

  assert.equal(result.status, "safe_failure");
  assert.equal(f.state.deleted, 0);
  assert.equal(await f.moderation.getWarningCount("area51@g.us", f.member.id), 0);
  assert.match(output.join("\n"), /decisão allowed=true reason=participant_lookup_failed/);
});

test("identityService preserva e compara identidades @lid canônicas", async () => {
  const identity = await identityService.resolveIdentity({
    from: "area51@g.us",
    author: "member@lid",
    getContact: async () => ({ id: { _serialized: "5511999999999@c.us" } })
  });

  assert.equal(identity.id, "member@lid");
  assert.equal(identity.isLid, true);
  assert.equal(
    identityService.identitiesMatch(identity, { id: { _serialized: "member@lid" } }),
    true
  );
});

test("autor @lid encontra participante @c.us por alias confirmado pelo contato", async () => {
  const f = await fixture(true);
  const participant = {
    id: { _serialized: "5511999999999@c.us", user: "5511999999999", server: "c.us" },
    isAdmin: false,
    isSuperAdmin: false
  };
  const bot = { id: { _serialized: "bot@lid" }, isAdmin: true, isSuperAdmin: false };
  const result = await f.antiLink.handleIncomingMessage({
    isGroup: true,
    chat: { isGroup: true, participants: [participant, bot] },
    client: { info: { wid: "bot@lid" } },
    message: f.message({
      author: "member@lid",
      body: "https://youtube.com/watch?v=alias",
      id: { _serialized: "LID-ALIAS-1" },
      getContact: async () => ({
        lid: "member@lid",
        number: "5511999999999",
        id: { _serialized: "5511999999999@c.us", user: "5511999999999", server: "c.us" }
      })
    })
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.internalReason, "participant_resolved_common");
  assert.equal(f.state.deleted, 1);
  assert.equal(await f.moderation.getWarningCount("area51@g.us", "member@lid"), 1);
});

test("context.chat válido não consulta getChat e lista vazia atualiza uma única vez", async () => {
  const f = await fixture(true);
  const member = { id: { _serialized: "member@lid" }, isAdmin: false, isSuperAdmin: false };
  const bot = { id: { _serialized: "bot@lid" }, isAdmin: true, isSuperAdmin: false };
  let validCalls = 0;
  const validResult = await f.antiLink.handleIncomingMessage({
    isGroup: true,
    chat: { isGroup: true, participants: [member, bot] },
    client: { info: { wid: "bot@lid" } },
    message: f.message({
      id: { _serialized: "CONTEXT-VALID-1" },
      getChat: async () => { validCalls++; throw new Error("não deveria consultar"); }
    })
  });
  assert.equal(validResult.status, "blocked");
  assert.equal(validCalls, 0);

  f.groupChatResolver.clearCache();
  let refreshCalls = 0;
  const refreshResult = await f.antiLink.handleIncomingMessage({
    isGroup: true,
    chat: { isGroup: true, participants: [] },
    client: { info: { wid: "bot@lid" } },
    message: f.message({
      id: { _serialized: "CONTEXT-EMPTY-1" },
      getChat: async () => {
        refreshCalls++;
        return { isGroup: true, participants: [member, bot] };
      }
    })
  });
  assert.equal(refreshResult.status, "blocked");
  assert.equal(refreshCalls, 1);
});

test("autor realmente ausente não é punido e diagnóstico técnico permanece sanitizado", async () => {
  const f = await fixture(true);
  const output = [];
  const original = console.log;
  console.log = message => output.push(String(message));
  let result;
  try {
    result = await f.antiLink.handleIncomingMessage({
      isGroup: true,
      chat: {
        isGroup: true,
        participants: [
          { id: { _serialized: "other@lid" }, isAdmin: false, isSuperAdmin: false },
          { id: { _serialized: "bot@lid" }, isAdmin: true, isSuperAdmin: false }
        ]
      },
      client: { info: { wid: "bot@lid" } },
      message: f.message({
        author: "missing@lid",
        body: "https://youtube.com/watch?v=ausente",
        id: { _serialized: "MISSING-REAL-1" }
      })
    });
  } finally {
    console.log = original;
  }

  const joined = output.join("\n");
  assert.equal(result.status, "safe_failure");
  assert.equal(result.internalReason, "author_not_matched");
  assert.equal(f.state.deleted, 0);
  assert.match(joined, /participante authorCandidates=\d+ participantCandidates=\d+ matched=false source=context_chat/);
  assert.doesNotMatch(joined, /https?:\/\/|@lid|@g\.us|@c\.us|\d{9,}/);
});

test("cenário real usa _data.author quando message.author está ausente", async () => {
  const f = await fixture(true);
  const member = {
    id: { _serialized: "member@lid", user: "member", server: "lid" },
    isAdmin: false,
    isSuperAdmin: false
  };
  const bot = { id: { _serialized: "bot@lid" }, isAdmin: true, isSuperAdmin: false };
  const output = [];
  const original = console.log;
  console.log = message => output.push(String(message));
  let result;
  try {
    result = await f.antiLink.handleIncomingMessage({
      isGroup: true,
      chat: { isGroup: true, participants: [member, bot] },
      client: { info: { wid: "bot@lid" } },
      message: f.message({
        author: undefined,
        _data: { author: { _serialized: "member@lid", user: "member", server: "lid" } },
        body: "https://youtube.com/watch?v=real",
        id: { _serialized: "RAW-AUTHOR-1" }
      })
    });
  } finally {
    console.log = original;
  }

  const joined = output.join("\n");
  assert.equal(result.status, "blocked");
  assert.equal(result.internalReason, "participant_resolved_common");
  assert.equal(f.state.deleted, 1);
  assert.equal(await f.moderation.getWarningCount("area51@g.us", "member@lid"), 1);
  assert.match(joined, /estrutura autor authorType=null/);
  assert.match(joined, /hasMessageAuthor=false hasDataAuthor=true/);
  assert.match(joined, /estrutura participante sampleHasId=true sampleIdType=object/);
  assert.match(joined, /participantes array=true count=2 identitiesCollected=2/);
  assert.doesNotMatch(joined, /https?:\/\/|@lid|@g\.us|@c\.us|\d{9,}/);
});

test("coletores aceitam formatos reais de autor, contato e participante", () => {
  const cases = [
    [{ author: "member@lid" }, null],
    [{ author: { _serialized: "member@lid" } }, null],
    [{ _data: { participant: { user: "member", server: "lid" } } }, null],
    [{ id: { participant: { id: { _serialized: "member@lid" } } } }, null],
    [{}, { id: { _serialized: "member@lid" }, lid: "member@lid" }]
  ];
  for (const [message, contact] of cases) {
    assert.deepEqual(identityService.collectMessageAuthorIdentities(message, contact), ["member@lid"]);
  }

  assert.deepEqual(identityService.collectParticipantIdentities({ id: "member@lid" }), ["member@lid"]);
  assert.deepEqual(
    identityService.collectParticipantIdentities({
      id: { user: "member", server: "lid" },
      lid: { _serialized: "member@lid" }
    }),
    ["member@lid"]
  );
});

test("chat incompleto usa client.getChatById para obter GroupChat real", async () => {
  const f = await fixture(true);
  const member = { id: "member@lid", isAdmin: false, isSuperAdmin: false };
  const bot = { id: "bot@lid", isAdmin: true, isSuperAdmin: false };
  let messageChatCalls = 0;
  let clientChatCalls = 0;
  const result = await f.antiLink.handleIncomingMessage({
    isGroup: true,
    chat: { participants: [] },
    client: {
      info: { wid: "bot@lid" },
      getChatById: async () => {
        clientChatCalls++;
        return { isGroup: true, participants: [member, bot] };
      }
    },
    message: f.message({
      id: { _serialized: "WRAPPED-CHAT-1" },
      getChat: async () => {
        messageChatCalls++;
        return { isGroup: true };
      }
    })
  });
  assert.equal(result.status, "blocked");
  assert.equal(messageChatCalls, 1);
  assert.equal(clientChatCalls, 1);

  const failedFixture = await fixture(true);
  const failure = await failedFixture.antiLink.handleIncomingMessage({
    isGroup: true,
    chat: { participants: [] },
    client: {
      info: { wid: "bot@lid" },
      getChatById: async () => { throw new Error("falha real"); }
    },
    message: failedFixture.message({
      id: { _serialized: "WRAPPED-CHAT-FAIL-1" },
      getChat: async () => { throw new Error("falha real"); }
    })
  });
  assert.equal(failure.status, "safe_failure");
  assert.equal(failure.internalReason, "unknown_error");
});

test("resolvedor reutiliza cache válido e expira sem aceitar lista vazia", async () => {
  let now = 1000;
  const resolver = createGroupChatResolverService({ clock: () => now, ttlMs: 50 });
  const realChat = { isGroup: true, id: {}, participants: [{ id: "member@lid" }] };
  let messageCalls = 0;
  const message = {
    from: "area51@g.us",
    getChat: async () => { messageCalls++; return realChat; }
  };
  const client = { getChatById: async () => { throw new Error("não necessário"); } };

  assert.equal((await resolver.resolveGroupChatWithParticipants({ message, client })).source, "message_getChat");
  assert.equal((await resolver.resolveGroupChatWithParticipants({ message, client })).cached, true);
  assert.equal(messageCalls, 1);

  now += 51;
  await resolver.resolveGroupChatWithParticipants({ message, client });
  assert.equal(messageCalls, 2);

  realChat.participants = [];
  now += 51;
  const empty = await resolver.resolveGroupChatWithParticipants({ message, client: {} });
  assert.equal(empty.errorCode, "participants_empty");
  assert.equal(resolver._cache.size, 0);
});

test("resolvedor preserva binding da Message real e usa seu Client original", async () => {
  const resolver = createGroupChatResolverService();
  const groupChat = { isGroup: true, id: {}, participants: [{ id: "member@lid" }] };
  const realClient = {
    calls: 0,
    async getChatById(chatId) {
      assert.equal(this, realClient);
      assert.equal(typeof chatId, "string");
      this.calls++;
      return groupChat;
    }
  };
  class RealMessage {
    constructor(client) {
      Object.defineProperty(this, "client", { value: client });
      this.from = "area51@g.us";
    }
    getChat() {
      assert.equal(this instanceof RealMessage, true);
      return this.client.getChatById(this.from);
    }
  }
  const message = new RealMessage(realClient);
  const result = await resolver.resolveGroupChatWithParticipants({ message, client: {} });
  assert.equal(result.source, "message_getChat");
  assert.equal(realClient.calls, 1);
});

test("chatId usa from, id.remote e _data.id.remote sem reconstrução manual", async () => {
  for (const [message, expectedSource] of [
    [{ from: "area51@g.us" }, "from"],
    [{ id: { remote: { _serialized: "area51@g.us" } } }, "id_remote"],
    [{ _data: { id: { remote: "area51@g.us" } } }, "data_id_remote"]
  ]) {
    const output = [];
    const resolver = createGroupChatResolverService();
    const result = await resolver.resolveGroupChatWithParticipants({
      message,
      client: { getChatById: async () => ({ isGroup: true, participants: [{ id: "member@lid" }] }) },
      diagnostic: line => output.push(line)
    });
    assert.equal(result.source, "client_getChatById");
    assert.match(output.join("\n"), new RegExp(`chatIdSource=${expectedSource}`));
  }
});

test("instrumentação temporária registra mensagem e primeira linha da stack da cadeia getChat", async () => {
  const output = [];
  const resolver = createGroupChatResolverService();
  const message = {
    from: "area51@g.us",
    client: {},
    getChat: async () => { throw new Error("Evaluation failed: segredo area51@g.us"); }
  };
  const result = await resolver.resolveGroupChatWithParticipants({
    message,
    client: {
      getChatById: async () => {
        const error = new TypeError("Illegal invocation para area51@g.us");
        error.code = "ERR_PRIVATE";
        throw error;
      }
    },
    diagnostic: line => output.push(line)
  });
  const joined = output.join("\n");
  assert.equal(result.errorCode, "illegal_invocation");
  assert.match(joined, /messageErrorName=Error/);
  assert.match(joined, /messageErrorCode=evaluation_failed/);
  assert.match(joined, /clientErrorName=TypeError/);
  assert.match(joined, /clientErrorCode=illegal_invocation/);
  assert.match(joined, /message err\.message=Evaluation failed: segredo area51@g/);
  assert.match(joined, /message stack\.firstLine=Error: Evaluation failed/);
  assert.match(joined, /client err\.message=Illegal invocation para area51@g/);
  assert.match(joined, /client stack\.firstLine=TypeError: Illegal invocation/);
  assert.match(joined, /cadeia=message\.getChat phase=during_window_WWebJS_getChat/);
  assert.match(joined, /cadeia=client\.getChatById phase=before_window_WWebJS_getChat/);
});

test("client e métodos ausentes e chatId inválido falham com segurança", async () => {
  let resolver = createGroupChatResolverService();
  let output = [];
  let result = await resolver.resolveGroupChatWithParticipants({
    message: { from: "area51@g.us" },
    diagnostic: line => output.push(line)
  });
  assert.equal(result.errorCode, "client_missing");
  assert.match(output.join("\n"), /messageErrorCode=method_missing/);
  assert.match(output.join("\n"), /clientErrorCode=client_missing/);

  resolver = createGroupChatResolverService();
  output = [];
  result = await resolver.resolveGroupChatWithParticipants({
    message: {},
    client: { getChatById: async () => { throw new Error("não deve chamar"); } },
    diagnostic: line => output.push(line)
  });
  assert.equal(result.errorCode, "invalid_chat_id");
  assert.match(output.join("\n"), /chatIdType=null/);
});

test("getChats recupera GroupChat carregado quando as duas consultas diretas falham com r", async () => {
  const f = await fixture(true);
  const member = { id: "member@lid", isAdmin: false, isSuperAdmin: false };
  const bot = { id: "bot@lid", isAdmin: true, isSuperAdmin: false };
  let byIdCalls = 0;
  let getChatsCalls = 0;
  const result = await f.antiLink.handleIncomingMessage({
    isGroup: true,
    chat: { isGroup: true },
    client: {
      info: { wid: "bot@lid" },
      getChatById: async () => {
        byIdCalls++;
        const error = new Error("r");
        error.name = "r";
        throw error;
      },
      getChats: async () => {
        getChatsCalls++;
        return [
          { id: { _serialized: "outro@g.us" }, isGroup: true, participants: [] },
          { id: { _serialized: "area51@g.us" }, isGroup: true, participants: [member, bot] }
        ];
      }
    },
    message: f.message({
      body: "https://youtube.com/watch?v=fallback",
      id: { _serialized: "GETCHATS-FALLBACK-1" },
      getChat: async () => {
        const error = new Error("r");
        error.name = "r";
        throw error;
      }
    })
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.internalReason, "participant_resolved_common");
  assert.equal(byIdCalls, 1);
  assert.equal(getChatsCalls, 1);
  assert.equal(f.state.deleted, 1);
  assert.equal(await f.moderation.getWarningCount("area51@g.us", "member@lid"), 1);
});

test("falha de getChats após r mantém falha segura sem punição", async () => {
  const f = await fixture(true);
  let getChatsCalls = 0;
  const failing = async () => {
    const error = new Error("r");
    error.name = "r";
    throw error;
  };
  const result = await f.antiLink.handleIncomingMessage({
    isGroup: true,
    chat: { isGroup: true },
    client: {
      info: { wid: "bot@lid" },
      getChatById: failing,
      getChats: async () => { getChatsCalls++; return failing(); }
    },
    message: f.message({
      id: { _serialized: "GETCHATS-FAIL-1" },
      getChat: failing
    })
  });

  assert.equal(result.status, "safe_failure");
  assert.equal(result.internalReason, "unknown_error");
  assert.equal(getChatsCalls, 1);
  assert.equal(f.state.deleted, 0);
  assert.equal(await f.moderation.getWarningCount("area51@g.us", "member@lid"), 0);
});
