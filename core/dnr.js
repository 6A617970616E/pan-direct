import {
  ALL_RESOURCE_TYPES,
  RESOLVED_HOST_RULE_BASE_ID,
  RESOLVED_HOST_RULE_POOL_SIZE,
  RESOLVED_HOST_RULE_TTL_MS,
} from "./constants.js";
import { sanitizeFilename } from "./utils.js";

function normalizeUrlWithoutHash(rawUrl) {
  const parsed = new URL(rawUrl);
  return `${parsed.origin}${parsed.pathname}${parsed.search}`;
}

export function buildResolvedUrlFilter(rawUrl) {
  const parsed = new URL(rawUrl);
  const exact = `${parsed.origin}${parsed.pathname}${parsed.search}`;
  if (exact.length <= 1500 && !/[*^|]/.test(exact)) {
    return `|${exact}|`;
  }
  const cleanPath = (parsed.pathname || "/").split(/[*^|]/)[0] || "/";
  return `||${parsed.hostname}${cleanPath}`;
}

/**
 * Coordinates MV3 declarativeNetRequest rules across all enabled providers:
 * - Provider base rules live in dynamic rules (IDs < RESOLVED_HOST_RULE_BASE_ID)
 * - Per-download 302-resolved URL rules live in ephemeral session rules
 *   (IDs >= RESOLVED_HOST_RULE_BASE_ID), scoped to exact URLs without main_frame,
 *   and automatically cleaned up on download completion, disable, or TTL expiry.
 */
export function createDnrManager(registry, storage) {
  let nextSlotOffset = 0;
  const trackedEphemeralRules = new Map();

  function hasSessionRulesApi() {
    return (
      typeof chrome !== "undefined" &&
      typeof chrome.declarativeNetRequest?.getSessionRules === "function" &&
      typeof chrome.declarativeNetRequest?.updateSessionRules === "function"
    );
  }

  async function getEphemeralRules() {
    if (hasSessionRulesApi()) {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      return (rules || []).filter((r) => r.id >= RESOLVED_HOST_RULE_BASE_ID);
    }
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    return (rules || []).filter((r) => r.id >= RESOLVED_HOST_RULE_BASE_ID);
  }

  async function updateEphemeralRules({ removeRuleIds = [], addRules = [] }) {
    if (hasSessionRulesApi()) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds,
        addRules,
      });
      return;
    }
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules,
    });
  }

  function clearTrackedEntry(ruleId) {
    const entry = trackedEphemeralRules.get(ruleId);
    if (entry?.timer && typeof clearTimeout === "function") {
      clearTimeout(entry.timer);
    }
    trackedEphemeralRules.delete(ruleId);
  }

  async function removeResolvedRuleIds(ruleIds) {
    const uniqueIds = Array.from(
      new Set((ruleIds || []).filter((id) => Number.isInteger(id)))
    );
    if (uniqueIds.length === 0) return;
    for (const id of uniqueIds) {
      clearTrackedEntry(id);
    }
    try {
      await updateEphemeralRules({ removeRuleIds: uniqueIds, addRules: [] });
    } catch {
      // non-fatal
    }
  }

  async function clearAllEphemeralRules() {
    for (const id of Array.from(trackedEphemeralRules.keys())) {
      clearTrackedEntry(id);
    }
    try {
      const existing = await getEphemeralRules();
      const ids = existing.map((r) => r.id);
      if (ids.length > 0) {
        await updateEphemeralRules({ removeRuleIds: ids, addRules: [] });
      }
    } catch {
      // non-fatal
    }
  }

  async function syncAllDnrRules() {
    const coreConfig = await storage.getCoreConfig();
    const existingDynamic = await chrome.declarativeNetRequest.getDynamicRules();
    const useSessionRules = hasSessionRulesApi();
    // Preserve ephemeral rules if falling back to dynamic storage; wipe legacy >= 9001 dynamic rules once session rules are active
    const existingBaseIds = existingDynamic
      .filter(
        (rule) =>
          !coreConfig.enabled ||
          useSessionRules ||
          rule.id < RESOLVED_HOST_RULE_BASE_ID
      )
      .map((rule) => rule.id);

    if (coreConfig.enabled) {
      const addRules = [];
      const providers = registry.list();
      const extensionId =
        typeof chrome !== "undefined" && chrome.runtime?.id
          ? chrome.runtime.id
          : "";

      for (let i = 0; i < providers.length; i++) {
        const provider = providers[i];
        if (typeof provider.getDnrRules !== "function") continue;
        const providerConfig = await storage.getProviderConfig(provider.id);
        const ruleIdBase = provider.dnrRuleIdBase || 1000 + i * 100;
        const rules = provider.getDnrRules(providerConfig, {
          ruleIdBase,
          resourceTypes: ALL_RESOURCE_TYPES,
          extensionId,
        });
        if (Array.isArray(rules) && rules.length > 0) {
          addRules.push(...rules);
        }
      }

      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingBaseIds,
        addRules,
      });
      await chrome.action.setBadgeText({ text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    } else {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existingBaseIds,
        addRules: [],
      });
      await clearAllEphemeralRules();
      await chrome.action.setBadgeText({ text: "OFF" });
      await chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
    }

    return coreConfig;
  }

  /**
   * Installs an ephemeral priority-2 session rule scoped to the exact 302-resolved
   * download URL (never matching main_frame), avoiding multi-file filename collisions
   * and persisting no rules across browser restarts.
   */
  async function ensureResolvedHostRule({
    resolvedUrl,
    requestHeaders = [],
    filename,
    forceAttachment = false,
    preferFrameDownload = false,
    initiatorDomains = [],
    ttlMs = RESOLVED_HOST_RULE_TTL_MS,
  }) {
    try {
      const normalizedUrl = normalizeUrlWithoutHash(resolvedUrl);
      const urlFilter = buildResolvedUrlFilter(resolvedUrl);
      const hasRequestHeaders =
        Array.isArray(requestHeaders) && requestHeaders.length > 0;
      if (!hasRequestHeaders && !forceAttachment) {
        return null;
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

      const now = Date.now();
      const removeIds = [];
      for (const [id, entry] of trackedEphemeralRules.entries()) {
        if (entry.expiresAt <= now) {
          clearTrackedEntry(id);
          removeIds.push(id);
        }
      }

      const ruleId =
        RESOLVED_HOST_RULE_BASE_ID +
        (nextSlotOffset++ % RESOLVED_HOST_RULE_POOL_SIZE);
      clearTrackedEntry(ruleId);
      removeIds.push(ruleId);

      const condition = {
        urlFilter,
        resourceTypes: preferFrameDownload
          ? ["sub_frame"]
          : ["other", "sub_frame", "xmlhttprequest"],
      };
      const cleanInitiators = Array.isArray(initiatorDomains)
        ? initiatorDomains.filter((d) => typeof d === "string" && d.trim())
        : [];
      if (preferFrameDownload && cleanInitiators.length > 0) {
        condition.initiatorDomains = cleanInitiators;
      }

      await updateEphemeralRules({
        removeRuleIds: Array.from(new Set(removeIds)),
        addRules: [
          {
            id: ruleId,
            priority: 2,
            action,
            condition,
          },
        ],
      });

      const effectiveTtl =
        typeof ttlMs === "number" && ttlMs > 0
          ? ttlMs
          : RESOLVED_HOST_RULE_TTL_MS;
      const timer = setTimeout(() => {
        removeResolvedRuleIds([ruleId]);
      }, effectiveTtl);
      timer?.unref?.();

      trackedEphemeralRules.set(ruleId, {
        ruleId,
        url: normalizedUrl,
        urlFilter,
        createdAt: now,
        expiresAt: now + effectiveTtl,
        timer,
      });

      return { ruleId, urlFilter };
    } catch {
      return null;
    }
  }

  async function removeResolvedRuleById(ruleId) {
    if (!Number.isInteger(ruleId)) return;
    await removeResolvedRuleIds([ruleId]);
  }

  /**
   * Removes any ephemeral per-download session rules associated with a completed
   * or interrupted download URL (works even after MV3 Service Worker restarts).
   */
  async function cleanupResolvedRulesForUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== "string") return;
    let normalizedUrl = "";
    let expectedFilter = "";
    try {
      normalizedUrl = normalizeUrlWithoutHash(rawUrl);
      expectedFilter = buildResolvedUrlFilter(rawUrl);
    } catch {
      return;
    }

    const idsToRemove = [];
    for (const [id, entry] of trackedEphemeralRules.entries()) {
      if (entry.url === normalizedUrl || entry.urlFilter === expectedFilter) {
        idsToRemove.push(id);
      }
    }

    try {
      const existing = await getEphemeralRules();
      for (const rule of existing) {
        if (rule.condition?.urlFilter === expectedFilter) {
          idsToRemove.push(rule.id);
        }
      }
    } catch {
      // non-fatal
    }

    if (idsToRemove.length > 0) {
      await removeResolvedRuleIds(idsToRemove);
    }
  }

  async function getActiveRuleCount() {
    const activeDynamic = await chrome.declarativeNetRequest.getDynamicRules();
    if (!hasSessionRulesApi()) {
      return activeDynamic.length;
    }
    const activeSession = await getEphemeralRules();
    return activeDynamic.length + activeSession.length;
  }

  return {
    syncAllDnrRules,
    ensureResolvedHostRule,
    removeResolvedRuleById,
    cleanupResolvedRulesForUrl,
    clearAllEphemeralRules,
    getActiveRuleCount,
  };
}
