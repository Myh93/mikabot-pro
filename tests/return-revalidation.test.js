"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { createMemberExperienceRepository } = require("../src/repositories/memberExperienceRepository");
const commandsModule = require("../src/commands/returnRevalidation");

test("prazo administrativo usa sete dias por padrão e persiste por grupo", async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "mikabot-return-window-")); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const repository = createMemberExperienceRepository({ filePath: path.join(root, "state.json") });
  const [command] = commandsModule.createReturnRevalidationCommands({ repository }); const replies = [], msg = { from: "g@g.us", reply: async text => replies.push(text) };
  await command.execute(null, msg, []); assert.match(replies.at(-1), /7 dia/);
  await command.execute(null, msg, ["10"]); assert.equal((await repository.getGroupConfig("g@g.us")).returnRevalidationDays, 10);
  await command.execute(null, msg, ["0"]); assert.match(replies.at(-1), /entre 1 e 365/); assert.equal((await repository.getGroupConfig("g@g.us")).returnRevalidationDays, 10);
  assert.equal(command.adminOnly, true); assert.equal(command.groupOnly, true);
});

test("classificação dos sete dias ignora remoção administrativa, ban e histórico ausente", async () => {
  const service = require("../src/services/memberExperienceService");
  assert.equal(service.classifyJoin({ groups: { g: { joinCount: 1, lastExitReason: "admin_removed" } } }, "g", false), "return_after_removal");
  assert.equal(service.classifyJoin({ groups: { g: { joinCount: 1, lastExitReason: "ban" } } }, "g", false), "return_after_ban");
  assert.equal(service.classifyJoin(null, "g", false), "first_entry");
  assert.equal(service.classifyJoin(null, "g", true), "ban_active");
});
