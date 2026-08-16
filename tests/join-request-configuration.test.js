"use strict";

const assert = require("assert");
const test = require("node:test");
const {
  createJoinRequestService,
  POLL_INTERVAL_MS
} = require("../src/services/joinRequestService");

function createFixture(options = {}) {
  let resolved = 0;
  let polls = 0;
  const client = {
    getGroupMembershipRequests: async () => []
  };
  const service = createJoinRequestService({
    intervalMs: options.intervalMs,
    configurationService: options.configurationService || {
      getResolved: () => {
        resolved += 1;
        if (options.configurationError) throw new Error("configuration unavailable");
        return options.configuredValue;
      }
    },
    groupDirectoryService: {
      listActiveGroups: async () => {
        polls += 1;
        return [];
      }
    },
    repository: {
      listRequests: async () => []
    },
    log: () => undefined,
    debugLog: () => undefined,
    pollLog: () => undefined,
    processLog: () => undefined,
    approvalLog: () => undefined,
    summaryLog: () => undefined,
    lifecycleLog: () => undefined
  });
  return {
    client,
    service,
    getResolvedCalls: () => resolved,
    getPolls: () => polls
  };
}

async function startAndStop(fixture) {
  const runtime = fixture.service.start(fixture.client);
  await runtime.initialPoll;
  fixture.service.stop(fixture.client);
  return runtime;
}

test("usa 30000 como fallback quando não existe valor configurado", async () => {
  const f = createFixture();
  const runtime = await startAndStop(f);
  assert.equal(runtime.pollIntervalMilliseconds, POLL_INTERVAL_MS);
  assert.equal(f.getResolvedCalls(), 1);
});

test("options.intervalMs inteiro positivo tem prioridade e evita consulta", async () => {
  const f = createFixture({ intervalMs: 1234, configuredValue: 5678 });
  const runtime = await startAndStop(f);
  assert.equal(runtime.pollIntervalMilliseconds, 1234);
  assert.equal(f.getResolvedCalls(), 0);
});

test("option inválida permite usar override válido do ConfigurationService", async () => {
  const f = createFixture({ intervalMs: "1234", configuredValue: 5678 });
  const runtime = await startAndStop(f);
  assert.equal(runtime.pollIntervalMilliseconds, 5678);
});

for (const [label, value] of [
  ["undefined", undefined],
  ["null", null],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["decimal", 1.5],
  ["string", "30000"],
  ["boolean", true],
  ["zero", 0],
  ["negativo", -1]
]) {
  test(`rejeita valor configurado ${label}`, async () => {
    const f = createFixture({ configuredValue: value });
    const runtime = await startAndStop(f);
    assert.equal(runtime.pollIntervalMilliseconds, POLL_INTERVAL_MS);
  });
}

test("override runtime é consumido por getResolved", async () => {
  const f = createFixture({ configuredValue: 41000 });
  const runtime = await startAndStop(f);
  assert.equal(runtime.pollIntervalMilliseconds, 41000);
});

test("override persistente é consumido pela mesma fachada getResolved", async () => {
  const f = createFixture({ configuredValue: 42000 });
  const runtime = await startAndStop(f);
  assert.equal(runtime.pollIntervalMilliseconds, 42000);
});

test("ConfigurationService ausente mantém fallback seguro", async () => {
  const f = createFixture({
    configurationService: {},
    configuredValue: 47000
  });
  const runtime = await startAndStop(f);
  assert.equal(runtime.pollIntervalMilliseconds, POLL_INTERVAL_MS);
});

test("exceção do ConfigurationService mantém fallback seguro", async () => {
  const f = createFixture({ configurationError: true });
  const runtime = await startAndStop(f);
  assert.equal(runtime.pollIntervalMilliseconds, POLL_INTERVAL_MS);
});

test("start repetido preserva timer, intervalo e resolução únicos", async () => {
  const f = createFixture({ configuredValue: 43000 });
  const first = f.service.start(f.client);
  await first.initialPoll;
  const firstTimer = first.interval;
  const second = f.service.start(f.client);
  await second.initialPoll;
  assert.equal(second, first);
  assert.equal(second.interval, firstTimer);
  assert.equal(second.pollIntervalMilliseconds, 43000);
  assert.equal(f.getResolvedCalls(), 1);
  assert.equal(f.getPolls(), 2);
  f.service.stop(f.client);
});

test("stop e reconnect criam novo timer e resolvem novamente", async () => {
  let value = 44000;
  let calls = 0;
  const f = createFixture({
    configurationService: {
      getResolved: () => {
        calls += 1;
        return value;
      }
    }
  });
  const first = f.service.start(f.client);
  await first.initialPoll;
  const firstTimer = first.interval;
  assert.equal(f.service.stop(f.client), true);
  value = 45000;
  const second = f.service.start(f.client);
  await second.initialPoll;
  assert.notEqual(second.interval, firstTimer);
  assert.equal(second.pollIntervalMilliseconds, 45000);
  assert.equal(calls, 2);
  f.service.stop(f.client);
});

