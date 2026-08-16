"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_PATH = path.join(__dirname, "..", "database", "discipline", "state.json");
const clone = value => JSON.parse(JSON.stringify(value));
const emptyDatabase = () => ({
  schemaVersion: 1,
  updatedAt: null,
  nextBanId: 1,
  members: {}
});

function createDisciplineRepository(options = {}) {
  const filePath = options.filePath || DEFAULT_PATH;
  let writeQueue = Promise.resolve();

  async function ensureDatabase() {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    try { await fs.promises.access(filePath); }
    catch (_) { await atomicWrite(emptyDatabase()); }
  }

  function validateDatabase(database) {
    const errors = [];
    if (!database || typeof database !== "object" || Array.isArray(database)) errors.push("database_invalid");
    if (database?.schemaVersion !== 1) errors.push("schema_version_invalid");
    if (!Number.isInteger(database?.nextBanId) || database.nextBanId < 1) errors.push("next_ban_id_invalid");
    if (!database?.members || typeof database.members !== "object" || Array.isArray(database.members)) errors.push("members_invalid");
    return { valid: errors.length === 0, errors };
  }

  async function atomicWrite(database) {
    const result = validateDatabase(database);
    if (!result.valid) throw Object.assign(new Error("Banco disciplinar inválido."), { code: result.errors[0] });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await fs.promises.open(temporary, "w");
    try {
      await handle.writeFile(`${JSON.stringify(database, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally { await handle.close(); }
    try { await fs.promises.rename(temporary, filePath); }
    catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function loadDatabase() {
    await ensureDatabase();
    const database = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
    const result = validateDatabase(database);
    if (!result.valid) throw Object.assign(new Error("Banco disciplinar inválido."), { code: result.errors[0] });
    return clone(database);
  }

  function mutate(mutator) {
    const operation = writeQueue.then(async () => {
      const database = await loadDatabase();
      const result = await mutator(database);
      database.updatedAt = new Date().toISOString();
      await atomicWrite(database);
      return clone(result);
    });
    writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async function findMemberByAliases(aliases) {
    const database = await loadDatabase();
    const wanted = new Set((aliases || []).filter(Boolean));
    return clone(Object.values(database.members).find(member =>
      (member.identityAliases || []).some(alias => wanted.has(alias))
    ) || null);
  }

  function saveMember(member) {
    return mutate(database => {
      database.members[member.memberKey] = clone(member);
      return database.members[member.memberKey];
    });
  }

  function addBan(memberKey, memberSeed, banSeed) {
    return mutate(database => {
      const member = database.members[memberKey] || clone(memberSeed);
      const banId = `DBAN${String(database.nextBanId++).padStart(6, "0")}`;
      const sequenceNumber = (member.bans || []).length + 1;
      const ban = { ...clone(banSeed), banId, number: sequenceNumber };
      member.bans = [...(member.bans || []), ban];
      database.members[memberKey] = member;
      return { member, ban };
    });
  }

  const getMember = async memberKey => clone((await loadDatabase()).members[memberKey] || null);

  return { filePath, loadDatabase, validateDatabase, saveMember, addBan, findMemberByAliases, getMember };
}

const repository = createDisciplineRepository();
module.exports = { ...repository, createDisciplineRepository };
