"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "database", "groups", "directory.json");
const queues = new Map();
const clone = (value) => JSON.parse(JSON.stringify(value));
const GENERIC_NAME = "Grupo cadastrado";
const isGenericName = (value) => !String(value || "").trim() || String(value).trim() === GENERIC_NAME;
function formatGroupDisplayName(group) {
  const name = String(group?.name || GENERIC_NAME).trim() || GENERIC_NAME;
  if (name !== GENERIC_NAME) return name;
  const localId = String(group?.groupId || group?.id || "").split("@")[0].replace(/[^0-9a-z]/gi, "");
  return `${GENERIC_NAME} • final ${localId.slice(-4).padStart(4, "•")}`;
}

function createGroupDirectoryService(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_FILE);
  const clock = options.clock || (() => new Date());
  const renameFile = options.renameFile || ((source, target) => fsp.rename(source, target));
  const wait = options.wait || ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));

  async function renameWithTransientRetry(temporary) {
    const delays = [50, 100, 200, 400];
    let originalError;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await renameFile(temporary, filePath);
        return;
      } catch (error) {
        originalError ||= error;
        if (!["EPERM", "EBUSY"].includes(error?.code) || attempt === 4) {
          throw originalError;
        }
        await wait(delays[attempt]);
      }
    }
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
      await renameWithTransientRetry(temporary);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async function ensureFile() {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) await atomicWrite({ schemaVersion: 1, updatedAt: clock().toISOString(), groups: [] });
  }

  async function load() {
    await ensureFile();
    let database;
    try { database = JSON.parse(await fsp.readFile(filePath, "utf8")); }
    catch (error) { throw new Error(`Diretório de grupos inválido: ${error.message}`); }
    if (database.schemaVersion !== 1 || !Array.isArray(database.groups)) throw new Error("Schema do diretório de grupos inválido.");
    return database;
  }

  async function mutate(operation) {
    return enqueue(async () => {
      const database = await load();
      const result = await operation(database);
      database.updatedAt = clock().toISOString();
      await atomicWrite(database);
      return clone(result);
    });
  }

  async function upsertGroup(input) {
    const groupId = String(input?.groupId || "");
    if (!groupId.endsWith("@g.us")) throw new Error("groupId inválido para o diretório.");
    return mutate((database) => {
      let group = database.groups.find((item) => item.platform === (input.platform || "whatsapp") && item.groupId === groupId);
      const knownName = !isGenericName(group?.name) ? String(group.name).trim() : null;
      const incomingName = !isGenericName(input.name) ? String(input.name).trim() : null;
      const manualExisting = group?.nameSource === "manual";
      const incomingManual = input.nameSource === "manual";
      const name = manualExisting && !incomingManual ? knownName : incomingName || knownName || GENERIC_NAME;
      const nameSource = incomingManual ? "manual" : manualExisting ? "manual" : incomingName ? (input.nameSource || "automatic") : (group?.nameSource || "fallback");
      const values = { platform: input.platform || "whatsapp", groupId, name, nameSource, lastSeenAt: clock().toISOString(), source: input.source || group?.source || "message", active: input.active !== false };
      if (group) Object.assign(group, values); else { group = values; database.groups.push(group); }
      return group;
    });
  }

  async function getGroup(platform, groupId) {
    const database = await load();
    return clone(database.groups.find((item) => item.platform === platform && item.groupId === groupId) || null);
  }

  async function listActiveGroups(platform = "whatsapp") {
    const database = await load();
    return clone(database.groups.filter((item) => item.platform === platform && item.active).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")));
  }

  async function registerSeenGroup(msg) {
    const groupId = typeof msg?.from === "string" ? msg.from : "";
    if (!groupId.endsWith("@g.us")) return null;
    const existing = await getGroup("whatsapp", groupId);
    const group = await upsertGroup({ platform: "whatsapp", groupId, name: existing?.name || GENERIC_NAME, nameSource: existing?.nameSource, source: "message", active: true });
    return group;
  }

  const registerFromMessage = registerSeenGroup;
  const getGroups = (platform = "whatsapp") => listActiveGroups(platform);
  const getGroupById = (groupId, platform = "whatsapp") => getGroup(platform, groupId);
  async function synchronizeGroups() { return { disabled: true, updated: 0, unchanged: (await listActiveGroups("whatsapp")).length, failures: 0 }; }

  async function setManualName(groupId, name) {
    const friendlyName = String(name || "").trim();
    if (!friendlyName) throw new Error("O nome amigável não pode ficar vazio.");
    return upsertGroup({ platform: "whatsapp", groupId, name: friendlyName, nameSource: "manual", source: "message", active: true });
  }

  async function setManualNameByPosition(position, name) {
    const groups = await listActiveGroups("whatsapp");
    const index = Number(position) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= groups.length) return null;
    return setManualName(groups[index].groupId, name);
  }

  return { upsertGroup, getGroup, getGroups, getGroupById, listActiveGroups, registerSeenGroup, registerFromMessage, synchronizeGroups, setManualName, setManualNameByPosition, formatGroupDisplayName };
}

const service = createGroupDirectoryService();
module.exports = { ...service, createGroupDirectoryService, formatGroupDisplayName };
