"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const configurationServiceDefault = require("./configurationService");
const { isCompletePlatformContext } = require("../utils/platformContext");

const DEFAULT_FILE = path.join(__dirname, "..", "database", "menus", "sessions.json");
const queues = new Map();

function createMenuSessionService(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_FILE);
  const explicitDurationMs = options.durationMs || null;
  const configurationService = options.configurationService || configurationServiceDefault;
  const clock = options.clock || (() => new Date());
  let initialized = false;

  function sessionDuration(context = {}) {
    if (explicitDurationMs) return explicitDurationMs;
    return configurationService.getResolved("menus.sessionDurationMilliseconds", {
      platform: context.platform,
      groupId: context.groupId || context.conversationId
    }).value;
  }

  function buildMenuKey(platform, conversationId, userId) {
    if (!platform || !conversationId || !userId) throw new Error("platform, conversationId e userId são obrigatórios para o menu.");
    return `${platform}:${conversationId}:${userId}`;
  }

  function enqueue(operation) {
    const previous = queues.get(filePath) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(filePath, current);
    return current.finally(() => { if (queues.get(filePath) === current) queues.delete(filePath); });
  }

  async function atomicWrite(data) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
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

  async function ensureInitialized() {
    if (initialized) return;
    await enqueue(async () => {
      if (initialized) return;
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const exists = await fsp.access(filePath).then(() => true, () => false);
      if (!exists) await atomicWrite({ schemaVersion: 1, updatedAt: clock().toISOString(), sessions: {} });
      else {
        const parsed = JSON.parse(await fsp.readFile(filePath, "utf8"));
        if (parsed.schemaVersion !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") throw new Error("Banco de sessões de menu inválido.");
        // Sessões são deliberadamente descartadas após reinício do processo.
        await atomicWrite({ schemaVersion: 1, updatedAt: clock().toISOString(), sessions: {} });
      }
      initialized = true;
    });
  }

  async function readStore() {
    await ensureInitialized();
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  }

  async function mutate(operation) {
    await ensureInitialized();
    return enqueue(async () => {
      const store = JSON.parse(await fsp.readFile(filePath, "utf8"));
      const result = operation(store);
      store.updatedAt = clock().toISOString();
      await atomicWrite(store);
      return result === undefined ? result : JSON.parse(JSON.stringify(result));
    });
  }

  async function openMenu(context, { menuId, origin, targetGroupId = null, stack = [], options: menuOptions, duration } = {}) {
    if (!isCompletePlatformContext(context)) return null;
    return mutate((store) => {
      const resolvedDuration = duration === undefined
        ? sessionDuration(context)
        : duration;
      const key = buildMenuKey(context.platform, context.conversationId, context.userId);
      const openedAt = clock();
      store.sessions[key] = {
        menuId, platform: context.platform, conversationId: context.conversationId,
        groupId: context.groupId, userId: context.userId,
        origin: origin === "group" ? "group" : "private",
        targetGroupId: typeof targetGroupId === "string" && targetGroupId.trim() ? targetGroupId.trim() : null,
        stack: Array.isArray(stack) ? stack.filter(value => typeof value === "string" && value.trim()).map(value => value.trim()) : [],
        options: JSON.parse(JSON.stringify(menuOptions || {})),
        openedAt: openedAt.toISOString(), updatedAt: openedAt.toISOString(),
        expiresAt: new Date(openedAt.getTime() + resolvedDuration).toISOString(), status: "active"
      };
      return store.sessions[key];
    });
  }

  async function getMenuState(context) {
    if (!isCompletePlatformContext(context)) return { status: "ignored", session: null };
    const store = await readStore();
    const session = store.sessions[buildMenuKey(context.platform, context.conversationId, context.userId)];
    if (!session || session.status !== "active") return { status: "inactive", session: null };
    if (Date.parse(session.expiresAt) <= clock().getTime()) return { status: "expired", session: JSON.parse(JSON.stringify(session)) };
    return { status: "active", session: JSON.parse(JSON.stringify(session)) };
  }

  async function getActiveMenu(context) {
    const state = await getMenuState(context);
    return state.status === "active" ? state.session : null;
  }

  async function selectOption(context, option) {
    if (!isCompletePlatformContext(context)) return { status: "ignored" };
    return mutate((store) => {
      const key = buildMenuKey(context.platform, context.conversationId, context.userId);
      const session = store.sessions[key];
      if (!session || session.status !== "active" || Date.parse(session.expiresAt) <= clock().getTime()) return { status: "ignored" };
      const selected = session.options[String(option)];
      if (!selected) return { status: "invalid", session };
      session.status = "selected";
      session.selectedOption = String(option);
      session.updatedAt = clock().toISOString();
      session.closedAt = clock().toISOString();
      return { status: "selected", session, option: selected };
    });
  }

  async function beginPrompt(context, option, prompt) {
    if (!isCompletePlatformContext(context)) return null;
    return mutate((store) => {
      const key = buildMenuKey(context.platform, context.conversationId, context.userId);
      const session = store.sessions[key];
      if (!session || session.status !== "active" || Date.parse(session.expiresAt) <= clock().getTime()) return null;
      session.pendingPrompt = {
        command: String(option?.command || "").trim(),
        prompt: String(prompt || option?.prompt || "").trim()
      };
      session.updatedAt = clock().toISOString();
      session.expiresAt = expiresFor(sessionDuration(context));
      return session;
    });
  }

  function expiresFor(duration) {
    return new Date(clock().getTime() + duration).toISOString();
  }

  async function closeMenu(context, legacyConversationId, legacyUserId) {
    if (typeof context === "string") {
      context = {
        platform: context,
        conversationId: legacyConversationId,
        groupId: legacyConversationId,
        userId: legacyUserId
      };
    }
    if (!isCompletePlatformContext(context)) return false;
    return mutate((store) => {
      const session = store.sessions[buildMenuKey(context.platform, context.conversationId, context.userId)];
      if (!session) return false;
      session.status = "closed";
      session.updatedAt = clock().toISOString();
      session.closedAt = clock().toISOString();
      return true;
    });
  }

  async function touchMenu(context, duration) {
    if (!isCompletePlatformContext(context)) return null;
    return mutate((store) => {
      const session = store.sessions[buildMenuKey(context.platform, context.conversationId, context.userId)];
      if (!session || session.status !== "active" || Date.parse(session.expiresAt) <= clock().getTime()) return null;
      const updatedAt = clock();
      const resolvedDuration = duration === undefined
        ? sessionDuration(context)
        : duration;
      session.updatedAt = updatedAt.toISOString();
      session.expiresAt = new Date(updatedAt.getTime() + resolvedDuration).toISOString();
      return session;
    });
  }

  async function expireMenu(context) {
    if (!isCompletePlatformContext(context)) return false;
    return mutate((store) => {
      const session = store.sessions[buildMenuKey(context.platform, context.conversationId, context.userId)];
      if (!session || session.status !== "active") return false;
      session.status = "expired";
      session.updatedAt = clock().toISOString();
      session.expiredAt = clock().toISOString();
      return true;
    });
  }

  async function clearExpiredMenus() {
    return mutate((store) => {
      let count = 0;
      for (const session of Object.values(store.sessions)) {
        if (session.status === "active" && Date.parse(session.expiresAt) <= clock().getTime()) {
          session.status = "expired";
          session.expiredAt = clock().toISOString();
          count += 1;
        }
      }
      return count;
    });
  }

  return { openMenu, getMenuState, getActiveMenu, selectOption, beginPrompt, touchMenu, closeMenu, expireMenu, clearExpiredMenus, buildMenuKey };
}

const service = createMenuSessionService();
module.exports = { ...service, createMenuSessionService };
