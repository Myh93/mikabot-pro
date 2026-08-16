"use strict";

const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "database", "member-lifecycle", "state.json");
const writeQueues = new Map();
const clone = value => JSON.parse(JSON.stringify(value));

function createMemberLifecycleRepository(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_FILE);
  const clock = options.clock || (() => new Date());
  const initialState = () => ({
    schemaVersion: 1,
    updatedAt: clock().toISOString(),
    policy: { mode: "delayed", graceDays: 7 },
    members: {},
    audit: []
  });

  async function atomicWrite(document) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
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

  async function loadState() {
    if (!fs.existsSync(filePath)) await atomicWrite(initialState());
    const state = JSON.parse(await fsp.readFile(filePath, "utf8"));
    if (state.schemaVersion !== 1 || !state.policy || !state.members) {
      throw new Error("Estado de ciclo de vida de membros inválido.");
    }
    state.audit ||= [];
    return state;
  }

  function mutate(operation) {
    const previous = writeQueues.get(filePath) || Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const state = await loadState();
      const result = await operation(state);
      state.updatedAt = clock().toISOString();
      await atomicWrite(state);
      return clone(result);
    });
    writeQueues.set(filePath, current);
    return current.finally(() => {
      if (writeQueues.get(filePath) === current) writeQueues.delete(filePath);
    });
  }

  async function getPolicy() {
    return clone((await loadState()).policy);
  }

  async function setPolicy(policy) {
    const mode = ["never", "immediate", "delayed"].includes(policy?.mode)
      ? policy.mode
      : null;
    const graceDays = Number.isInteger(policy?.graceDays) && policy.graceDays >= 0
      ? policy.graceDays
      : 7;
    if (!mode) throw new Error("Política de cadastro inválida.");
    return mutate(state => {
      state.policy = { mode, graceDays };
      return state.policy;
    });
  }

  async function updateMember(memberId, operation) {
    return mutate(state => {
      const member = state.members[memberId] || {
        memberId,
        platforms: {
          whatsapp: { active: false, groups: {} },
          telegram: { active: false, groups: {} }
        },
        pendingRemovalAt: null,
        updatedAt: clock().toISOString()
      };
      operation(member);
      member.platforms.whatsapp.active = Object.values(member.platforms.whatsapp.groups).some(Boolean);
      member.platforms.telegram.active = Object.values(member.platforms.telegram.groups).some(Boolean);
      member.updatedAt = clock().toISOString();
      state.members[memberId] = member;
      return member;
    });
  }

  const getMember = async memberId => clone((await loadState()).members[memberId] || null);
  const listMembers = async () => clone(Object.values((await loadState()).members));

  async function addAudit(entry) {
    return mutate(state => {
      const stored = { ...clone(entry), timestamp: entry.timestamp || clock().toISOString() };
      state.audit.push(stored);
      return stored;
    });
  }

  const listAudit = async () => clone((await loadState()).audit || []);

  return { filePath, loadState, getPolicy, setPolicy, updateMember, getMember, listMembers, addAudit, listAudit };
}

const repository = createMemberLifecycleRepository();
module.exports = { ...repository, createMemberLifecycleRepository };
