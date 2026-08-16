"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "database", "guided-flows", "sessions.json");
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const queues = new Map();
const clone = (value) => JSON.parse(JSON.stringify(value));

function createGuidedFlowService(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_FILE);
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const clock = options.clock || (() => new Date());
  const nowIso = () => clock().toISOString();
  const expiresIso = () => new Date(clock().getTime() + ttlMs).toISOString();

  function buildFlowKey(platform, conversationId, userId) {
    if (!platform || !conversationId || !userId) throw new Error("Fluxo exige platform, conversationId e userId.");
    return `${platform}:${conversationId}:${userId}`;
  }

  function enqueue(operation) {
    const previous = queues.get(filePath) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(filePath, current);
    return current.finally(() => { if (queues.get(filePath) === current) queues.delete(filePath); });
  }

  async function atomicWrite(database) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(temporary, filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async function load() {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      await atomicWrite({ schemaVersion: 1, updatedAt: nowIso(), sessions: {} });
    }
    let parsed;
    try { parsed = JSON.parse(await fsp.readFile(filePath, "utf8")); }
    catch (error) { throw new Error(`Banco de fluxos guiados inválido: ${error.message}`); }
    if (parsed.schemaVersion !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") throw new Error("Schema de fluxos guiados inválido.");
    return parsed;
  }

  async function mutate(operation) {
    return enqueue(async () => {
      const database = await load();
      const result = await operation(database);
      database.updatedAt = nowIso();
      await atomicWrite(database);
      return clone(result);
    });
  }

  async function getActiveFlow(platform, conversationId, userId) {
    const database = await load();
    const key = buildFlowKey(platform, conversationId, userId);
    const session = database.sessions[key];
    if (!session || session.status !== "active") return null;
    if (Date.parse(session.expiresAt) <= clock().getTime()) {
      await expireFlow(platform, conversationId, userId);
      return null;
    }
    return clone(session);
  }

  async function startFlow(input) {
    return mutate((database) => {
      const key = buildFlowKey(input.platform, input.conversationId, input.userId);
      const existing = database.sessions[key];
      if (existing?.status === "active" && Date.parse(existing.expiresAt) > clock().getTime()) {
        return { started: false, conflict: true, session: existing };
      }
      const timestamp = nowIso();
      const session = {
        flowId: input.flowId, platform: input.platform, conversationId: input.conversationId, userId: input.userId,
        step: input.step, data: clone(input.data || {}), history: [], openedAt: timestamp, updatedAt: timestamp,
        expiresAt: expiresIso(), status: "active"
      };
      database.sessions[key] = session;
      return { started: true, conflict: false, session };
    });
  }

  async function updateFlow(platform, conversationId, userId, changes = {}) {
    return mutate((database) => {
      const key = buildFlowKey(platform, conversationId, userId);
      const session = database.sessions[key];
      if (!session || session.status !== "active") return null;
      if (changes.flowId || changes.platform || changes.conversationId || changes.userId || changes.openedAt) throw new Error("Identidade do fluxo é imutável.");
      Object.assign(session, clone(changes), { updatedAt: nowIso(), expiresAt: expiresIso() });
      return session;
    });
  }

  async function advanceFlow(platform, conversationId, userId, nextStep, dataChanges = {}) {
    return mutate((database) => {
      const key = buildFlowKey(platform, conversationId, userId);
      const session = database.sessions[key];
      if (!session || session.status !== "active") return null;
      session.history.push({ step: session.step, data: clone(session.data), timestamp: nowIso() });
      session.step = nextStep;
      session.data = { ...session.data, ...clone(dataChanges) };
      session.updatedAt = nowIso();
      session.expiresAt = expiresIso();
      return session;
    });
  }

  async function goBack(platform, conversationId, userId) {
    return mutate((database) => {
      const key = buildFlowKey(platform, conversationId, userId);
      const session = database.sessions[key];
      if (!session || session.status !== "active") return null;
      const previous = session.history.pop();
      if (!previous) return { ...session, cannotGoBack: true };
      session.step = previous.step;
      session.data = previous.data;
      session.updatedAt = nowIso();
      session.expiresAt = expiresIso();
      return session;
    });
  }

  async function removeFlow(platform, conversationId, userId, status) {
    return mutate((database) => {
      const key = buildFlowKey(platform, conversationId, userId);
      const session = database.sessions[key];
      if (!session) return null;
      const result = { ...session, status, updatedAt: nowIso() };
      delete database.sessions[key];
      return result;
    });
  }

  const cancelFlow = (platform, conversationId, userId) => removeFlow(platform, conversationId, userId, "cancelled");
  const finishFlow = (platform, conversationId, userId) => removeFlow(platform, conversationId, userId, "finished");
  const expireFlow = (platform, conversationId, userId) => removeFlow(platform, conversationId, userId, "expired");

  async function clearExpiredFlows() {
    return mutate((database) => {
      let removed = 0;
      for (const [key, session] of Object.entries(database.sessions)) {
        if (session.status !== "active" || Date.parse(session.expiresAt) <= clock().getTime()) { delete database.sessions[key]; removed += 1; }
      }
      return removed;
    });
  }

  async function hasActiveFlowForUser(userId) {
    if (!userId) return false;
    const database = await load();
    return Object.values(database.sessions).some(session => session.userId === userId && session.status === "active" && Date.parse(session.expiresAt) > clock().getTime());
  }

  async function removeUserFlows(userId) {
    if (!userId) return { removed: false, itemsRemoved: 0 };
    return mutate(database => {
      let removed = 0;
      for (const [key, session] of Object.entries(database.sessions)) if (session.userId === userId) { delete database.sessions[key]; removed += 1; }
      return { removed: removed > 0, itemsRemoved: removed };
    });
  }

  return { startFlow, getActiveFlow, updateFlow, advanceFlow, goBack, cancelFlow, finishFlow, expireFlow, clearExpiredFlows, hasActiveFlowForUser, removeUserFlows, buildFlowKey };
}

const service = createGuidedFlowService();
module.exports = { ...service, createGuidedFlowService, DEFAULT_TTL_MS };
