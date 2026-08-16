const resolveParticipant = require("../../utils/resolveParticipant");

function extractIdentityValue(value) {
  if (!value) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return value._serialized ||
    value.id?._serialized ||
    value.number ||
    value.user ||
    value.id?.user ||
    "";
}

function normalizeUserId(value) {
  const extracted = extractIdentityValue(value).trim().toLowerCase();
  if (!extracted) return "";

  const atIndex = extracted.indexOf("@");
  const localPart = (atIndex === -1 ? extracted : extracted.slice(0, atIndex))
    .split(":")[0];
  const domain = atIndex === -1 ? "" : extracted.slice(atIndex + 1);

  if (domain === "lid") {
    const lidUser = localPart.replace(/[^0-9a-z_-]/g, "");
    return lidUser ? `${lidUser}@lid` : "";
  }

  if (!domain || domain === "c.us" || domain === "s.whatsapp.net") {
    return localPart.replace(/\D/g, "");
  }

  return `${localPart}@${domain}`;
}

function generateBrazilianNumberVariants(value) {
  const normalized = normalizeUserId(value);
  if (!/^\d+$/.test(normalized)) return normalized ? [normalized] : [];

  const variants = new Set([normalized]);
  if (/^55\d{2}9\d{8}$/.test(normalized)) {
    variants.add(normalized.slice(0, 4) + normalized.slice(5));
  } else if (/^55\d{10}$/.test(normalized)) {
    variants.add(normalized.slice(0, 4) + "9" + normalized.slice(4));
  }

  return [...variants];
}

function collectIdentityValues(identity) {
  if (!identity) return [];
  if (typeof identity !== "object" || Array.isArray(identity)) return [identity];

  const idWithServer = identity.id?.user && identity.id?.server
    ? `${identity.id.user}@${identity.id.server}`
    : identity.user && identity.server
      ? `${identity.user}@${identity.server}`
      : null;
  const values = [
    identity.id,
    identity.number,
    identity.lid,
    identity.user,
    identity._serialized,
    identity.id?._serialized,
    identity.id?.user,
    idWithServer,
    identity.contact?.id?._serialized,
    identity.contact?.id?.user,
    identity.contact?.number,
    identity.contact?.lid,
    ...(Array.isArray(identity.candidates) ? identity.candidates : [])
  ];
  return values.filter(Boolean);
}

function collectCanonicalIdentityCandidates(...identities) {
  return [...new Set(
    identities
      .flatMap(collectIdentityValues)
      .flatMap(generateBrazilianNumberVariants)
      .filter(Boolean)
  )];
}

function collectMessageAuthorIdentities(message, contact = null) {
  if (!message || typeof message !== "object") return [];
  const values = [
    message.author,
    message._data?.author,
    message._data?.participant,
    message.id?.participant,
    contact?.id?._serialized,
    contact?.id,
    contact?.lid,
    contact?.number
  ];
  return collectCanonicalIdentityCandidates(...values);
}

function collectParticipantIdentities(participant) {
  if (!participant) return [];
  return collectCanonicalIdentityCandidates(
    participant.id,
    participant._serialized,
    participant.lid,
    participant.contact?.id,
    participant.contact?.lid,
    participant
  );
}

function identitiesMatch(left, right) {
  const leftVariants = new Set(collectCanonicalIdentityCandidates(left));
  const rightVariants = new Set(collectCanonicalIdentityCandidates(right));

  if (!leftVariants.size || !rightVariants.size) return false;
  return [...leftVariants].some(value => rightVariants.has(value));
}

function maskIdentity(value) {
  const normalized = normalizeUserId(value);
  if (!normalized) return "****";
  const domain = normalized.includes("@") ? `@${normalized.split("@")[1]}` : "";
  const local = normalized.split("@")[0];
  return `${"*".repeat(Math.max(4, local.length - 4))}${local.slice(-4)}${domain}`;
}

async function resolveIdentity(msg, providedContact = null) {
  const participantId = resolveParticipant(msg);
  let contact = providedContact;

  if (!contact && typeof msg?.getContact === "function") {
    try {
      contact = await msg.getContact();
    } catch {
      contact = null;
    }
  }

  const isGroup = String(msg?.from || "").endsWith("@g.us");
  const normalizedCandidates = isGroup
    ? collectMessageAuthorIdentities(msg, contact)
    : collectCanonicalIdentityCandidates(participantId, msg?.from, contact);
  const id = normalizedCandidates[0] || normalizeUserId(participantId || msg?.from || contact);

  return {
    id,
    candidates: normalizedCandidates,
    isLid: id.endsWith("@lid"),
    maskedId: maskIdentity(id)
  };
}

function validPublicName(value) {
  const name = String(value || "").trim();
  if (!name || name.includes("${") || /@(lid|g\.us|c\.us|s\.whatsapp\.net)/i.test(name) || /^\+?\d[\d\s().-]{7,}$/.test(name)) return null;
  return name;
}

async function resolveDisplayName(identity, options = {}) {
  try {
    const registrations = options.registrationService || require("./registrationService");
    const registration = await registrations.getRegistrationByIdentity(identity);
    const nickname = validPublicName(registration?.mainAccount?.nick || registration?.nick);
    if (nickname) return nickname;
    const registeredName = validPublicName(registration?.name || registration?.nome);
    if (registeredName) return registeredName;
  } catch (_) {
    // Cadastro indisponível não impede o fallback seguro.
  }
  let contact = options.contact || null;
  if (!contact && typeof options.msg?.getContact === "function") {
    try { contact = await options.msg.getContact(); } catch (_) { contact = null; }
  }
  const whatsappName = validPublicName(options.displayName || contact?.pushname || contact?.name || contact?.shortName || contact?.verifiedName);
  return whatsappName || "Treinador";
}

module.exports = {
  normalizeUserId,
  resolveIdentity,
  identitiesMatch,
  collectCanonicalIdentityCandidates,
  collectMessageAuthorIdentities,
  collectParticipantIdentities,
  generateBrazilianNumberVariants,
  maskIdentity,
  resolveDisplayName,
  validPublicName
};
