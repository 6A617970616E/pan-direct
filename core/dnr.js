import {
  ALL_RESOURCE_TYPES,
  RESOLVED_HOST_RULE_BASE_ID,
  RESOLVED_HOST_RULE_POOL_SIZE,
} from "./constants.js";
import { sanitizeFilename } from "./utils.js";

function hashHostnameToSlot(hostname) {
  let hash = 0;
  for (let i = 0; i < hostname.length; i++) {
    hash = (hash * 31 + hostname.charCodeAt(i)) >>> 0;
  }
  return RESOLVED_HOST_RULE_BASE_ID + (hash % RESOLVED_HOST_RULE_POOL_SIZE);
}

/**
 * Coordinates MV3 declarativeNetRequest dynamic rules across all enabled providers.
 */
export function createDnrManager(registry, storage) {
  async function syncAllDnrRules() {
    const coreConfig = await storage.getCoreConfig();
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existing.map((rule) => rule.id);

    if (coreConfig.enabled) {
      const addRules = [];
      const providers = registry.list();

      for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];
        if (typeof provider.getDnrRules !== "function") continue;
        const providerConfig = await storage.getProviderConfig(provider.id);
        const ruleIdBase = provider.dnrRuleIdBase || 1000 + i * 100;
        const rules = provider.getDnrRules(providerConfig, {
          ruleIdBase,
          resourceTypes: ALL_RESOURCE_TYPES,
        });
        if (Array.isArray(rules) && rules.length > 0) {
          addRules.push(...rules);
        }
      }

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds,
        addRules,
      });
      await chrome.action.setBadgeText({ text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    } else {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingIds,
        addRules: [],
      });
      await chrome.action.setBadgeText({ text: "OFF" });
      await chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
    }

    return coreConfig;
  }

  /**
   * Installs a priority-2 dynamic rule for the final 302-resolved CDN host,
   * injecting provider request headers and optional Content-Disposition attachment.
   */
  async function ensureResolvedHostRule({
    resolvedUrl,
    requestHeaders = [],
    filename,
    forceAttachment = false,
  }) {
    try {
      const parsed = new URL(resolvedUrl);
      const hasRequestHeaders =
        Array.isArray(requestHeaders) && requestHeaders.length > 0;
      if (!hasRequestHeaders && !forceAttachment) {
        return;
      }

      const action = { type: "modifyHeaders" };
      if (hasRequestHeaders) {
        action.requestHeaders = requestHeaders;
      }
      if (forceAttachment) {
        const safeName = sanitizeFilename(filename) || "download";
        action.responseHeaders = [
          {
            header: "content-disposition",
            operation: "set",
            value: `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
          },
        ];
      }

      const ruleId = hashHostnameToSlot(parsed.hostname.toLowerCase());
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [ruleId],
        addRules: [
          {
            id: ruleId,
            priority: 2,
            action,
            condition: {
              urlFilter: `||${parsed.hostname}/`,
              resourceTypes: ALL_RESOURCE_TYPES,
            },
          },
        ],
      });
    } catch {
      // non-fatal
    }
  }

  async function getActiveRuleCount() {
    const activeRules = await chrome.declarativeNetRequest.getDynamicRules();
    return activeRules.length;
  }

  return {
    syncAllDnrRules,
    ensureResolvedHostRule,
    getActiveRuleCount,
  };
}
