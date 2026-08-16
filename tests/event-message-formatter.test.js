"use strict";

const assert = require("node:assert/strict");
const fsp = require("node:fs").promises;
const path = require("node:path");
const test = require("node:test");
const configurationService = require("../src/services/configurationService");
const formatter = require("../src/services/eventMessageFormatter");

const NOW = new Date("2026-07-16T15:00:00.000Z");
const event = {
  id: "E0003", title: "POKEQUIZ", description: "Boa sorte, amigos!", type: "quiz",
  status: "scheduled", startsAt: "2026-07-16T23:00:00.000Z", timezone: "America/Fortaleza",
  prize: "Pikachu Shiny", groupId: "123@g.us", creatorId: "456@lid"
};
const options = { now: NOW, groupName: "Área 51" };

test("timezone padrão é obtido pela fachada de configuração", async () => {
  assert.equal(formatter.DEFAULT_TIMEZONE, configurationService.get("events.timezone"));
  const source = await fsp.readFile(
    path.join(__dirname, "..", "src", "services", "eventMessageFormatter.js"),
    "utf8"
  );
  assert.match(source, /configurationService\.get\(["']events\.timezone["']\)/);
  assert.doesNotMatch(source, /const DEFAULT_TIMEZONE\s*=\s*["']America\/Fortaleza["']/);
});

test("datas relativas e comuns são amigáveis no timezone do evento", () => {
  assert.equal(formatter.formatFriendlyDate("2026-07-16T23:00:00Z", options), "Hoje");
  assert.equal(formatter.formatFriendlyDate("2026-07-17T23:00:00Z", options), "Amanhã");
  assert.equal(formatter.formatFriendlyDate("2026-07-15T23:00:00Z", options), "Ontem");
  assert.equal(formatter.formatFriendlyDate("2026-08-20T23:00:00Z", options), "20/08/2026");
  assert.equal(formatter.formatFriendlyTime(event.startsAt, options), "20:00");
});

test("todos os tipos e status possuem tradução", () => {
  assert.deepEqual(["quiz", "raid", "championship", "giveaway", "pokemon_go", "notice", "custom"].map(formatter.formatEventType), ["Quiz", "Raid", "Campeonato", "Sorteio", "Pokémon GO", "Aviso", "Personalizado"]);
  assert.deepEqual(["draft", "scheduled", "published", "running", "finished", "cancelled", "archived"].map(formatter.formatEventStatus), ["Rascunho", "Agendado", "Publicado", "Em andamento", "Finalizado", "Cancelado", "Arquivado"]);
});

test("publicação respeita blocos opcionais e privacidade", () => {
  const complete = formatter.formatPublicEvent(event, options);
  assert.match(complete, /EVENTO CONFIRMADO[\s\S]*Boa sorte, amigos![\s\S]*Prêmio:[\s\S]*Pikachu Shiny/);
  for (const hidden of [event.id, event.groupId, event.creatorId, "@g.us", "@lid", "Ash:"]) assert.equal(complete.includes(hidden), false);
  const minimal = formatter.formatPublicEvent({ ...event, description: "", prize: null }, options);
  assert.equal(minimal.includes("📝"), false);
  assert.equal(minimal.includes("Prêmio"), false);
});

test("avisos, início, encerramento e cancelamento usam textos oficiais", () => {
  assert.match(formatter.formatReminder24h(event, options), /LEMBRETE DE EVENTO[\s\S]*Falta 1 dia[\s\S]*Hoje[\s\S]*20:00/);
  assert.match(formatter.formatReminder1h(event, options), /FALTA 1 HORA![\s\S]*20:00/);
  assert.match(formatter.formatReminder30m(event, options), /FALTAM 30 MINUTOS!/);
  assert.match(formatter.formatReminder10m(event, options), /ATENÇÃO![\s\S]*10 minutos/);
  assert.match(formatter.formatEventStarted(event), /O EVENTO COMEÇOU![\s\S]*Boa sorte, amigos!/);
  assert.match(formatter.formatEventFinished(event), /EVENTO ENCERRADO[\s\S]*Obrigado pela participação/);
  assert.match(formatter.formatEventCancelled(event, options), /EVENTO CANCELADO[\s\S]*Hoje[\s\S]*20:00/);
});

test("revisão guiada apresenta os campos sem identificadores técnicos", () => {
  const text = formatter.formatGuidedReview({ groupName: "Área 51", type: "quiz", title: "POKEQUIZ", description: "Boa sorte!", date: "Hoje", time: "20:00", prize: null, noticeLabel: "30 min e 10 min" });
  assert.match(text, /REVISÃO DO EVENTO[\s\S]*Área 51[\s\S]*Quiz[\s\S]*POKEQUIZ[\s\S]*Nenhum[\s\S]*30 min e 10 min/);
});

test("confirmações distinguem rascunho, agendamento e publicação", () => {
  assert.match(formatter.formatPrivateConfirmation({ ...event, status: "draft" }, options), /Rascunho[\s\S]*salvo como rascunho/);
  assert.match(formatter.formatPrivateConfirmation(event, options), /Agendado[\s\S]*ficou agendado/);
  assert.match(formatter.formatPrivateConfirmation({ ...event, status: "published" }, { ...options, published: true }), /Publicado[\s\S]*enviado ao grupo/);
});

test("detalhes administrativos preservam ID e listagem amigável não o expõe", () => {
  const details = formatter.formatEventDetails(event, options);
  assert.match(details, /DETALHES DO EVENTO[\s\S]*E0003[\s\S]*Área 51[\s\S]*Hoje[\s\S]*20:00/);
  assert.equal(details.includes("@g.us"), false);
  assert.equal(details.includes("@lid"), false);
  const item = formatter.formatEventListItem(event, 1, options);
  assert.equal(item, "1️⃣ POKEQUIZ\n   📅 Hoje às 20:00\n   🎮 Quiz\n   Status: Próximo");
  assert.equal(item.includes("E0003"), false);
  assert.equal(item.includes(event.description), false);
});

test("service, scheduler e fluxo guiado reutilizam o formatador central", async () => {
  for (const file of ["eventService.js", "eventSchedulerService.js", "eventGuidedFlowService.js"]) {
    const source = await fsp.readFile(path.join(__dirname, "..", "src", "services", file), "utf8");
    assert.match(source, /eventMessageFormatter/);
  }
});
