import { DEFAULT_PROVIDER_ID } from "./constants.js";

/**
 * Registry of enabled netdisk providers for the current build edition.
 */
export function createProviderRegistry(providers = []) {
  const byId = new Map();
  const ordered = [];

  for (const provider of providers) {
    if (!provider || typeof provider.id !== "string" || !provider.id.trim()) {
      throw new Error("Invalid provider: missing non-empty id");
    }
    if (byId.has(provider.id)) {
      throw new Error(`Duplicate provider id: ${provider.id}`);
    }
    byId.set(provider.id, provider);
    ordered.push(provider);
  }

  function getDefault() {
    if (byId.has(DEFAULT_PROVIDER_ID)) {
      return byId.get(DEFAULT_PROVIDER_ID);
    }
    if (ordered.length > 0) {
      return ordered[0];
    }
    throw new Error("当前版本未启用任何网盘适配器。");
  }

  function get(providerId) {
    if (!providerId) return getDefault();
    const provider = byId.get(providerId);
    if (!provider) {
      throw new Error(`未找到网盘适配器：${providerId}`);
    }
    return provider;
  }

  function has(providerId) {
    return byId.has(providerId);
  }

  function list() {
    return [...ordered];
  }

  function findByDownloadUrl(rawUrl) {
    for (const provider of ordered) {
      if (
        typeof provider.isAllowedDownloadUrl === "function" &&
        provider.isAllowedDownloadUrl(rawUrl)
      ) {
        return provider;
      }
    }
    return null;
  }

  return {
    get,
    getDefault,
    has,
    list,
    findByDownloadUrl,
  };
}
