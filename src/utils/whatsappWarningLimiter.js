"use strict";

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_MESSAGE = "⚠️ Falha temporária ao consultar dados do WhatsApp.";

function createWhatsAppWarningLimiter(options = {}) {
  const clock = options.clock || (() => Date.now());
  const output = options.output || ((message) => console.warn(message));
  const windowMs = options.windowMs || DEFAULT_WINDOW_MS;
  const records = new Map();

  function warn(origin, errorType = "unknown") {
    const key = `${String(origin || "unknown")}:${String(errorType || "unknown")}`;
    const now = Number(clock());
    const record = records.get(key);
    if (!record || now - record.lastWarningAt >= windowMs) {
      const suppressed = record?.suppressed || 0;
      const suffix = suppressed ? ` ${suppressed} ocorrências semelhantes foram suprimidas.` : "";
      output(`${DEFAULT_MESSAGE}${suffix}`);
      records.set(key, { lastWarningAt: now, suppressed: 0 });
      return true;
    }
    record.suppressed += 1;
    return false;
  }

  function getSuppressedCount(origin, errorType = "unknown") {
    return records.get(`${String(origin || "unknown")}:${String(errorType || "unknown")}`)?.suppressed || 0;
  }

  return { warn, getSuppressedCount };
}

const limiter = createWhatsAppWarningLimiter();
module.exports = { ...limiter, createWhatsAppWarningLimiter, DEFAULT_WINDOW_MS, DEFAULT_MESSAGE };
