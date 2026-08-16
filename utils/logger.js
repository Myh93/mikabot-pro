const fs = require("fs");
const path = require("path");
const util = require("util");

const logFile = path.join(__dirname, "..", "logs.txt");
const maxLogSize = 5 * 1024 * 1024;

function timestamp() {
  return new Date().toLocaleString("pt-BR");
}

function rotateLogIfNeeded() {
  if (!fs.existsSync(logFile) || fs.statSync(logFile).size < maxLogSize) return;

  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  const rotatedLog = path.join(path.dirname(logFile), `logs-${suffix}.txt`);
  fs.renameSync(logFile, rotatedLog);
}

function appendLog(line) {
  try {
    rotateLogIfNeeded();
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  } catch (err) {
    console.error("Falha ao gravar o arquivo de log:", err);
  }
}

function normalizeError(err) {
  return err instanceof Error
    ? err
    : new Error(typeof err === "string" ? err : util.inspect(err, { depth: null }));
}

function logInfo(message) {
  const line = `[${timestamp()}] ${message}`;
  console.log(line);
  appendLog(line);
}

function logCommand(comando, autor) {
  const line = `[${timestamp()}] 🤖 Comando: ${comando} | Autor: ${autor}`;
  console.log(`\x1b[32m${line}\x1b[0m`);
  appendLog(line);
}

function logError(comando, erro) {
  const normalizedError = normalizeError(erro);
  const line = `[${timestamp()}] ❌ ERRO no comando: ${comando} | Detalhes: ${normalizedError.message}`;
  console.error(`\x1b[31m${line}\x1b[0m`);
  appendLog(`${line}\n${normalizedError.stack}`);
}

function logDetailedError(contexto, err) {
  const normalizedError = normalizeError(err);
  const details = [
    `[${timestamp()}] ❌ ${contexto}`,
    `Tipo do erro: ${err?.constructor?.name || typeof err}`,
    `Mensagem: ${normalizedError.message}`,
    `Erro original: ${util.inspect(err, { depth: null, colors: false })}`,
    `Stack trace:\n${normalizedError.stack}`
  ].join("\n");

  console.error(details);
  appendLog(details);
}

module.exports = { logInfo, logCommand, logError, logDetailedError };
