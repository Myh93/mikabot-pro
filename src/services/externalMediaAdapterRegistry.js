"use strict";

const REQUIRED_METHODS = ["searchMedia", "downloadMedia", "validateResult", "normalizeMetadata"];
const registries = new Map();

function validateAdapter(adapter) {
  if (!adapter || typeof adapter.sourceId !== "string" || !/^[a-z0-9_-]+$/.test(adapter.sourceId)) throw new Error("sourceId de adaptador inválido.");
  for (const method of REQUIRED_METHODS) if (typeof adapter[method] !== "function") throw new Error(`Adaptador sem ${method}().`);
  if (!Array.isArray(adapter.supportedTypes) || !adapter.supportedTypes.length || !Array.isArray(adapter.supportedCategories) || !adapter.supportedCategories.length) throw new Error("Tipos e categorias do adaptador são obrigatórios.");
  if (!Array.isArray(adapter.allowedDomains) || !adapter.allowedDomains.length) throw new Error("Domínios autorizados são obrigatórios.");
  if (!adapter.licensePolicy || !Number.isFinite(Number(adapter.rateLimit)) || !Number.isFinite(Number(adapter.timeoutMs)) || !Number.isFinite(Number(adapter.maxSize))) throw new Error("Política e limites do adaptador são obrigatórios.");
  return true;
}

function createExternalMediaAdapterRegistry() {
  const adapters = new Map();
  function register(adapter) { validateAdapter(adapter); if (adapters.has(adapter.sourceId)) throw new Error("Adaptador já registrado."); adapters.set(adapter.sourceId, Object.freeze({ ...adapter })); return adapter.sourceId; }
  const get = sourceId => adapters.get(sourceId) || null;
  const list = () => [...adapters.values()];
  const remove = sourceId => adapters.delete(sourceId);
  return { register, get, list, remove };
}

const registry = createExternalMediaAdapterRegistry();
module.exports = { ...registry, createExternalMediaAdapterRegistry, validateAdapter, REQUIRED_METHODS };
