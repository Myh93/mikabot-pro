"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createDisciplineCommands } = require("../src/commands/discipline");

function fixture() {
  const calls = [], replies = [];
  const disciplineService = {
    recordBan: async input => { calls.push(["ban", input]); return { member: { activeBanCount: 1 } }; },
    revoke: async input => { calls.push(["revoke", input]); return {}; },
    getMemberStatus: async () => ({ activeBanCount: 0, communityBan: false, platformBlocks: {}, bans: [] })
  };
  const commands = createDisciplineCommands({
    disciplineService,
    identityService: {
      resolveDisplayName: async () => "Treinador",
      normalizeUserId: value => value
    },
    registrationRepository: { findByFriendCode: async () => null }
  });
  const msg = {
    from: "group@g.us", author: "admin@lid", mentionedIds: ["member@lid"],
    reply: async text => { replies.push(text); return text; }
  };
  const context = { role: { identity: { id: "admin@lid" } } };
  return { calls, replies, commands, msg, context };
}

test("comandos disciplinares e aliases administrativos são registrados", () => {
  const f = fixture();
  assert.deepEqual(f.commands.map(item => item.name), ["banir", "desbanir", "historico ban", "status membro"]);
  assert.equal(f.commands.every(item => item.adminOnly), true);
});

test("banimento destrutivo exige confirmação e não expõe identidade", async () => {
  const f = fixture(), command = f.commands.find(item => item.name === "banir");
  await command.execute(null, f.msg, ["group", "motivo", "seguro"], f.context);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(f.replies[0], /member@lid|admin@lid|group@g\.us/);
  await command.execute(null, f.msg, ["confirmar"], f.context);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "ban");
});
