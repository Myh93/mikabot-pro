"use strict";

const menuRegistry = require("../services/menuRegistry");

module.exports = {
  name: "config",
  aliases: [],
  adminOnly: true,
  async execute(client, msg, args, context = {}) {
    return menuRegistry.openMenuFromCommand("config", client, msg, context);
  }
};
