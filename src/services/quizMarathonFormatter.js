"use strict";

function safePlayerName(value) {
  const name = String(value || "").trim();
  if (!name || name.includes("${") || /@(lid|g\.us|c\.us|s\.whatsapp\.net)/i.test(name) || /^\+?\d[\d\s().-]{7,}$/.test(name) || /\*{4,}\w*/.test(name)) return "Treinador";
  return name;
}

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}min ${seconds}s`;
}

function formatConfiguredTime(milliseconds) {
  const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  if (seconds < 60) return `${seconds} segundo${seconds === 1 ? "" : "s"}`;
  if (seconds % 60 === 0) { const minutes = seconds / 60; return `${minutes} minuto${minutes === 1 ? "" : "s"}`; }
  return formatDuration(milliseconds);
}

function formatProgress(current, total) {
  const size = Math.max(1, Number(total) || 1);
  const completed = Math.min(size, Math.max(0, Number(current) || 0));
  return `${"🟩".repeat(completed)}${"⬜".repeat(size - completed)}`;
}

function formatStart(total, durationMs = 120_000, intervalMs = 3_000) {
  return ["🏁 *MARATONA DO QUIZ*", "", `Perguntas: ${total}`, "", `Tempo por pergunta: ${formatConfiguredTime(durationMs)}`, "", `Intervalo: ${formatConfiguredTime(intervalMs)}`, "", "Boa sorte!"].join("\n");
}

function formatQuestion(question, current, total, translateDifficulty, durationMs = 120_000) {
  const lines = [`🎮 *PERGUNTA ${current}/${total}*`, "", formatProgress(current, total), "", question.prompt];
  if (question.options?.length) lines.push("", ...question.options.map((option) => `${option.key}) ${option.value}`));
  lines.push("", `🎯 Dificuldade: ${translateDifficulty(question.difficulty)}`, `🏆 Vale: ${question.points} pontos`, `⏳ Tempo: ${formatConfiguredTime(durationMs)}`);
  return lines.join("\n");
}

function formatCorrectAnswer(name, points, hasNext = true, intervalMs = 3_000) {
  const lines = [`🎉 *${safePlayerName(name)} acertou!*`, "", `+${Number(points || 0)} pontos`];
  if (hasNext) lines.push("", `Próxima pergunta em ${formatConfiguredTime(intervalMs)}...`);
  return lines.join("\n");
}

function formatTimeout(hasNext = true, intervalMs = 3_000) {
  return hasNext ? `⏳ O tempo acabou!\n\nPróxima pergunta em ${formatConfiguredTime(intervalMs)}...` : "⏳ O tempo acabou!";
}

function formatScoreboard(ranking, final = false) {
  const safeRanking = (ranking || []).map((entry) => ({ ...entry, name: safePlayerName(entry.name) }));
  if (!safeRanking.length) return final ? "Ainda não houve respostas corretas." : "🏆 *PLACAR*\n\nAinda não há pontuações.";
  if (!final) return ["🏆 *PLACAR*", "", ...safeRanking.flatMap((entry, index) => [`${index + 1}.`, entry.name, `${entry.points} pontos`, ""])].join("\n").trim();
  const medals = ["🥇", "🥈", "🥉"];
  return safeRanking.slice(0, 3).flatMap((entry, index) => [`${medals[index]} ${entry.name}`, `${entry.points} pts`, ""]).join("\n").trim();
}

function formatFinal(session, ranking, elapsedMs) {
  const mvp = ranking?.[0] || null;
  return [
    "🏁 *MARATONA ENCERRADA*", "", "━━━━━━━━━━━━━━", "",
    "📚 Perguntas", String(session.totalQuestions), "",
    "👥 Participantes", String(Object.keys(session.participants || {}).length), "",
    "⏱ Tempo", formatDuration(elapsedMs), "", "━━━━━━━━━━━━━━", "",
    formatScoreboard(ranking, true),
    mvp ? "\n⭐ *MVP*" : null,
    mvp ? `\n${safePlayerName(mvp.name)}` : null,
    mvp ? `\n${mvp.correctAnswers} respostas corretas` : null,
    "", "🎉 Obrigado a todos!", "", "Até a próxima Maratona!"
  ].filter((value) => value !== null).join("\n");
}

function formatStatus(session, remaining, participants) {
  return ["*Maratona ativa*", "", "Pergunta:", `${session.currentQuestion}/${session.totalQuestions}`, "", "Tempo restante:", formatDuration(remaining), "", "Participantes:", String(participants)].join("\n");
}

module.exports = { safePlayerName, formatDuration, formatProgress, formatStart, formatQuestion, formatCorrectAnswer, formatTimeout, formatScoreboard, formatFinal, formatStatus };
