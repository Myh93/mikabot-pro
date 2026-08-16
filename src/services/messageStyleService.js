"use strict";

const SEPARATOR = "━━━━━━━━━━━━━━━━━━━━━━";
const STATUS = Object.freeze({
  success: "✅",
  error: "❌",
  warning: "⚠️",
  info: "ℹ️",
  private: "🔒",
  back: "↩️"
});

function section(title, lines = []) {
  return [SEPARATOR, title, SEPARATOR, ...(lines.length ? ["", ...lines] : [])].join("\n");
}

function status(type, message) {
  const icon = STATUS[type] || STATUS.info;
  return `${icon} ${String(message || "").trim()}`;
}

module.exports = { SEPARATOR, STATUS, section, status };
