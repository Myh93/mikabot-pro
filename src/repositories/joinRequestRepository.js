"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DEFAULT_DIR = path.join(__dirname, "..", "database", "join-requests");
const queues = new Map();
const clone = value => JSON.parse(JSON.stringify(value));

function createJoinRequestRepository(options = {}) {
  const directory = path.resolve(options.directory || DEFAULT_DIR);
  const requestsPath = path.join(directory, "requests.json");
  const manifestPath = path.join(directory, "manifest.json");
  const clock = options.clock || (() => new Date());
  const nowIso = () => clock().toISOString();

  async function atomicWrite(file, document) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(temporary, file);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async function ensureInitialized() {
    await fsp.mkdir(directory, { recursive: true });
    if (!fs.existsSync(requestsPath)) {
      await atomicWrite(requestsPath, {
        schemaVersion: 1,
        nextId: 1,
        updatedAt: nowIso(),
        requests: {}
      });
    }
    if (!fs.existsSync(manifestPath)) {
      await atomicWrite(manifestPath, {
        schemaVersion: 1,
        datasetVersion: "1.0.0",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        files: ["requests.json"],
        status: "active"
      });
    }
  }

  async function loadDatabase() {
    await ensureInitialized();
    const parsed = JSON.parse(await fsp.readFile(requestsPath, "utf8"));
    if (parsed.schemaVersion !== 1 || !Number.isInteger(parsed.nextId) ||
        !parsed.requests || typeof parsed.requests !== "object") {
      throw new Error("Banco de pedidos de entrada inválido.");
    }
    return parsed;
  }

  function enqueue(operation) {
    const previous = queues.get(directory) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(directory, current);
    return current.finally(() => {
      if (queues.get(directory) === current) queues.delete(directory);
    });
  }

  async function mutate(operation) {
    return enqueue(async () => {
      const database = await loadDatabase();
      const result = await operation(database);
      database.updatedAt = nowIso();
      await atomicWrite(requestsPath, database);
      const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
      manifest.updatedAt = database.updatedAt;
      await atomicWrite(manifestPath, manifest);
      return clone(result);
    });
  }

  const activeStatuses = new Set([
    "pending_registration",
    "registration_completed",
    "revalidation_required",
    "revalidation_editing",
    "registration_cancelled",
    "registration_expired",
    "approval_failed"
  ]);

  async function upsertPending(input) {
    return mutate(database => {
      const existing = Object.values(database.requests).reverse().find(request =>
        request.groupIdentity === input.groupIdentity &&
        request.userIdentity === input.userIdentity &&
        request.status !== "unavailable"
      );
      if (existing) {
        const sameCycle = !input.cycleKey || !existing.cycleKey ||
          existing.cycleKey === input.cycleKey;
        const terminal = [
          "approved",
          "approval_failed",
          "registration_cancelled",
          "registration_expired",
          "rejected"
        ].includes(existing.status);
        if (terminal && !sameCycle) {
          return createPending(database, input);
        }
        existing.cycleKey = existing.cycleKey || input.cycleKey || null;
        existing.notificationId = input.notificationId || existing.notificationId || null;
        existing.requesterId = input.requesterId || existing.requesterId;
        existing.lastSeenAt = nowIso();
        return { request: existing, created: false, newCycle: false };
      }
      return createPending(database, input);
    });
  }

  function createPending(database, input) {
      const id = `JR${String(database.nextId++).padStart(6, "0")}`;
      const request = {
        id,
        groupIdentity: input.groupIdentity,
        userIdentity: input.userIdentity,
        identityAliases: [...new Set(input.identityAliases || [])],
        requesterId: input.requesterId,
        notificationId: input.notificationId || null,
        cycleKey: input.cycleKey || null,
        source: input.source,
        status: input.status || "pending_registration",
        createdAt: nowIso(),
        lastSeenAt: nowIso(),
        lastContactAt: null,
        registrationCompletedAt: null,
        approvedAt: null,
        flowExpiresAt: null,
        errorCode: null
      };
      database.requests[id] = request;
      return { request, created: true, newCycle: true };
  }

  async function updateRequest(id, changes) {
    return mutate(database => {
      const request = database.requests[id];
      if (!request) return null;
      Object.assign(request, clone(changes), { updatedAt: nowIso() });
      return request;
    });
  }

  async function listRequests(statuses = null) {
    const values = Object.values((await loadDatabase()).requests);
    return clone(statuses ? values.filter(item => statuses.includes(item.status)) : values);
  }

  async function findPendingByIdentity(candidates, identitiesMatch) {
    const values = (await listRequests([...activeStatuses])).reverse();
    const matched = values.filter(request =>
      [request.userIdentity, ...(request.identityAliases || [])].some(stored =>
        (candidates || []).some(candidate => identitiesMatch(stored, candidate))
      )
    );
    const latestByGroup = new Map();
    for (const request of matched) {
      if (!latestByGroup.has(request.groupIdentity)) {
        latestByGroup.set(request.groupIdentity, request);
      }
    }
    return [...latestByGroup.values()];
  }

  return {
    directory,
    loadDatabase,
    upsertPending,
    updateRequest,
    listRequests,
    findPendingByIdentity
  };
}

const repository = createJoinRequestRepository();
module.exports = { ...repository, createJoinRequestRepository };
