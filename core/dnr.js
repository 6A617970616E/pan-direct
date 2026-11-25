import {
  ALL_RESOURCE_TYPES,
  RESOLVED_HOST_RULE_BASE_ID,
  RESOLVED_HOST_RULE_POOL_SIZE,
  RESOLVED_HOST_RULE_TTL_MS,
} from "./constants.js";
import { sanitizeFilename } from "./utils.js";

const EPHEMERAL_RULE_META_KEY = "pandirectEphemeralRuleMeta";

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
 *   allocated from free IDs queried via getSessionRules() (safe across SW restarts
 *   and large multi-file selections), and cleaned up on download completion, disable,
 *   or TTL expiry.
 */
export function createDnrManager(registry, storage) {
  const trackedEphemeralRules = new Map();
  let ephemeralOpChain = Promise.resolve();

  function enqueueEphemeralOp(task) {
    const next = ephemeralOpChain.then(task, task);
    ephemeralOpChain = next.catch(() => {});
    return next;
  }

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

  async function readPersistedMeta() {
    if (typeof chrome === "undefined" || !chrome.storage?.session?.get) {
      return {};
    }
    try {
      const stored = await chrome.storage.session.get(EPHEMERAL_RULE_META_KEY);
      const raw = stored?.[EPHEMERAL_RULE_META_KEY];
      return raw && typeof raw === "object" ? { ...raw } : {};
    } catch {
      return {};
    }
  }

  async function writePersistedMeta(meta) {
    if (typeof chrome === "undefined" || !chrome.storage?.session?.set) {
      return;
    }
    try {
      const keys = Object.keys(meta || {});
      if (keys.length === 0 && typeof chrome.storage.session.remove === "function") {
        await chrome.storage.session.remove(EPHEMERAL_RULE_META_KEY);
      } else {
        await chrome.storage.session.set({ [EPHEMERAL_RULE_META_KEY]: meta });
      }
    } catch {
      // non-fatal
    }
  }

  function clearTrackedEntry(ruleId) {
    const entry = trackedEphemeralRules.get(ruleId);
    if (entry?.timer && typeof clearTimeout === "function") {
      clearTimeout(entry.timer);
    }
    trackedEphemeralRules.delete(ruleId);
  }

  function pickFreeRuleId({ existingRules, removeSet, persistedMeta }) {
    const occupied = new Set();
    for (const r of existingRules) {
      if (!removeSet.has(r.id)) {
        occupied.add(r.id);
      }
    }

    const maxId = RESOLVED_HOST_RULE_BASE_ID + RESOLVED_HOST_RULE_POOL_SIZE - 1;
    for (let candidate = RESOLVED_HOST_RULE_BASE_ID; candidate <= maxId; candidate++) {
      if (!occupied.has(candidate)) {
        return candidate;
      }
    }

    // Pool completely saturated (4000 active rules): evict the oldest rule by expiry
    let oldestId = RESOLVED_HOST_RULE_BASE_ID;
    let oldestExpiry = Infinity;
    for (const r of existingRules) {
      if (removeSet.has(r.id)) continue;
      const exp =
        trackedEphemeralRules.get(r.id)?.expiresAt ??
        Number(persistedMeta?.[String(r.id)]?.expiresAt) ??
        0;
      if (exp < oldestExpiry) {
        oldestExpiry = exp;
        oldestId = r.id;
      }
    }
    return oldestId;
  }

  async function removeResolvedRuleIds(ruleIds) {
    const uniqueIds = Array.from(
      new Set((ruleIds || []).filter((id) => Number.isInteger(id)))
    );
    if (uniqueIds.length === 0) return;
    return enqueueEphemeralOp(async () => {
      for (const id of uniqueIds) {
        clearTrackedEntry(id);
      }
      try {
        await updateEphemeralRules({ removeRuleIds: uniqueIds, addRules: [] });
        const meta = await readPersistedMeta();
        let changed = false;
        for (const id of uniqueIds) {
          if (String(id) in meta) {
            delete meta[String(id)];
            changed = true;
          }
        }
        if (changed) {
          await writePersistedMeta(meta);
        }
      } catch {
        // non-fatal
      }
    });
  }

  async function clearAllEphemeralRules() {
    return enqueueEphemeralOp(async () => {
      for (const id of Array.from(trackedEphemeralRules.keys())) {
        clearTrackedEntry(id);
      }
      try {
        const existing = await getEphemeralRules();
        const ids = existing.map((r) => r.id);
        if (ids.length > 0) {
          await updateEphemeralRules({ removeRuleIds: ids, addRules: [] });
        }
        await writePersistedMeta({});
      } catch {
        // non-fatal
      }
    });
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
   * download URL (never matching main_frame). Always inspects live getSessionRules()
   * to pick an unoccupied rule ID so large multi-file batches (>200) and MV3 Service
   * Worker restarts never overwrite active rules.
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
    return enqueueEphemeralOp(async () => {
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
        const existingRules = await getEphemeralRules();
        const persistedMeta = await readPersistedMeta();
        const existingIdSet = new Set(existingRules.map((r) => r.id));

        // Prune stale metadata for rules no longer present in session rules
        for (const key of Object.keys(persistedMeta)) {
          if (!existingIdSet.has(Number(key))) {
            delete persistedMeta[key];
          }
        }

        // Collect expired rules from both in-memory tracking and SW-restart-persisted metadata
        const removeSet = new Set();
        for (const [id, entry] of trackedEphemeralRules.entries()) {
          if (entry.expiresAt <= now) {
            clearTrackedEntry(id);
            removeSet.add(id);
            delete persistedMeta[String(id)];
          }
        }
        for (const rule of existingRules) {
          const metaEntry = persistedMeta[String(rule.id)];
          if (metaEntry && Number(metaEntry.expiresAt) > 0 && Number(metaEntry.expiresAt) <= now) {
            clearTrackedEntry(rule.id);
            removeSet.add(rule.id);
            delete persistedMeta[String(rule.id)];
          }
        }

        // Reuse existing rule ID if an identical urlFilter rule is already installed;
        // otherwise allocate the lowest free ID from live getSessionRules().
        const sameFilterRule = existingRules.find(
          (r) => !removeSet.has(r.id) && r.condition?.urlFilter === urlFilter
        );
        const ruleId = sameFilterRule
          ? sameFilterRule.id
          : pickFreeRuleId({ existingRules, removeSet, persistedMeta });

        clearTrackedEntry(ruleId);
        removeSet.add(ruleId);

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
          removeRuleIds: Array.from(removeSet),
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
        const expiresAt = now + effectiveTtl;
        const timer = setTimeout(() => {
          removeResolvedRuleIds([ruleId]);
        }, effectiveTtl);
        timer?.unref?.();

        trackedEphemeralRules.set(ruleId, {
          ruleId,
          url: normalizedUrl,
          urlFilter,
          createdAt: now,
          expiresAt,
          timer,
        });

        persistedMeta[String(ruleId)] = { expiresAt, urlFilter };
        await writePersistedMeta(persistedMeta);

        return { ruleId, urlFilter };
      } catch {
        return null;
      }
    });
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
