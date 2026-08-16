"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const identityService = require("../src/services/identityService");
const { createRepository } = require("../src/repositories/raidRepository");
const { createRaidService } = require("../src/services/raidService");
const raidParticipation = require("../src/commands/raidParticipation");

function fixture(registrations = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mikabot-raid-identity-"));
  const repository = createRepository(path.join(root, "raids.json"));
  const registrationService = {
    listRegistrations: async () => registrations,
    getRegistrationByIdentity: async identity => {
      const normalized = identityService.normalizeUserId(identity);
      return registrations.find(item =>
        [item.primaryIdentity, ...(item.identityAliases || [])]
          .map(identityService.normalizeUserId)
          .includes(normalized)
      ) || null;
    }
  };
  const logs = [];
  const service = createRaidService(repository, registrationService, identityService, {
    identityLog: value => logs.push(value),
    joinLog: () => undefined
  });
  const raid = repository.createRaid({
    name: "muk",
    groupId: "raid@g.us",
    primaryGroupId: "raid@g.us",
    targetGroupIds: ["raid@g.us"],
    participants: [],
    status: "active"
  });
  repository.publishRaid(raid.id, {
    groupId: "raid@g.us",
    messageId: "official-message",
    publishedAt: new Date().toISOString()
  });
  const commands = raidParticipation.createRaidParticipationCommands(repository, service);
  const command = name => commands.find(item => item.name === name);
  const message = ({
    author = "mychelle@lid",
    contact = { id: { _serialized: "mychelle@lid" }, pushname: "Mychelle Segura" }
  } = {}) => {
    const replies = [];
    return {
      from: "raid@g.us",
      author,
      getContact: async () => contact,
      reply: async text => { replies.push(String(text)); return text; },
      replies
    };
  };
  return { repository, service, logs, command, message, raidId: raid.id };
}

const mychelle = {
  registrationId: "REG000001",
  primaryIdentity: "mychelle-primary@lid",
  identityAliases: ["mychelle-primary@lid", "mychelle@lid"],
  mainAccount: { nick: "MychelleGO" },
  name: "Mychelle Diniz"
};
const supremo = {
  registrationId: "REG000002",
  primaryIdentity: "supremo@lid",
  identityAliases: ["supremo@lid"],
  mainAccount: { nick: "supremomadu" },
  name: "Outro treinador"
};

test("mensagem de grupo usa author, nunca transforma from em participante", async () => {
  const f = fixture([mychelle, supremo]);
  const msg = f.message();
  await f.command("vou").execute(null, msg, []);
  const raid = f.repository.getRaidById(f.raidId);
  assert.deepEqual(raid.participants, ["mychelle-primary@lid"]);
  assert.match(msg.replies.at(-1), /Treinador: MychelleGO/);
  assert.doesNotMatch(msg.replies.join("\n"), /supremomadu|raid@g\.us|@lid|@c\.us/);
  assert.ok(f.logs.includes("aliasRegistrationMatches=1"));
  assert.ok(f.logs.includes("participantCanonical=true"));
});

test("identidade @c.us usa correspondência exata e permanece canônica", async () => {
  const registration = {
    registrationId: "REG000010",
    primaryIdentity: "5511999999999",
    identityAliases: ["5511999999999", "5511999999999@c.us"],
    mainAccount: { nick: "ContaExata" },
    name: "Nome Exato"
  };
  const f = fixture([registration, supremo]);
  const msg = f.message({
    author: "5511999999999@c.us",
    contact: { id: { _serialized: "5511999999999@c.us" } }
  });
  await f.command("vou").execute(null, msg, []);
  assert.deepEqual(f.repository.getRaidById(f.raidId).participants, ["5511999999999"]);
  assert.match(msg.replies.at(-1), /Treinador: ContaExata/);
  assert.ok(f.logs.includes("exactRegistrationMatches=1"));
});

test("remetente sem cadastro não herda outro cadastro nem entra na Raid", async () => {
  const f = fixture([supremo]);
  const msg = f.message({
    author: "unknown@lid",
    contact: { id: { _serialized: "unknown@lid" }, pushname: "Contato sem cadastro" }
  });
  await f.command("vou").execute(null, msg, []);
  assert.deepEqual(f.repository.getRaidById(f.raidId).participants, []);
  assert.match(msg.replies.at(-1), /ainda não possui cadastro/);
  assert.doesNotMatch(msg.replies.join("\n"), /supremomadu|@lid|@c\.us|@g\.us/);
});

test("!desistir remove somente a identidade canônica do remetente", async () => {
  const f = fixture([mychelle, supremo]);
  f.repository.addParticipant(f.raidId, "mychelle-primary@lid", "raid@g.us");
  f.repository.addParticipant(f.raidId, "supremo@lid", "raid@g.us");
  const msg = f.message();
  await f.command("desistir").execute(null, msg, []);
  assert.deepEqual(f.repository.getRaidById(f.raidId).participants, ["supremo@lid"]);
  assert.match(msg.replies.at(-1), /Treinador: MychelleGO/);
});

test("aliases ambíguos não escolhem o primeiro cadastro nem adicionam participante", async () => {
  const conflicting = {
    registrationId: "REG000003",
    primaryIdentity: "other@lid",
    identityAliases: ["other@lid", "mychelle@lid"],
    mainAccount: { nick: "Conflito" }
  };
  const f = fixture([mychelle, conflicting]);
  const msg = f.message();
  await f.command("vou").execute(null, msg, []);
  assert.deepEqual(f.repository.getRaidById(f.raidId).participants, []);
  assert.match(msg.replies.at(-1), /confirmar seu cadastro com segurança/);
  assert.ok(f.logs.includes("aliasRegistrationMatches=2"));
});

test("nome público usa nick, nome cadastrado, contato e Treinador em ordem segura", async () => {
  const byName = { ...mychelle, mainAccount: { nick: "" }, nick: "", name: "Nome Cadastrado" };
  const f = fixture([byName]);
  assert.equal(await f.service.getParticipantName("mychelle@lid"), "Nome Cadastrado");

  const contactOnly = fixture([]);
  assert.equal(await contactOnly.service.getParticipantName("unknown@lid", {
    contact: { pushname: "Contato Seguro" }
  }), "Contato Seguro");
  assert.equal(await contactOnly.service.getParticipantName("unknown@lid"), "Treinador");
  assert.doesNotMatch(contactOnly.logs.join("\n"), /unknown|@lid|Contato Seguro/);
});

test("!lista resolve o cadastro correto e não expõe identidades internas", async () => {
  const f = fixture([mychelle, supremo]);
  f.repository.addParticipant(f.raidId, "mychelle-primary@lid", "raid@g.us");
  const msg = f.message();
  await f.command("lista").execute(null, msg, []);
  assert.match(msg.replies.at(-1), /1\. MychelleGO/);
  assert.doesNotMatch(msg.replies.at(-1), /supremomadu|@lid|@c\.us|@g\.us|wa\.me/);
});

test("!vou, !desistir e !lista resolvem diretamente a publicação respondida", async () => {
  const f = fixture([mychelle]);
  const quotedMessage = () => {
    const msg = f.message();
    msg.hasQuotedMsg = true;
    msg._data = { quotedMsg: { id: { _serialized: "official-message" } } };
    msg.getQuotedMessage = async () => { throw new Error("não deveria carregar"); };
    return msg;
  };

  const join = quotedMessage();
  await f.command("vou").execute(null, join, []);
  assert.match(join.replies.at(-1), /Treinador: MychelleGO/);

  const list = quotedMessage();
  await f.command("lista").execute(null, list, []);
  assert.match(list.replies.at(-1), /1\. MychelleGO/);

  const leave = quotedMessage();
  await f.command("desistir").execute(null, leave, []);
  assert.match(leave.replies.at(-1), /Treinador: MychelleGO/);
  assert.deepEqual(f.repository.getRaidById(f.raidId).participants, []);
});

test("resposta usa getQuotedMessage quando o ID direto não está disponível", async () => {
  const f = fixture([mychelle]);
  const msg = f.message();
  msg.hasQuotedMsg = true;
  msg.id = { _serialized: "command-message" };
  msg.getQuotedMessage = async () => ({ id: { _serialized: "official-message" } });
  await f.command("vou").execute(null, msg, []);
  assert.match(msg.replies.at(-1), /Treinador: MychelleGO/);
});

test("falhas ou retorno vazio de getQuotedMessage permanecem seguros", async () => {
  for (const getQuotedMessage of [
    async () => undefined,
    async () => { throw new Error("falha temporária"); }
  ]) {
    const f = fixture([mychelle]);
    const msg = f.message();
    msg.hasQuotedMsg = true;
    msg.id = { _serialized: "command-message" };
    msg.getQuotedMessage = getQuotedMessage;
    await f.command("vou").execute(null, msg, []);
    assert.match(msg.replies.at(-1), /Não foi possível consultar a mensagem respondida/);
    assert.deepEqual(f.repository.getRaidById(f.raidId).participants, []);
  }
});

test("mensagem citada sem publicação não é associada por conteúdo", async () => {
  const f = fixture([mychelle]);
  const msg = f.message();
  msg.hasQuotedMsg = true;
  msg._data = { quotedMsg: { id: { _serialized: "unrelated-official-message" } } };
  await f.command("lista").execute(null, msg, []);
  assert.match(msg.replies.at(-1), /Raid não encontrada/);
});

test("ID explícito aceita forma direta, palavra RAID opcional e caixa variada", async () => {
  for (const variant of ["direct", "upper", "lower"]) {
    const f = fixture([mychelle]);
    const idArgs = variant === "direct"
      ? [f.raidId]
      : variant === "upper"
        ? ["RAID", f.raidId]
        : ["raid", f.raidId.toLowerCase()];
    const join = f.message();
    await f.command("vou").execute(null, join, idArgs);
    assert.match(join.replies.at(-1), /PARTICIPAÇÃO CONFIRMADA/);
    const list = f.message();
    await f.command("lista").execute(null, list, idArgs);
    assert.match(list.replies.at(-1), /1\. MychelleGO/);
    const leave = f.message();
    await f.command("desistir").execute(null, leave, idArgs);
    assert.match(leave.replies.at(-1), /PARTICIPAÇÃO CANCELADA/);
  }
});

test("contato divergente não substitui a identidade autoritativa de msg.author", async () => {
  const f = fixture([mychelle, supremo]);
  const msg = f.message({
    author: "mychelle@lid",
    contact: { id: { _serialized: "supremo@lid" }, pushname: "Contato incorreto" }
  });
  await f.command("vou").execute(null, msg, []);
  assert.deepEqual(f.repository.getRaidById(f.raidId).participants, ["mychelle-primary@lid"]);
  assert.match(msg.replies.at(-1), /MychelleGO/);
  assert.doesNotMatch(msg.replies.at(-1), /supremomadu/);
});

test("ID parcial ou texto adicional é rejeitado com orientação profissional", async () => {
  for (const args of [["1042"], ["R"], ["RAID"], ["R1042", "extra"]]) {
    const f = fixture([mychelle]);
    const msg = f.message();
    await f.command("lista").execute(null, msg, args);
    assert.equal(
      msg.replies.at(-1),
      "❌ Raid não encontrada.\n\nConfira o ID e tente novamente.\nExemplo: !lista R1042"
    );
  }
});

test("mensagens de entrada, saída, duplicidade e lista seguem o formato profissional", async () => {
  const f = fixture([mychelle]);
  const join = f.message();
  await f.command("vou").execute(null, join, [f.raidId]);
  assert.match(join.replies.at(-1), /^✅ PARTICIPAÇÃO CONFIRMADA\n\n👤 Treinador: MychelleGO/);
  const duplicate = f.message();
  await f.command("vou").execute(null, duplicate, [f.raidId]);
  assert.equal(duplicate.replies.at(-1), `ℹ️ Você já está participando da Raid ${f.raidId}.`);
  const list = f.message();
  await f.command("lista").execute(null, list, [f.raidId]);
  assert.match(list.replies.at(-1), new RegExp(`^👥 PARTICIPANTES — ${f.raidId}`));
  const leave = f.message();
  await f.command("desistir").execute(null, leave, [f.raidId]);
  assert.match(leave.replies.at(-1), /^🚪 PARTICIPAÇÃO CANCELADA/);
  const absent = f.message();
  await f.command("desistir").execute(null, absent, [f.raidId]);
  assert.equal(absent.replies.at(-1), `ℹ️ Você não está participando da Raid ${f.raidId}.`);
});

test("comando solto ignora publicação vencida e seleciona a única Raid vigente", async () => {
  const f = fixture([mychelle]);
  const stale = f.repository.createRaid({
    name: "antiga",
    groupId: "raid@g.us",
    status: "active",
    remainingMinutes: 1
  });
  f.repository.publishRaid(stale.id, {
    groupId: "raid@g.us",
    messageId: "stale-message",
    publishedAt: "2020-01-01T00:00:00.000Z"
  });
  const msg = f.message();
  await f.command("lista").execute(null, msg, []);
  assert.match(msg.replies.at(-1), new RegExp(f.raidId));
  assert.doesNotMatch(msg.replies.at(-1), /Antiga/);
});

test("comando solto orienta quando há várias Raids vigentes e quando não há nenhuma", async () => {
  const multiple = fixture([mychelle]);
  const second = multiple.repository.createRaid({
    name: "segunda",
    groupId: "raid@g.us",
    status: "active"
  });
  multiple.repository.publishRaid(second.id, {
    groupId: "raid@g.us",
    messageId: "second-message"
  });
  const multipleMsg = multiple.message();
  await multiple.command("vou").execute(null, multipleMsg, []);
  assert.equal(
    multipleMsg.replies.at(-1),
    "⚠️ Existem várias Raids ativas neste grupo.\n\n" +
    "Responda à mensagem da Raid desejada ou use:\n!vou R1042"
  );

  const none = fixture([mychelle]);
  none.repository.updateRaid(none.raidId, { status: "completed" });
  const noneMsg = none.message();
  await none.command("lista").execute(null, noneMsg, []);
  assert.match(noneMsg.replies.at(-1), /Não há raid publicada ativa/);
});
