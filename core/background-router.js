import { EDITION, EDITION_LABEL } from "./edition.js";
import { createProviderRegistry } from "./provider-registry.js";
import { createStorageManager } from "./storage.js";
import { createDnrManager } from "./dnr.js";
import { createDownloaderEngine } from "./downloader-engine.js";
import { testAria2Connection } from "./aria2.js";

/**
 * Builds the background service worker runtime around a list of enabled providers.
 * Separated from Chrome listener registration for clean testability.
 */
export function createBackgroundRuntime(providers) {
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
      edition: EDITION,
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
        return {
          ok: true,
          ...(await buildPublicStatus()),
        };
      }

      case "PANDIRECT_SET_CONFIG": {
        await storage.setCoreConfig(message);

        if (message.provider && message.providerConfig) {
          await storage.setProviderConfig(
            message.provider,
            message.providerConfig
          );
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
        const provider = registry.get(message.provider);
        const ctx = createProviderContext(provider.id);
        await provider.startAuth(message, ctx);
        await dnr.syncAllDnrRules();
        return {
          ok: true,
          ...(await buildPublicStatus()),
        };
      }

      case "PANDIRECT_OAUTH_LOGOUT":
      case "PANDIRECT_PROVIDER_AUTH_LOGOUT": {
        const provider = registry.get(message.provider);
        const ctx = createProviderContext(provider.id);
        await provider.logout(ctx);
        await dnr.syncAllDnrRules();
        return {
          ok: true,
          ...(await buildPublicStatus()),
        };
      }

      case "PANDIRECT_LIST_FILES": {
        const provider = registry.get(message.provider);
        const ctx = createProviderContext(provider.id);
        const result = await provider.listFiles(message.dir, ctx);
        return { ok: true, provider: provider.id, ...result };
      }

      case "PANDIRECT_LIST_FOLDER_RECURSIVE": {
        const provider = registry.get(message.provider);
        const ctx = createProviderContext(provider.id);
        const result = await provider.listFolderRecursive(message.path, ctx);
        return { ok: true, provider: provider.id, ...result };
      }

      case "PANDIRECT_OPEN_FOLDER_DOWNLOADER": {
        const provider = registry.get(message.provider);
        const folderPath = message.path || "/";
        const mode = message.mode === "aria2" ? "aria2" : "browser";
        const targetUrl = chrome.runtime.getURL(
          `downloader/downloader.html?provider=${encodeURIComponent(
            provider.id
          )}&path=${encodeURIComponent(folderPath)}&mode=${mode}`
        );
        await chrome.tabs.create({ url: targetUrl });
        return { ok: true };
      }

      // Used exclusively by our trusted extension downloader page (downloader.html)
      case "PANDIRECT_GET_FILE_STREAM_URL": {
        const expectedPrefix = chrome.runtime.getURL("downloader/");
        if (
          sender.id !== chrome.runtime.id ||
          !sender.url ||
          !sender.url.startsWith(expectedPrefix)
        ) {
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
        const itemIds = message.itemIds || message.fsIds || [];
        const result = await downloader.downloadItemsByIds({
          providerId: provider.id,
          itemIds,
          mode: message.mode,
          preferFrameDownload: Boolean(message.preferFrameDownload),
          providerCtx: createProviderContext(provider.id),
        });
        return { ok: true, ...result };
      }

      case "PANDIRECT_DOWNLOAD": {
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

  return {
    registry,
    storage,
    dnr,
    downloader,
    buildPublicStatus,
    handleMessage,
    handleTabUpdated,
    handleWindowRemoved,
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
