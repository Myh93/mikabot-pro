"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");

const DEFAULT_FILE = path.join(__dirname, "..", "database", "feedback", "feedback.json");
const STATUSES = new Set(["NEW", "OPEN", "IN_PROGRESS", "RESOLVED", "REJECTED"]);
const queues = new Map();
const clone = value => JSON.parse(JSON.stringify(value));

function createFeedbackRepository(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_FILE);
  const clock = options.clock || (() => new Date());
  const empty = () => ({ schemaVersion: 1, nextId: 1, feedbacks: {} });

  function validate(database) {
    if (database?.schemaVersion !== 1 || !Number.isInteger(database.nextId) ||
        database.nextId < 1 || !database.feedbacks || Array.isArray(database.feedbacks)) {
      throw new Error("Banco de feedback inválido.");
    }
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
    if (!fs.existsSync(filePath)) await atomicWrite(empty());
    const database = JSON.parse(await fsp.readFile(filePath, "utf8"));
    validate(database);
    return database;
  }

  function enqueue(operation) {
    const previous = queues.get(filePath) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(filePath, current);
    return current.finally(() => { if (queues.get(filePath) === current) queues.delete(filePath); });
  }

  function mutate(operation) {
    return enqueue(async () => {
      const database = await load();
      const result = await operation(database);
      await atomicWrite(database);
      return clone(result);
    });
  }

  function nextId(database) {
    const id = `FB${String(database.nextId).padStart(6, "0")}`;
    database.nextId += 1;
    return id;
  }

  async function createFeedback(input) {
    return mutate(database => {
      const id = nextId(database);
      const createdAt = input.createdAt || clock().toISOString();
      const item = {
        id, tipo: input.tipo, status: "NEW", autor: input.autor,
        plataforma: input.plataforma, comunidade: input.comunidade || null,
        grupo: input.grupo || null, data: createdAt, descricao: input.descricao,
        resposta: null, resolvedAt: null, resolvedBy: null
      };
      database.feedbacks[id] = item;
      return item;
    });
  }

  async function getFeedback(id) {
    return clone((await load()).feedbacks[String(id || "").toUpperCase()] || null);
  }

  async function listFeedbacks(filters = {}) {
    let items = Object.values((await load()).feedbacks);
    const exact = { status: "status", tipo: "tipo", autor: "autor", grupo: "grupo" };
    for (const [filter, field] of Object.entries(exact)) {
      if (filters[filter]) items = items.filter(item => item[field] === filters[filter]);
    }
    if (filters.data) items = items.filter(item => item.data.slice(0, 10) === String(filters.data).slice(0, 10));
    if (filters.from) items = items.filter(item => Date.parse(item.data) >= Date.parse(filters.from));
    if (filters.to) items = items.filter(item => Date.parse(item.data) <= Date.parse(filters.to));
    return clone(items.sort((a, b) => a.data.localeCompare(b.data)));
  }

  async function updateFeedback(id, changes) {
    return mutate(database => {
      const item = database.feedbacks[String(id || "").toUpperCase()];
      if (!item) return null;
      if (changes.status && !STATUSES.has(changes.status)) throw new Error("Status de feedback inválido.");
      for (const field of ["tipo", "status", "descricao", "resposta", "resolvedAt", "resolvedBy"]) {
        if (Object.prototype.hasOwnProperty.call(changes, field)) item[field] = changes[field];
      }
      return item;
    });
  }

  async function anonymizeAuthor(author) {
    return mutate(database => {
      let changed = 0;
      for (const item of Object.values(database.feedbacks)) if (item.autor === author) { item.autor = "ANONYMIZED"; changed += 1; }
      return { anonymized: changed > 0, itemsRemoved: changed };
    });
  }

  return { load, createFeedback, getFeedback, listFeedbacks, updateFeedback, anonymizeAuthor };
}

const repository = createFeedbackRepository();
module.exports = { ...repository, createFeedbackRepository, STATUSES };
