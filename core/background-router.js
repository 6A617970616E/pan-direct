import { EDITION, EDITION_LABEL } from "./edition.js";
import { createProviderRegistry } from "./provider-registry.js";
import { createStorageManager } from "./storage.js";
import { createDnrManager } from "./dnr.js";
import { createDownloaderEngine } from "./downloader-engine.js";
import { testAria2Connection } from "./aria2.js";

function getSenderUrl(sender) {
  return sender?.url || sender?.tab?.url || "";
}

function isSameExtensionSender(sender) {
  if (!sender || typeof sender !== "object") return false;
  if (typeof chrome !== "undefined" && chrome.runtime?.id) {
    return sender.id === chrome.runtime.id;
  }
  return Boolean(sender.id);
}

function isExtensionPageWithPrefix(sender, relPrefix) {
  if (!isSameExtensionSender(sender)) return false;
  if (typeof sender.url !== "string" || !sender.url) return false;
  const expectedPrefix = chrome.runtime.getURL(relPrefix);
  return sender.url.startsWith(expectedPrefix);
}

function isPopupSender(sender) {
  return isExtensionPageWithPrefix(sender, "popup/");
}

function isDownloaderSender(sender) {
  return isExtensionPageWithPrefix(sender, "downloader/");
}

function isTrustedExtensionPageSender(sender) {
  return isPopupSender(sender) || isDownloaderSender(sender);
}

function isProviderContentSender(sender, provider) {
  if (!isSameExtensionSender(sender)) return false;
  const rawUrl = sender?.tab?.url || sender?.url || "";
  if (!rawUrl || typeof rawUrl !== "string") return false;
  const allowedDomains = Array.isArray(provider?.contentScriptDomains)
    ? provider.contentScriptDomains
    : [];
  if (allowedDomains.length === 0) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return allowedDomains.some((d) => host === String(d).toLowerCase());
  } catch {
    return false;
  }
}

function isAnyRegisteredProviderContentSender(sender, registry) {
  return registry
    .list()
    .some((provider) => isProviderContentSender(sender, provider));
}

function isLocalhostBridgeSender(sender) {
  if (!isSameExtensionSender(sender)) return false;
  const rawUrl = getSenderUrl(sender);
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) {
      return true;
    }
    if (parsed.protocol === "https:" && host === "localhost") {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function sanitizeWritableProviderConfig(providerId, rawConfig) {
  if (!rawConfig || typeof rawConfig !== "object") return {};
  const patch = {};
  if (typeof rawConfig.userAgent === "string" && rawConfig.userAgent.trim()) {
    patch.userAgent = rawConfig.userAgent.trim();
  }
  if (providerId === "baidu" && typeof rawConfig.appKey === "string") {
    patch.appKey = rawConfig.appKey.trim();
  }
  return patch;
}

/**
 * Builds the background service worker runtime around a list of enabled providers.
 * Separated from Chrome listener registration for clean testability.
 */
export function createBackgroundRuntime(providers, { edition = EDITION } = {}) {
  const registry = createProviderRegistry(providers);
  const storage = createStorageManager(registry);
  const dnr = createDnrManager(registry, storage);
  const downloader = createDownloaderEngine({ registry, storage, dnr });

  function createProviderContext(providerId) {
    return {
      providerId,
      getCoreConfig: () => storage.getCoreConfig(),
      getConfig: () => storage.getProviderConfig(providerId),
      setConfig: (partial) => storage.setProviderConfig(providerId, partial),
      syncDnrRules: () => dnr.syncAllDnrRules(),
    };
  }

  async function buildMinimalBridgeStatus() {
    const coreConfig = await storage.getCoreConfig();
    return {
      version: chrome.runtime.getManifest().version,
      edition,
      editionLabel: EDITION_LABEL,
      enabled: coreConfig.enabled,
      downloadMode: coreConfig.downloadMode,
    };
  }

  async function buildPublicStatus() {
    const coreConfig = await storage.getCoreConfig();
    const activeRuleCount = await dnr.getActiveRuleCount();
    const providerList = registry.list();
    const providerSummaries = [];
    let baiduStatus = null;

    for (const provider of providerList) {
      const cfg = await storage.getProviderConfig(provider.id);
      const status =
        typeof provider.getPublicStatus === "function"
          ? provider.getPublicStatus(cfg)
          : {};
      if (provider.id === "baidu") {
        baiduStatus = status;
      }
      providerSummaries.push({
        id: provider.id,
        name: provider.name,
        tier: provider.tier,
        authType: provider.authType,
        capabilities: provider.capabilities,
        status,
      });
    }

    const defaultProvider = registry.getDefault();

    return {
      version: chrome.runtime.getManifest().version,
      edition,
      editionLabel: EDITION_LABEL,
      enabled: coreConfig.enabled,
      downloadMode: coreConfig.downloadMode,
      aria2Url: coreConfig.aria2Url,
      aria2HasSecret: Boolean(coreConfig.aria2Secret),
      activeRuleCount,
      defaultProvider: defaultProvider.id,
      providers: providerSummaries,
      // Backward-compatible top-level Baidu fields
      ...(baiduStatus
        ? {
            userAgent: baiduStatus.userAgent,
            appKey: baiduStatus.appKey,
            hasToken: baiduStatus.hasToken,
            tokenValid: baiduStatus.tokenValid,
            tokenExpiresAt: baiduStatus.tokenExpiresAt,
          }
        : {}),
    };
  }

  async function handleMessage(message, sender = {}) {
    switch (message?.type) {
      case "PANDIRECT_GET_STATUS": {
        if (
          isTrustedExtensionPageSender(sender) ||
          isAnyRegisteredProviderContentSender(sender, registry)
        ) {
          return {
            ok: true,
            ...(await buildPublicStatus()),
          };
        }
        if (edition === "dev" && isLocalhostBridgeSender(sender)) {
          return {
            ok: true,
            ...(await buildMinimalBridgeStatus()),
          };
        }
        throw new Error("未授权的调用来源");
      }

      case "PANDIRECT_SET_CONFIG": {
        if (!isPopupSender(sender)) {
          throw new Error("未授权的调用来源");
        }
        await storage.setCoreConfig(message);

        if (message.provider && message.providerConfig) {
          const safePatch = sanitizeWritableProviderConfig(
            message.provider,
            message.providerConfig
          );
          if (Object.keys(safePatch).length > 0) {
            await storage.setProviderConfig(message.provider, safePatch);
          }
        } else if (registry.has("baidu")) {
          const legacyBaiduPatch = {};
          if (typeof message.appKey === "string") {
            legacyBaiduPatch.appKey = message.appKey.trim();
          }
          if (typeof message.userAgent === "string" && message.userAgent.trim()) {
            legacyBaiduPatch.userAgent = message.userAgent.trim();
          }
          if (Object.keys(legacyBaiduPatch).length > 0) {
            await storage.setProviderConfig("baidu", legacyBaiduPatch);
          }
        }

        await dnr.syncAllDnrRules();
        return {
          ok: true,
          ...(await buildPublicStatus()),
        };
      }

      case "PANDIRECT_OAUTH_LOGIN":
      case "PANDIRECT_PROVIDER_AUTH_START": {
        if (!isPopupSender(sender)) {
          throw new Error("未授权的调用来源");
        }
        const provider = registry.get(message.provider);
        const ctx = createProviderContext(provider.id);
        const authResult = await provider.startAuth(message, ctx);
        await dnr.syncAllDnrRules();
        return {
          ok: true,
          authResult,
          ...(await buildPublicStatus()),
        };
      }

      case "PANDIRECT_OAUTH_LOGOUT":
      case "PANDIRECT_PROVIDER_AUTH_LOGOUT": {
        if (!isPopupSender(sender)) {
          throw new Error("未授权的调用来源");
        }
        const provider = registry.get(message.provider);
        const ctx = createProviderContext(provider.id);
        await provider.logout(ctx);
        await dnr.syncAllDnrRules();
        return {
          ok: true,
          ...(await buildPublicStatus()),
        };
      }

      case "PANDIRECT_PROVIDER_SYNC_SESSION": {
        const provider = registry.get(message.provider);
        if (!isProviderContentSender(sender, provider)) {
          throw new Error("未授权的会话同步来源");
        }
        if (typeof provider.syncSession !== "function") {
          return { ok: false, error: "当前网盘不支持会话同步" };
        }
        const ctx = createProviderContext(provider.id);
        const result = await provider.syncSession(message.session, ctx, sender);
        return {
          ok: true,
          ...(result || {}),
        };
      }

      case "PANDIRECT_LIST_FILES": {
        const provider = registry.get(message.provider);
        if (
          !isTrustedExtensionPageSender(sender) &&
          !isProviderContentSender(sender, provider)
        ) {
          throw new Error("未授权的调用来源");
        }
        const ctx = createProviderContext(provider.id);
        const result = await provider.listFiles(message.dir, ctx);
        return {
          ok: true,
          provider: provider.id,
          providerName: provider.name,
          ...result,
        };
      }

      case "PANDIRECT_LIST_FOLDER_RECURSIVE": {
        if (!isDownloaderSender(sender)) {
          throw new Error("未授权的调用来源");
        }
        const provider = registry.get(message.provider);
        const ctx = createProviderContext(provider.id);
        const result = await provider.listFolderRecursive(message.path, ctx);
        return {
          ok: true,
          provider: provider.id,
          providerName: provider.name,
          ...result,
        };
      }

      case "PANDIRECT_OPEN_FOLDER_DOWNLOADER": {
        const provider = registry.get(message.provider);
        if (
          !isTrustedExtensionPageSender(sender) &&
          !isProviderContentSender(sender, provider)
        ) {
          throw new Error("未授权的调用来源");
        }
        const folderPath = message.path || "/";
        const mode = message.mode === "aria2" ? "aria2" : "browser";
        const query = new URLSearchParams({
          provider: provider.id,
          path: folderPath,
          mode,
        });
        if (message.label && typeof message.label === "string") {
          query.set("label", message.label);
        }
        const targetUrl = chrome.runtime.getURL(
          `downloader/downloader.html?${query.toString()}`
        );
        await chrome.tabs.create({ url: targetUrl });
        return { ok: true };
      }

      // Used exclusively by our trusted extension downloader page (downloader.html)
      case "PANDIRECT_GET_FILE_STREAM_URL": {
        if (!isDownloaderSender(sender)) {
          throw new Error("未授权的调用来源");
        }
        const provider = registry.get(message.provider);
        const itemId = message.itemId ?? message.fsId;
        const resolved = await downloader.resolveStreamUrl({
          providerId: provider.id,
          itemId,
          providerCtx: createProviderContext(provider.id),
        });
        return { ok: true, ...resolved };
      }

      case "PANDIRECT_PUSH_FSID_TO_ARIA2":
      case "PANDIRECT_PUSH_ITEM_TO_ARIA2": {
        if (!isDownloaderSender(sender)) {
          throw new Error("未授权的调用来源");
        }
        const provider = registry.get(message.provider);
        const itemId = message.itemId ?? message.fsId;
        const result = await downloader.pushItemToAria2({
          providerId: provider.id,
          itemId,
          relativePath: message.relativePath,
          providerCtx: createProviderContext(provider.id),
        });
        return { ok: true, ...result };
      }

      case "PANDIRECT_DOWNLOAD_FSIDS":
      case "PANDIRECT_DOWNLOAD_ITEMS": {
        const provider = registry.get(message.provider);
        if (
          !isTrustedExtensionPageSender(sender) &&
          !isProviderContentSender(sender, provider)
        ) {
          throw new Error("未授权的调用来源");
        }
        const itemIds = message.itemIds || message.fsIds || [];
        let initiatorDomains = provider.contentScriptDomains;
        const rawSenderUrl = sender?.tab?.url || sender?.url || "";
        if (rawSenderUrl) {
          try {
            const parsed = new URL(rawSenderUrl);
            if (parsed.protocol === "https:" && parsed.hostname) {
              initiatorDomains = [parsed.hostname.toLowerCase()];
            }
          } catch {
            // fall back to provider.contentScriptDomains
          }
        }
        const result = await downloader.downloadItemsByIds({
          providerId: provider.id,
          itemIds,
          mode: message.mode,
          preferFrameDownload: Boolean(message.preferFrameDownload),
          providerCtx: createProviderContext(provider.id),
          initiatorDomains,
        });
        return { ok: true, ...result };
      }

      case "PANDIRECT_DOWNLOAD": {
        const allowBridge = edition === "dev" && isLocalhostBridgeSender(sender);
        if (!isPopupSender(sender) && !allowBridge) {
          throw new Error("未授权的调用来源");
        }
        const result = await downloader.downloadDirectUrl({
          providerId: message.provider,
          url: message.url,
          filename: message.filename,
          relativePath: message.relativePath,
          mode: message.mode,
        });
        return { ok: true, ...result };
      }

      case "PANDIRECT_TEST_ARIA2": {
        if (!isPopupSender(sender)) {
          throw new Error("未授权的调用来源");
        }
        const coreConfig = await storage.getCoreConfig();
        const result = await testAria2Connection({
          aria2Url: message.aria2Url,
          aria2Secret: message.aria2Secret,
          coreConfig,
        });
        return { ok: true, ...result };
      }

      default:
        return { ok: false, error: "未知消息类型" };
    }
  }

  async function handleTabUpdated(tabId, changeInfo, tab) {
    for (const provider of registry.list()) {
      if (typeof provider.onTabUpdated !== "function") continue;
      try {
        await provider.onTabUpdated(
          tabId,
          changeInfo,
          tab,
          createProviderContext(provider.id)
        );
      } catch (err) {
        console.warn(
          `[PanDirect:${provider.id}] onTabUpdated error:`,
          err?.message || err
        );
      }
    }
  }

  async function handleWindowRemoved(windowId) {
    for (const provider of registry.list()) {
      if (typeof provider.onWindowRemoved !== "function") continue;
      try {
        await provider.onWindowRemoved(
          windowId,
          createProviderContext(provider.id)
        );
      } catch (err) {
        console.warn(
          `[PanDirect:${provider.id}] onWindowRemoved error:`,
          err?.message || err
        );
      }
    }
  }

  async function handleDownloadChanged(delta) {
    const state = delta?.state?.current;
    if (state !== "complete" && state !== "interrupted") return;
    if (
      typeof chrome === "undefined" ||
      typeof chrome.downloads?.search !== "function"
    ) {
      return;
    }
    try {
      const items = await chrome.downloads.search({ id: delta.id });
      const item = Array.isArray(items) ? items[0] : null;
      if (!item) return;
      if (item.finalUrl) {
        await dnr.cleanupResolvedRulesForUrl(item.finalUrl);
      }
      if (item.url && item.url !== item.finalUrl) {
        await dnr.cleanupResolvedRulesForUrl(item.url);
      }
    } catch {
      // non-fatal
    }
  }

  return {
    registry,
    storage,
    dnr,
    downloader,
    buildPublicStatus,
    handleMessage,
    handleTabUpdated,
    handleWindowRemoved,
    handleDownloadChanged,
  };
}

/**
 * Synchronously registers all MV3 Service Worker top-level event listeners.
 * Must be called at the top level of background.js so SW wakeups never miss events.
 */
export function initBackground(providers) {
  const runtime = createBackgroundRuntime(providers);

  chrome.runtime.onInstalled.addListener(async () => {
    await runtime.dnr.syncAllDnrRules();
  });

  chrome.runtime.onStartup.addListener(async () => {
    await runtime.dnr.syncAllDnrRules();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    runtime.handleTabUpdated(tabId, changeInfo, tab);
  });

  chrome.windows.onRemoved.addListener((removedWindowId) => {
    runtime.handleWindowRemoved(removedWindowId);
  });

  if (chrome.downloads?.onChanged?.addListener) {
    chrome.downloads.onChanged.addListener((delta) => {
      runtime.handleDownloadChanged(delta);
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        const res = await runtime.handleMessage(message, sender);
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();

    return true;
  });

  return runtime;
}
