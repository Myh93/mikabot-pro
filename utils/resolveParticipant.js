/**
 * Identifica o ID real do usuário que interagiu
 * @param {object} msg - Objeto da mensagem do baileys/wppwebjs
 * @returns {string} ID formatado (ex: 55119... @c.us)
 */
module.exports = function resolveParticipant(msg) {
  if (!msg) return null;

  // 1. Se for o bot mandando mensagem para ele mesmo
  if (msg.fromMe) return msg.to;

  // 2. Se for em grupo, o autor é quem mandou
  if (msg.author) return msg.author;

  // 3. Se for privado, o 'from' é o próprio usuário
  return msg.from;
};