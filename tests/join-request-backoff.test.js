"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createJoinRequestService } = require("../src/services/joinRequestService");

function fixture() {
  let now = new Date("2026-08-05T12:00:00.000Z");
  let incompatibleFails = true;
  const calls = { compatible: 0, incompatible: 0, writes: 0 };
  const logs = [];
  const groups = [
    { groupId: "compatible@g.us", active: true },
    { groupId: "incompatible@g.us", active: true }
  ];
  const repository = {
    listRequests: async () => [],
    updateRequest: async () => { calls.writes += 1; }
  };
  const client = {
    info: { wid: "bot@lid" },
    getChatById: async () => ({ isGroup: true, participants: [] }),
    getGroupMembershipRequests: async groupId => {
      if (groupId === groups[0].groupId) {
        calls.compatible += 1;
        return [];
      }
      calls.incompatible += 1;
      if (!incompatibleFails) return [];
      const error = new Error("t");
      error.name = "t";
      throw error;
    }
  };
  const service = createJoinRequestService({
    repository,
    groupDirectoryService: { listActiveGroups: async () => groups },
    clock: () => new Date(now),
    intervalMs: 60 * 60 * 1000,
    pollLog: value => logs.push(value),
    summaryLog: () => undefined
  });
  return {
    service, client, calls, logs,
    advance: milliseconds => { now = new Date(now.getTime() + milliseconds); },
    allowSuccess: () => { incompatibleFails = false; }
  };
}

test("backoff temporário isola somente o grupo incompatível e limpa após sucesso", async () => {
  const f = fixture();
  const runtime = f.service.start(f.client);
  await runtime.initialPoll;
  assert.deepEqual(f.calls, { compatible: 1, incompatible: 1, writes: 0 });

  await f.service.poll(f.client);
  assert.deepEqual(f.calls, { compatible: 2, incompatible: 2, writes: 0 });

  await f.service.poll(f.client);
  assert.deepEqual(f.calls, { compatible: 3, incompatible: 2, writes: 0 });
  assert.ok(f.logs.includes("groupSkipped=true"));
  assert.ok(f.logs.includes("skipReason=temporary_incompatibility"));

  f.advance(5 * 60 * 1000);
  await f.service.poll(f.client);
  assert.deepEqual(f.calls, { compatible: 4, incompatible: 3, writes: 0 });

  await f.service.poll(f.client);
  assert.deepEqual(f.calls, { compatible: 5, incompatible: 3, writes: 0 });

  f.advance(15 * 60 * 1000);
  f.allowSuccess();
  await f.service.poll(f.client);
  assert.deepEqual(f.calls, { compatible: 6, incompatible: 4, writes: 0 });

  await f.service.poll(f.client);
  assert.deepEqual(f.calls, { compatible: 7, incompatible: 5, writes: 0 });
  assert.doesNotMatch(f.logs.join("\n"), /compatible@g\.us|incompatible@g\.us|bot@lid/);
  f.service.stop(f.client);
});
