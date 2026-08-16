"use strict";

const configurationService = require("./configurationService");

const DEFAULT_TIMEZONE = configurationService.get("events.timezone");
const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━";

const TYPE_LABELS = Object.freeze({
  quiz: "Quiz", raid: "Raid", championship: "Campeonato", giveaway: "Sorteio",
  pokemon_go: "Pokémon GO", notice: "Aviso", custom: "Personalizado"
});
const STATUS_LABELS = Object.freeze({
  draft: "Rascunho", scheduled: "Agendado", published: "Publicado", running: "Em andamento",
  finished: "Finalizado", cancelled: "Cancelado", archived: "Arquivado"
});

function dateParts(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function dayNumber(parts) {
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000;
}

function formatFriendlyDate(value, options = {}) {
  if (!value) return "Não informada";
  const timezone = options.timezone || DEFAULT_TIMEZONE;
  const target = dateParts(value, timezone);
  const reference = dateParts(options.now || new Date(), timezone);
  if (!target || !reference) return "Não informada";
  const difference = dayNumber(target) - dayNumber(reference);
  if (difference === 0) return "Hoje";
  if (difference === 1) return "Amanhã";
  if (difference === -1) return "Ontem";
  return `${target.day}/${target.month}/${target.year}`;
}

function formatFriendlyTime(value, options = {}) {
  if (!value) return "Não informado";
  const parts = dateParts(value, options.timezone || DEFAULT_TIMEZONE);
  return parts ? `${parts.hour}:${parts.minute}` : "Não informado";
}

const formatEventType = (type) => TYPE_LABELS[type] || TYPE_LABELS.custom;
const formatEventStatus = (status) => STATUS_LABELS[status] || String(status || "Não informado");
const eventDate = (event, options) => formatFriendlyDate(event?.startsAt, { ...options, timezone: event?.timezone || options?.timezone });
const eventTime = (event, options) => formatFriendlyTime(event?.startsAt, { ...options, timezone: event?.timezone || options?.timezone });
const titleLine = (event) => `📌 *${String(event?.title || "Evento")}*`;

function formatPublicEvent(event, options = {}) {
  const lines = [DIVIDER, "📢 *EVENTO CONFIRMADO*", DIVIDER, "", titleLine(event), ""];
  if (event?.description) lines.push(`📝 ${event.description}`, "");
  lines.push(`🎮 Tipo: ${formatEventType(event?.type)}`, `📅 Data: ${eventDate(event, options)}`, `⏰ Horário: ${eventTime(event, options)}`);
  if (event?.prize) lines.push("", "🎁 Prêmio:", String(event.prize));
  lines.push("", "👥 Todos podem participar!", "", "Boa sorte!", DIVIDER);
  return lines.join("\n");
}

function wrap(header, body) { return [DIVIDER, header, DIVIDER, "", ...body, DIVIDER].join("\n"); }
function formatReminder24h(event, options = {}) { return wrap("📅 *LEMBRETE DE EVENTO*", ["Falta 1 dia para:", "", titleLine(event), "", `📅 Data: ${eventDate(event, options)}`, `⏰ Horário: ${eventTime(event, options)}`, "", "Prepare-se!"]); }
function formatReminder1h(event, options = {}) { return wrap("⏰ *FALTA 1 HORA!*", [titleLine(event), "", "O evento está quase começando.", "", `⏰ Horário: ${eventTime(event, options)}`]); }
function formatReminder30m(event) { return wrap("⏰ *FALTAM 30 MINUTOS!*", [titleLine(event), "", "Estamos quase começando!"]); }
function formatReminder10m(event) { return wrap("🚨 *ATENÇÃO!*", ["Faltam apenas 10 minutos para:", "", titleLine(event), "", "Prepare-se!"]); }
function formatEventStarted(event) { const body = [titleLine(event)]; if (event?.description) body.push("", `📝 ${event.description}`); body.push("", "Boa sorte a todos!", "", "🎮 Aproveitem o evento!"); return wrap("🎉 *O EVENTO COMEÇOU!*", body); }
function formatEventFinished(event) { return wrap("🏁 *EVENTO ENCERRADO*", [titleLine(event), "", "Obrigado pela participação!", "", "Até o próximo evento!"]); }
function formatEventCancelled(event, options = {}) { return wrap("❌ *EVENTO CANCELADO*", [titleLine(event), "", `📅 Data: ${eventDate(event, options)}`, `⏰ Horário: ${eventTime(event, options)}`, "", "O evento não acontecerá mais no horário informado."]); }

function formatPrivateConfirmation(event, options = {}) {
  const status = options.status || event?.status;
  const lines = ["✅ *EVENTO CRIADO COM SUCESSO!*", "", titleLine(event), "", `📂 Grupo: ${options.groupName || "Grupo cadastrado"}`, `📅 Data: ${eventDate(event, options)}`, `⏰ Horário: ${eventTime(event, options)}`, `📋 Status: ${formatEventStatus(status)}`, "", `🆔 ID administrativo: ${event?.id}`];
  if (options.published) lines.push("", "📢 O evento também foi enviado ao grupo.");
  else if (status === "draft") lines.push("", "📝 O evento foi salvo como rascunho.");
  else lines.push("", "⏳ O evento ficou agendado.");
  return lines.join("\n");
}

function formatGuidedReview(data, options = {}) {
  const start = options.startsAt || data?.startsAt;
  const ends = options.endsAt || data?.endsAt;
  const date = start ? formatFriendlyDate(start, options) : (data?.date || "Não informado");
  const time = start ? formatFriendlyTime(start, options) : (data?.time || "Não informado");
  const end = ends ? `${formatFriendlyDate(ends, options)} às ${formatFriendlyTime(ends, options)}` : (data?.endDate && data?.endTime ? `${data.endDate} às ${data.endTime}` : "Não informado");
  return ["📋 *REVISÃO DO EVENTO*", "", "📂 Grupo:", data?.groupName || "Grupo cadastrado", "", "🎮 Tipo:", formatEventType(data?.type), "", "📌 Título:", data?.title || "Não informado", "", "📝 Descrição:", data?.description || "Não informada", "", "📅 Data:", date, "", "⏰ Horário:", time, "", "⏳ Término:", end, "", "🎁 Prêmio:", data?.prize || "Nenhum", "", "🔔 Avisos:", data?.noticeLabel || "Não informado", "", "1️⃣ Salvar como rascunho", "2️⃣ Agendar", "3️⃣ Agendar e publicar agora", "4️⃣ Editar", "5️⃣ Cancelar"].join("\n");
}

function formatEventDetails(event, options = {}) {
  return ["📅 *DETALHES DO EVENTO*", "", `🆔 ID: ${event?.id}`, `📌 Título: ${event?.title}`, `🎮 Tipo: ${formatEventType(event?.type)}`, `📋 Status: ${formatEventStatus(event?.status)}`, `📂 Grupo: ${options.groupName || "Grupo cadastrado"}`, `📅 Data: ${eventDate(event, options)}`, `⏰ Horário: ${eventTime(event, options)}`, `📝 Descrição: ${event?.description || "Não informada"}`, `🎁 Prêmio: ${event?.prize || "Nenhum"}`].join("\n");
}

function formatEventListItem(event, index, options = {}) {
  const when = event?.startsAt ? `${eventDate(event, options)} às ${eventTime(event, options)}` : "Data não informada";
  return `${index}. ${event?.id} — ${event?.title}\n   ${when}\n   Status: ${formatEventStatus(event?.status)}`;
}

module.exports = { DEFAULT_TIMEZONE, TYPE_LABELS, STATUS_LABELS, formatFriendlyDate, formatFriendlyTime, formatEventType, formatEventStatus, formatPublicEvent, formatReminder24h, formatReminder1h, formatReminder30m, formatReminder10m, formatEventStarted, formatEventFinished, formatEventCancelled, formatPrivateConfirmation, formatGuidedReview, formatEventDetails, formatEventListItem };
