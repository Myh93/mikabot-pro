"use strict";

const METRICS = Object.freeze([
  "configuration.resolve.total",
  "configuration.resolve.cacheHit",
  "configuration.resolve.cacheMiss",
  "configuration.reload.total",
  "configuration.reload.success",
  "configuration.reload.failure",
  "configuration.validation.success",
  "configuration.validation.failure",
  "configuration.persistence.read",
  "configuration.persistence.write",
  "configuration.persistence.remove",
  "configuration.authorization.allowed",
  "configuration.authorization.denied",
  "configuration.authorization.error",
  "configuration.cache.invalidations"
]);

const EVENTS = new Set([
  "configuration.changed",
  "configuration.removed",
  "configuration.reload",
  "configuration.validation.failed",
  "configuration.authorization.denied",
  "configuration.persistence.failed"
]);

const FORBIDDEN_FIELDS = /value|token|password|secret|credential|phone|jid|identity|author|user|groupId|communityId/i;
const FORBIDDEN_VALUE = /@(?:lid|c\.us|s\.whatsapp\.net|g\.us)\b|\b\d{8,}\b/i;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function safeText(value, fallback = "unknown") {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value).trim();
  if (!text || FORBIDDEN_VALUE.test(text)) return "[redacted]";
  return text.slice(0, 160);
}

function sanitizePayload(payload = {}) {
  const result = {};
  for (const [field, value] of Object.entries(payload || {})) {
    if (FORBIDDEN_FIELDS.test(field)) continue;
    if (["key", "scope", "source", "operation"].includes(field)) {
      result[field] = safeText(value);
    } else if (field === "durationMs" && Number.isFinite(value)) {
      result.durationMs = Math.max(0, value);
    }
  }
  return result;
}

function createConfigurationObservabilityService(options = {}) {
  const clock = options.clock || (() => new Date());
  const sink = options.sink || null;
  const metrics = Object.fromEntries(METRICS.map((name) => [name, 0]));
  const events = [];

  function recordMetric(name, amount = 1) {
    try {
      if (!Object.prototype.hasOwnProperty.call(metrics, name)) return false;
      const increment = Number(amount);
      if (!Number.isFinite(increment)) return false;
      metrics[name] += increment;
      if (typeof sink?.recordMetric === "function") {
        try { sink.recordMetric(name, increment); } catch (_) {}
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function emit(event, payload = {}) {
    try {
      if (!EVENTS.has(event)) return false;
      const item = Object.freeze({
        timestamp: clock().toISOString(),
        event,
        key: "unknown",
        scope: "unknown",
        source: "configuration",
        operation: "unknown",
        ...sanitizePayload(payload)
      });
      events.push(item);
      if (typeof sink?.emit === "function") {
        try { sink.emit(event, clone(item)); } catch (_) {}
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function getMetrics() {
    return Object.freeze({ ...metrics });
  }

  function getEvents() {
    return Object.freeze(events.map((event) => Object.freeze({ ...event })));
  }

  function reset() {
    for (const name of METRICS) metrics[name] = 0;
    events.length = 0;
  }

  return Object.freeze({ recordMetric, emit, getMetrics, getEvents, reset });
}

module.exports = {
  createConfigurationObservabilityService,
  METRICS,
  sanitizePayload
};
