"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");

const DEFAULT_FILE = process.env.NODE_TEST_CONTEXT
  ? path.join(os.tmpdir(), `mikabot-member-experience-${process.pid}.json`)
  : path.join(__dirname, "..", "database", "member-experience", "state.json");
const queues = new Map();
const clone = value => JSON.parse(JSON.stringify(value));

function createMemberExperienceRepository(options = {}) {
  const filePath = path.resolve(options.filePath || DEFAULT_FILE);
  const clock = options.clock || (() => new Date());
  const initial = () => ({ schemaVersion: 1, updatedAt: clock().toISOString(), groups: {}, members: {}, grants: {}, temporaryMessages: {} });

  async function atomicWrite(document) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let handle;
    try {
      handle = await fsp.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync(); await handle.close(); handle = null;
      await fsp.rename(temporary, filePath);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async function load() {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) await atomicWrite(initial());
    const state = JSON.parse(await fsp.readFile(filePath, "utf8"));
    if (state.schemaVersion !== 1 || !state.groups || !state.members || !state.grants || !state.temporaryMessages) throw new Error("Banco de experiência do membro inválido.");
    return state;
  }

  function mutate(operation) {
    const previous = queues.get(filePath) || Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const state = await load();
      const result = await operation(state);
      state.updatedAt = clock().toISOString();
      await atomicWrite(state);
      return clone(result);
    });
    queues.set(filePath, current);
    return current.finally(() => { if (queues.get(filePath) === current) queues.delete(filePath); });
  }

  const defaults = () => ({
    returnRevalidationDays: 7,
    welcome: { enabled: true, textEnabled: true, imageEnabled: false, stickerEnabled: false, imagePath: null, stickerPath: null, mention: true, deleteAfterMs: 0, firstText: null, returnText: null },
    farewell: { enabled: true, textEnabled: true, imageEnabled: false, stickerEnabled: false, imagePath: null, stickerPath: null, mention: true, deleteAfterMs: 0, leaveText: null, removedText: null },
    ban: { enabled: true, mediaEnabled: true, textEnabled: true, mention: true, showReason: true, showDuration: true, deleteAfterMs: 0, text: null }
  });
  async function getGroupConfig(groupId) { return { ...defaults(), ...clone((await load()).groups[groupId] || {}) }; }
  async function updateGroupConfig(groupId, changes) { return mutate(state => { const current = { ...defaults(), ...(state.groups[groupId] || {}) }; state.groups[groupId] = { ...current, ...clone(changes), welcome: { ...current.welcome, ...(changes.welcome || {}) }, farewell: { ...current.farewell, ...(changes.farewell || {}) }, ban: { ...current.ban, ...(changes.ban || {}) } }; return state.groups[groupId]; }); }
  async function getMember(memberId) { return clone((await load()).members[memberId] || null); }
  async function updateMember(memberId, operation) { return mutate(state => { const item = state.members[memberId] || { memberId, joinCount: 0, lastReminderAt: null, lastReminderAttemptAt: null, reminderCount: 0, reminderDisabled: false, registeredAt: null, missions: {} }; operation(item); item.updatedAt = clock().toISOString(); state.members[memberId] = item; return item; }); }
  async function claimGrant(memberId, key, details = {}) { return mutate(state => { const id = `${memberId}:${key}`; if (state.grants[id]) return { granted: false, grant: state.grants[id] }; const grant = { memberId, key, createdAt: clock().toISOString(), status: "pending", ...clone(details) }; state.grants[id] = grant; return { granted: true, grant }; }); }
  async function completeGrant(memberId, key, details = {}) { return mutate(state => { const id = `${memberId}:${key}`; const grant = state.grants[id] || { memberId, key, createdAt: clock().toISOString() }; Object.assign(grant, clone(details), { status: "completed", completedAt: clock().toISOString() }); state.grants[id] = grant; const member = state.members[memberId] || { memberId, joinCount: 0, reminderCount: 0, reminderDisabled: false, missions: {} }; member.missions ||= {}; member.missions[key] = true; member.updatedAt = clock().toISOString(); state.members[memberId] = member; return grant; }); }
  async function abandonGrant(memberId, key) { return mutate(state => { const id = `${memberId}:${key}`; if (state.grants[id]?.status === "pending") delete state.grants[id]; return true; }); }
  async function listCompletedGrants(memberId) { return clone(Object.values((await load()).grants).filter(item => item.memberId === memberId && item.status === "completed")); }
  async function clearRegistrationState(memberId) { return mutate(state => { const item = state.members[memberId]; if (!item) return { removed: false, itemsRemoved: 0 }; item.registeredAt = null; item.reminderDisabled = false; item.updatedAt = clock().toISOString(); return { removed: true, itemsRemoved: 1 }; }); }
  async function removeMemberData(memberId) { return mutate(state => { let removed = 0; if (Object.prototype.hasOwnProperty.call(state.members, memberId)) { delete state.members[memberId]; removed += 1; } for (const [id, grant] of Object.entries(state.grants)) if (grant.memberId === memberId) { delete state.grants[id]; removed += 1; } return { removed: removed > 0, itemsRemoved: removed }; }); }
  async function saveTemporaryMessage(record) { return mutate(state => { state.temporaryMessages[record.key] = clone(record); return record; }); }
  async function removeTemporaryMessage(key) { return mutate(state => Boolean(delete state.temporaryMessages[key])); }
  async function listTemporaryMessages() { return clone(Object.values((await load()).temporaryMessages)); }

  return { filePath, load, getGroupConfig, updateGroupConfig, getMember, updateMember, claimGrant, completeGrant, abandonGrant, listCompletedGrants, clearRegistrationState, removeMemberData, saveTemporaryMessage, removeTemporaryMessage, listTemporaryMessages };
}

const repository = createMemberExperienceRepository();
module.exports = { ...repository, createMemberExperienceRepository };
