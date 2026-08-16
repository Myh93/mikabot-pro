"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createQuizMarathonService, INTERVAL_MS, QUESTION_DURATION_MS } = require("../src/services/quizMarathonService");
const { createQuizMarathonCommands } = require("../src/commands/quizMarathon");
const formatter = require("../src/services/quizMarathonFormatter");
const identityService = require("../src/services/identityService");

function fakeQuizService() {
  let round = null;
  let sequence = 0;
  return {
    canStartRound: async () => ({ allowed: !round }),
    startCollectiveRound: async (context, configuration) => {
      sequence += 1;
      round = { roundId: `Q${sequence}`, points: 10, expiresAt: new Date(Date.now() + configuration.durationMs).toISOString() };
      return { round, question: { prompt: `Pergunta ${sequence}?`, options: [], difficulty: "normal", points: 10 } };
    },
    submitAnswer: async (context, answer) => {
      if (!round) return { status: "no_active_round" };
      if (answer !== "certa") return { status: "ignored" };
      const finished = round; round = null;
      return { status: "correct", round: finished, winnerId: context.userId, pointsAwarded: 10 };
    },
    expireRound: async () => { const expired = round; round = null; return { status: "expired", round: expired }; },
    finishRound: async () => { const finished = round; round = null; return { status: "finished", round: finished }; },
    hasRound: () => Boolean(round),
    getSequence: () => sequence
  };
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-marathon-"));
  let now = Date.parse("2026-07-16T15:00:00Z");
  const timers = [];
  const quizService = fakeQuizService();
  const service = createQuizMarathonService({
    filePath: path.join(root, "sessions.json"), quizService, clock: () => new Date(now),
    setTimeoutFn: (callback, delay) => { const timer = { callback, delay, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeoutFn: (timer) => { timer.cleared = true; }, logError: (message, error) => { throw error; }
  });
  const sent = [];
  const context = { platform: "whatsapp", groupId: "grupo@g.us", userId: "u1@lid", displayName: "João", isGroup: true, replyText: async (text) => sent.push(String(text)) };
  return { root, service, quizService, timers, sent, context, setNow: (value) => { now = value; }, getNow: () => now };
}

const cleanup = (root) => fsp.rm(root, { recursive: true, force: true });
const activeTimer = (fixture) => [...fixture.timers].reverse().find((timer) => !timer.cleared);

test("inicia maratonas de 5 e 10 perguntas usando quizService", async () => {
  for (const total of [5, 10]) {
    const f = await fixture();
    try {
      const result = await f.service.startMarathon(f.context, total, f.context.replyText);
      assert.equal(result.status, "started");
      assert.equal(result.session.totalQuestions, total);
      assert.equal(result.session.currentQuestion, 1);
      assert.equal(f.quizService.getSequence(), 1);
      assert.match(f.sent[0], new RegExp(`Perguntas: ${total}`));
      assert.match(f.sent[1], new RegExp(`PERGUNTA 1/${total}`));
      assert.equal(activeTimer(f).delay, QUESTION_DURATION_MS);
    } finally { await cleanup(f.root); }
  }
});

test("comando aceita personalizada e recusa segunda maratona", async () => {
  const f = await fixture();
  try {
    const commands = createQuizMarathonCommands({ marathonService: f.service });
    const command = commands.find((item) => item.name === "maratona");
    await command.execute({}, { from: "grupo@g.us" }, ["personalizada", "15"], { commandName: "maratona", platformContext: f.context });
    assert.equal((await f.service.getActiveMarathon(f.context)).totalQuestions, 15);
    await command.execute({}, { from: "grupo@g.us" }, [], { commandName: "maratona", platformContext: f.context });
    assert.equal(f.sent.at(-1), "❌ Já existe uma maratona em andamento.");
  } finally { await cleanup(f.root); }
});

test("resposta correta agenda automaticamente a próxima após três segundos", async () => {
  const f = await fixture();
  try {
    await f.service.startMarathon(f.context, 5, f.context.replyText);
    const result = await f.service.handleAnswer(f.context, "certa", f.context.replyText);
    assert.equal(result.status, "correct");
    assert.match(f.sent.at(-1), /João acertou![\s\S]*\+10 pontos[\s\S]*Próxima pergunta em 3 segundos/);
    assert.equal(activeTimer(f).delay, INTERVAL_MS);
    await activeTimer(f).callback();
    assert.equal((await f.service.getActiveMarathon(f.context)).currentQuestion, 2);
    assert.match(f.sent.at(-1), /PERGUNTA 2\/5/);
  } finally { await cleanup(f.root); }
});

test("placar, status, participantes e MVP seguem desempate definido", async () => {
  const f = await fixture();
  try {
    await f.service.startMarathon(f.context, 5, f.context.replyText);
    await f.service.handleAnswer(f.context, "errada", f.context.replyText);
    await f.service.handleAnswer(f.context, "certa", f.context.replyText);
    const status = await f.service.getStatus(f.context);
    assert.equal(status.participants, 1);
    assert.match(await f.service.getScoreboard(f.context), /João[\s\S]*10 pontos/);
    const session = { ranking: {
      b: { name: "Maria", points: 20, correctAnswers: 2, firstCorrectAt: "2026-01-01T00:00:02Z" },
      a: { name: "João", points: 20, correctAnswers: 2, firstCorrectAt: "2026-01-01T00:00:01Z" },
      c: { name: "Pedro", points: 20, correctAnswers: 1, firstCorrectAt: "2026-01-01T00:00:00Z" }
    } };
    assert.deepEqual(f.service.orderedRanking(session).map((entry) => entry.name), ["João", "Maria", "Pedro"]);
  } finally { await cleanup(f.root); }
});

test("última resposta encerra e apresenta placar final e MVP", async () => {
  const f = await fixture();
  try {
    await f.service.startMarathon(f.context, 1, f.context.replyText);
    await f.service.handleAnswer(f.context, "certa", f.context.replyText);
    const session = await f.service.getSession(f.context.platform, f.context.groupId);
    assert.equal(await f.service.getActiveMarathon(f.context), null);
    assert.match(f.sent.at(-1), /MARATONA ENCERRADA[\s\S]*🥇 João[\s\S]*MVP[\s\S]*1 respostas corretas/);
    assert.equal(session.status, "finished");
  } finally { await cleanup(f.root); }
});

test("parar é adminOnly, finaliza rodada e mostra resultado", async () => {
  const f = await fixture();
  try {
    await f.service.startMarathon(f.context, 5, f.context.replyText);
    const commands = createQuizMarathonCommands({ marathonService: f.service });
    const stop = commands.find((item) => item.name === "parar maratona");
    assert.equal(stop.adminOnly, true);
    const result = await stop.execute({}, { from: "grupo@g.us" }, [], { platformContext: f.context });
    assert.equal(result.status, "stopped");
    assert.equal(await f.service.getActiveMarathon(f.context), null);
    assert.match(f.sent.at(-1), /MARATONA ENCERRADA/);
  } finally { await cleanup(f.root); }
});

test("persistência e retomada após nova instância preservam a pergunta", async () => {
  const f = await fixture();
  try {
    await f.service.startMarathon(f.context, 10, f.context.replyText);
    const timers = [];
    const restarted = createQuizMarathonService({
      filePath: path.join(f.root, "sessions.json"), quizService: f.quizService, clock: () => new Date(f.getNow()),
      setTimeoutFn: (callback, delay) => { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; }, clearTimeoutFn: () => undefined
    });
    const client = { sendMessage: async (groupId, text) => f.sent.push(String(text)) };
    assert.equal(await restarted.resume(client), 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, QUESTION_DURATION_MS);
    assert.equal((await restarted.getStatus(f.context)).session.currentQuestion, 1);
  } finally { await cleanup(f.root); }
});

test("não registra listener e mantém comandos esperados", async () => {
  const source = await fsp.readFile(path.join(__dirname, "..", "src", "services", "quizMarathonService.js"), "utf8");
  const commandSource = await fsp.readFile(path.join(__dirname, "..", "src", "commands", "quizMarathon.js"), "utf8");
  assert.equal(/client\.on\s*\(/.test(source + commandSource), false);
  const commands = createQuizMarathonCommands({ marathonService: {} });
  assert.deepEqual(commands[0].aliases, ["status maratona", "placar"]);
  assert.equal(commands[1].name, "parar maratona");
});

test("resolvedor central prioriza nick, nome, WhatsApp e fallback seguro", async () => {
  const records = { "u1@lid": { nick: "Mestre", name: "João" }, "u2@lid": { name: "Maria" } };
  const registrationService = { getRegistrationByIdentity: async (id) => records[id] || null };
  assert.equal(await identityService.resolveDisplayName("u1@lid", { registrationService, displayName: "WhatsApp" }), "Mestre");
  assert.equal(await identityService.resolveDisplayName("u2@lid", { registrationService, displayName: "WhatsApp" }), "Maria");
  assert.equal(await identityService.resolveDisplayName("u3@lid", { registrationService, displayName: "Carlos" }), "Carlos");
  assert.equal(await identityService.resolveDisplayName("u4@lid", { registrationService, displayName: "u4@lid" }), "Treinador");
});

test("formatador calcula tempo exato e barra de progresso", () => {
  assert.equal(formatter.formatDuration((4 * 60 + 36) * 1000), "4min 36s");
  assert.equal(formatter.formatDuration((2 * 60 * 60 + 14 * 60 + 59) * 1000), "2h 14m");
  assert.equal(formatter.formatProgress(3, 5), "🟩🟩🟩⬜⬜");
  const question = formatter.formatQuestion({ prompt: "Qual Pokémon?", options: [], difficulty: "normal", points: 15 }, 3, 5, () => "Normal");
  assert.match(question, /PERGUNTA 3\/5[\s\S]*🟩🟩🟩⬜⬜/);
});

test("resposta e resultado final ocultam todos os identificadores internos", () => {
  const correct = formatter.formatCorrectAnswer("5511999999999@lid", 25, true);
  assert.equal(correct, "🎉 *Treinador acertou!*\n\n+25 pontos\n\nPróxima pergunta em 3 segundos...");
  const session = { totalQuestions: 5, participants: { "5511999999999@lid": { name: "5511999999999@lid" } } };
  const ranking = [{ userId: "5511999999999@lid", name: "5511999999999@lid", points: 75, correctAnswers: 5 }];
  const final = formatter.formatFinal(session, ranking, (4 * 60 + 36) * 1000);
  assert.match(final, /MARATONA ENCERRADA[\s\S]*📚 Perguntas\n5[\s\S]*👥 Participantes\n1[\s\S]*⏱ Tempo\n4min 36s[\s\S]*🥇 Treinador\n75 pts[\s\S]*MVP[\s\S]*5 respostas corretas[\s\S]*Obrigado a todos/);
  for (const hidden of ["@lid", "@g.us", "5511999999999", "userId", "participantId", "creatorId"]) assert.equal((correct + final).includes(hidden), false, hidden);
});
