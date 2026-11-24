import { DEFAULT_CORE_CONFIG } from "./constants.js";

const LEGACY_BAIDU_KEYS = [
  "appKey",
  "accessToken",
  "tokenExpiresAt",
  "userAgent",
];

/**
 * Unified storage manager for core settings and per-provider configurations.
 * Seamlessly migrates legacy v0.3.0 flat Baidu keys into `providerConfigs.baidu`.
 */
export function createStorageManager(registry) {
  async function getCoreConfig() {
    const stored = await chrome.storage.local.get(DEFAULT_CORE_CONFIG);
    return {
      enabled: Boolean(stored.enabled),
      downloadMode: stored.downloadMode === "aria2" ? "aria2" : "browser",
      aria2Url:
        (stored.aria2Url || DEFAULT_CORE_CONFIG.aria2Url).trim() ||
        DEFAULT_CORE_CONFIG.aria2Url,
      aria2Secret: (stored.aria2Secret || "").trim(),
    };
  }

  async function setCoreConfig(partial) {
    const current = await getCoreConfig();
    const next = {
      enabled:
        typeof partial.enabled === "boolean" ? partial.enabled : current.enabled,
      downloadMode:
        partial.downloadMode === "aria2" || partial.downloadMode === "browser"
          ? partial.downloadMode
          : current.downloadMode,
      aria2Url:
        typeof partial.aria2Url === "string" && partial.aria2Url.trim()
          ? partial.aria2Url.trim()
          : current.aria2Url,
      aria2Secret:
        typeof partial.aria2Secret === "string"
          ? partial.aria2Secret.trim()
          : current.aria2Secret,
    };

    await chrome.storage.local.set(next);
    return next;
  }

  async function readProviderConfigsMap() {
    const stored = await chrome.storage.local.get([
      "providerConfigs",
      ...LEGACY_BAIDU_KEYS,
    ]);
    const map =
      stored.providerConfigs && typeof stored.providerConfigs === "object"
        ? { ...stored.providerConfigs }
        : {};

    // Backward-compatible migration from v0.3.0 flat storage keys
    const hasLegacyBaidu = LEGACY_BAIDU_KEYS.some(
      (k) => stored[k] !== undefined && stored[k] !== "" && stored[k] !== 0
    );
    if (!map.baidu && hasLegacyBaidu) {
      map.baidu = {
        appKey: stored.appKey || "",
        accessToken: stored.accessToken || "",
        tokenExpiresAt: Number(stored.tokenExpiresAt) || 0,
        userAgent: stored.userAgent || "pan.baidu.com",
      };
      await chrome.storage.local.set({ providerConfigs: map });
    }

    return map;
  }

  async function getProviderConfig(providerId) {
    const provider = registry.get(providerId);
    const map = await readProviderConfigsMap();
    const raw = {
      ...(provider.defaultConfig || {}),
      ...(map[provider.id] || {}),
    };
    return provider.normalizeConfig ? provider.normalizeConfig(raw) : raw;
  }

  async function setProviderConfig(providerId, partial) {
    const provider = registry.get(providerId);
    const map = await readProviderConfigsMap();
    const current = await getProviderConfig(provider.id);
    const merged = { ...current, ...partial };
    const normalized = provider.normalizeConfig
      ? provider.normalizeConfig(merged)
      : merged;

    map[provider.id] = normalized;
    const payload = { providerConfigs: map };

    // Keep legacy top-level keys in sync for Baidu so downgrades remain safe
    if (provider.id === "baidu") {
      payload.appKey = normalized.appKey;
      payload.accessToken = normalized.accessToken;
      payload.tokenExpiresAt = normalized.tokenExpiresAt;
      payload.userAgent = normalized.userAgent;
    }

    await chrome.storage.local.set(payload);
    return normalized;
  }

  async function getAllProviderConfigs() {
    const result = {};
    for (const provider of registry.list()) {
      result[provider.id] = await getProviderConfig(provider.id);
    }
    return result;
  }

  return {
    getCoreConfig,
    setCoreConfig,
    getProviderConfig,
    setProviderConfig,
    getAllProviderConfigs,
  };
}
