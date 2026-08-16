"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const { createRepository } = require("../src/repositories/raidRepository");
const { createRaidService } = require("../src/services/raidService");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-raid-create-rules-"));
  const repository = createRepository(path.join(root, "raids.json"));
  const service = createRaidService(repository, {
    listRegistrations: async () => [],
    getRegistrationByIdentity: async () => null
  });
  const message = identity => ({
    from: "a@g.us",
    author: identity,
    getContact: async () => ({ id: { _serialized: identity } })
  });
  const input = overrides => ({
    name: "Mega Charizard X",
    groupId: "a@g.us",
    destinationGroupIds: ["a@g.us"],
    coordinates: "-7,-38",
    startTime: "18:30",
    remainingMinutes: 45,
    ...overrides
  });
  return { repository, service, message, input };
}

test("criador é preservado como autoria e entra somente por !vou", async () => {
  const f = fixture();
  const memberCreator = await f.service.createRaidFromMessage(f.message("member@lid"), f.input());
  assert.equal(memberCreator.raid.creatorId, "member@lid");
  assert.deepEqual(memberCreator.raid.participants, []);

  const externalCreator = await f.service.createRaidFromMessage(
    f.message("external@lid"),
    f.input({ coordinates: "-8,-39" })
  );
  assert.equal(externalCreator.raid.creatorId, "external@lid");
  assert.deepEqual(externalCreator.raid.participants, []);

  const multi = await f.service.createRaidFromMessage(
    f.message("multi@lid"),
    f.input({ destinationGroupIds: ["a@g.us", "b@g.us"], coordinates: "-9,-40" })
  );
  assert.deepEqual(multi.raid.targetGroupIds, ["a@g.us", "b@g.us"]);
  assert.deepEqual(multi.raid.participants, []);
});

test("mesmo Pokémon com coordenadas, horário ou destinos diferentes cria novo ID", async () => {
  const f = fixture();
  const first = await f.service.createRaidFromMessage(f.message("one@lid"), f.input());
  const coordinates = await f.service.createRaidFromMessage(
    f.message("two@lid"),
    f.input({ coordinates: "-8,-39" })
  );
  const time = await f.service.createRaidFromMessage(
    f.message("three@lid"),
    f.input({ startTime: "19:30" })
  );
  const destinations = await f.service.createRaidFromMessage(
    f.message("four@lid"),
    f.input({ destinationGroupIds: ["a@g.us", "b@g.us"] })
  );
  assert.equal(new Set([first.raid.id, coordinates.raid.id, time.raid.id, destinations.raid.id]).size, 4);
});

test("tentativa realmente duplicada é idempotente e não altera participantes da Raid antiga", async () => {
  const f = fixture();
  const first = await f.service.createRaidFromMessage(f.message("first@lid"), f.input());
  f.repository.updateRaid(first.raid.id, { participants: ["confirmed@lid"] });
  const duplicate = await f.service.createRaidFromMessage(f.message("second@lid"), f.input());
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.raid.id, first.raid.id);
  assert.deepEqual(duplicate.raid.participants, ["confirmed@lid"]);
  assert.equal(duplicate.raid.participants.includes("second@lid"), false);
  assert.equal(Object.keys(f.repository.loadDatabase().raids).length, 1);
});

test("participação continua centralizada em !vou, !desistir e !lista", () => {
  const commands = require("../src/commands/raidParticipation");
  assert.deepEqual(commands.map(command => command.name), ["vou", "desistir", "lista"]);
});

test("modelo não expõe identidade na formatação quando participantes está vazio", async () => {
  const f = fixture();
  const created = await f.service.createRaidFromMessage(f.message("private@lid"), f.input());
  const text = await f.service.formatCreatedRaid(created.raid);
  assert.match(text, /Nenhum participante confirmado/);
  assert.doesNotMatch(text, /private|@lid|@c\.us|@g\.us|wa\.me|\d{7,}/);
});
