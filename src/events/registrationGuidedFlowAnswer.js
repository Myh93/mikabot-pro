"use strict";

const serviceDefault = require("../services/registrationGuidedFlowService");
const { logDetailedError } = require("../../utils/logger");
const { normalizeGuidedFlowContext } = require("./guidedFlowAnswer");

function createRegistrationGuidedFlowAnswer(options = {}) {
  const service = options.registrationGuidedFlowService || serviceDefault;
  async function hasActiveFlow(context) {
    const canonical = normalizeGuidedFlowContext(context);
    return canonical ? service.hasActiveFlow(canonical) : false;
  }
  async function handleRegistrationGuidedFlowAnswer({ context, text }) {
    const canonical = normalizeGuidedFlowContext(context);
    if (!canonical) return { status: "ignored" };
    try { return await service.handleAnswer(canonical, text); }
    catch (error) { logDetailedError("Erro no cadastro guiado:", error); await context.replyText("❌ Não foi possível processar o cadastro agora."); return { status: "error", error }; }
  }
  return { hasActiveFlow, handleRegistrationGuidedFlowAnswer };
}

const handler = createRegistrationGuidedFlowAnswer();
module.exports = { ...handler, createRegistrationGuidedFlowAnswer };
