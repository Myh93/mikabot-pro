"use strict";

const menuSessionServiceDefault = require("../services/menuSessionService");
const menuRegistryDefault = require("../services/menuRegistry");
const inputResolverDefault = require("../services/inputResolverService");
const { logDetailedError } = require("../../utils/logger");
const { isCompletePlatformContext } = require("../utils/platformContext");

function createMenuAnswerHandler(options = {}) {
  const sessionService = options.sessionService || menuSessionServiceDefault;
  const registry = options.registry || menuRegistryDefault;
  const inputResolver = options.inputResolver || inputResolverDefault;

  async function hasActiveMenu(context) {
    if (!isCompletePlatformContext(context)) return false;
    const state = await sessionService.getMenuState(context);
    if (state.status === "expired") await sessionService.expireMenu(context);
    return state.status === "active";
  }

  async function handleMenuAnswer({ context, client, msg, text, executeCommand }) {
    if (!isCompletePlatformContext(context)) return { status: "ignored" };
    try {
      const state = await sessionService.getMenuState(context);
      if (state.status === "expired") { await sessionService.expireMenu(context); return { status: "expired" }; }
      if (state.status !== "active") return { status: "ignored" };
      const active = state.session;
      if (active.pendingPrompt?.command) {
        const navigation = inputResolver.resolveMenuNavigation(text, { canGoBack: true });
        if (navigation === "close") {
          await sessionService.closeMenu(context);
          await context.replyText("✅ Menu fechado.");
          return { status: "closed" };
        }
        if (navigation === "back") {
          const role = await registry.resolveRole(client, msg, {});
          return registry.openMenu(active.menuId, context, role, { stack: active.stack, targetGroupId: active.targetGroupId });
        }
        const value = String(text || "").trim();
        if (!value) return { status: "ignored" };
        await sessionService.closeMenu(context);
        await executeCommand(`${active.pendingPrompt.command} ${value}`);
        return { status: "executed_prompt", command: active.pendingPrompt.command };
      }
      const fallbackParent = registry.parentMenuId(active.menuId);
      const canGoBack = Boolean((active.stack || []).length || fallbackParent);
      const navigation = inputResolver.resolveMenuNavigation(text, { canGoBack });
      if (navigation === "close") {
        await sessionService.closeMenu(context);
        await context.replyText("✅ Menu fechado.");
        return { status: "closed" };
      }
      if (navigation === "root") {
        const role = await registry.resolveRole(client, msg, {});
        return registry.openMenu("main", context, role);
      }
      if (navigation === "back") {
        const stack = [...(active.stack || [])];
        const previousMenuId = stack.pop() || fallbackParent || "main";
        const role = await registry.resolveRole(client, msg, {});
        return registry.openMenu(previousMenuId, context, role, { stack, targetGroupId: active.targetGroupId });
      }
      const optionEntries = Object.entries(active.options || {});
      const optionKey = inputResolver.resolveMenuOption(text, optionEntries.map(([number, option]) => ({
        value: number,
        number: Number(number),
        label: option.label,
        aliases: [...(option.aliases || []), option.command].filter(Boolean)
      })));
      if (optionKey === null) {
        if (!/^\d+$/.test(String(text || "").trim())) return { status: "ignored" };
        await context.replyText("❌ Opção inválida. Escolha uma das opções do menu.");
        return { status: "invalid", session: active };
      }
      const option = active.options[String(optionKey)];
      const destinationMenuId = !context.isGroup && option.privateMenuId ? option.privateMenuId : option.menuId;
      const targetPermission = destinationMenuId
        ? registry.getMenu(destinationMenuId)?.permission || "public"
        : option.permission || "public";
      const role = await registry.resolveRole(client, msg, {});
      if (!registry.hasPermission(role, option.permission || targetPermission)) {
        await context.replyText("❌ Você não tem permissão para acessar esta opção.");
        return { status: "denied" };
      }
      if (option.info) {
        const renewed = await sessionService.touchMenu(context);
        if (!renewed) return { status: "ignored" };
        await context.replyText(option.info);
        return { status: "informed", option, session: renewed };
      }
      if (option.prompt && option.command) {
        const prompted = await sessionService.beginPrompt(context, option, option.prompt);
        if (!prompted) return { status: "ignored" };
        await context.replyText(option.prompt);
        return { status: "prompted", option, session: prompted };
      }
      const selection = await sessionService.selectOption(context, String(optionKey));
      if (selection.status !== "selected") return selection;
      if (destinationMenuId) return registry.openMenu(destinationMenuId, context, role, { fromSession: active, targetGroupId: active.targetGroupId });
      if (option.command) {
        await executeCommand([option.command, ...(option.args || [])].join(" "));
        return { status: "executed", option };
      }
      return { status: "ignored" };
    } catch (error) {
      logDetailedError("Erro ao processar opção de menu:", error);
      return { status: "error", error };
    }
  }

  return { hasActiveMenu, handleMenuAnswer };
}

const handler = createMenuAnswerHandler();
module.exports = { ...handler, createMenuAnswerHandler };
