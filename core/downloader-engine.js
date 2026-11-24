import { pushToAria2 } from "./aria2.js";
import { sanitizeFilename } from "./utils.js";

/**
 * Provider-agnostic download orchestration engine:
 * - 1-byte Range preflight & 302 CDN resolution
 * - Dynamic DNR resolved-host rule injection (so hidden iframe downloads 100% hit DNR)
 * - Aria2 push with provider headers & preserved relative folder paths
 */
export function createDownloaderEngine({ registry, storage, dnr }) {
  async function probeAndResolveDownloadUrl(url, { credentials = "omit" } = {}) {
    await dnr.syncAllDnrRules();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        credentials,
        redirect: "follow",
        signal: controller.signal,
      });

      if (!res.ok) {
        let bodySnippet = "";
        try {
          bodySnippet = (await res.text())
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240);
        } catch {
          // ignore
        }
        throw new Error(
          `直链预检失败（HTTP ${res.status}）${bodySnippet ? `：${bodySnippet}` : ""}`
        );
      }

      const resolvedUrl = res.url || url;
      const contentDisposition = res.headers.get("content-disposition") || "";
      const hasAttachment = /attachment/i.test(contentDisposition);

      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }

      return { resolvedUrl, hasAttachment };
    } finally {
      clearTimeout(timer);
    }
  }

  async function startBrowserDownload({
    provider,
    providerConfig,
    url,
    filename,
    preferFrameDownload = false,
  }) {
    if (!provider.isAllowedDownloadUrl(url)) {
      throw new Error(
        provider.disallowedUrlMessage || "下载链接域名不在当前网盘安全白名单范围内。"
      );
    }

    const coreConfig = await storage.getCoreConfig();
    if (!coreConfig.enabled) {
      throw new Error("PanDirect 当前已暂停，请先在插件弹窗中开启下载规则。");
    }

    const credentials = provider.downloadCredentials || "omit";
    const { resolvedUrl, hasAttachment } = await probeAndResolveDownloadUrl(
      url,
      { credentials }
    );
    const requestHeaders =
      typeof provider.getDownloadRequestHeaders === "function"
        ? provider.getDownloadRequestHeaders(providerConfig)
        : [];

    await dnr.ensureResolvedHostRule({
      resolvedUrl,
      requestHeaders,
      filename,
      forceAttachment: !hasAttachment,
    });

    if (preferFrameDownload) {
      return {
        mode: "browser",
        frameDownloadUrl: resolvedUrl,
        filename: sanitizeFilename(filename),
      };
    }

    const options = { url: resolvedUrl };
    const safeName = sanitizeFilename(filename);
    if (safeName) {
      options.filename = safeName;
    }

    const downloadId = await chrome.downloads.download(options);
    return { mode: "browser", downloadId, frameDownloadUrl: resolvedUrl };
  }

  async function downloadItemsByIds({
    providerId,
    itemIds,
    mode,
    preferFrameDownload = false,
    providerCtx,
  }) {
    const provider = registry.get(providerId);
    const coreConfig = await storage.getCoreConfig();
    const providerConfig = await storage.getProviderConfig(provider.id);
    const effectiveMode = mode || coreConfig.downloadMode || "browser";

    const targets = await provider.resolveDownloadTargets(itemIds, providerCtx);
    const results = [];

    for (const target of targets) {
      if (!target.url) {
        results.push({
          id: target.id,
          fsId: target.fsId || target.id,
          filename: target.filename,
          ok: false,
          error: target.error || "该条目未返回有效下载链接",
        });
        continue;
      }

      try {
        const res =
          effectiveMode === "aria2"
            ? await (async () => {
                if (!provider.isAllowedDownloadUrl(target.url)) {
                  throw new Error("直链域名不在白名单范围内，已拒绝推送。");
                }
                const headers =
                  target.aria2Headers ||
                  (typeof provider.getAria2Headers === "function"
                    ? await provider.getAria2Headers(providerConfig, {
                        url: target.url,
                        coreConfig,
                      })
                    : []);
                return pushToAria2({
                  url: target.url,
                  filename: target.filename,
                  headers,
                  coreConfig,
                });
              })()
            : await startBrowserDownload({
                provider,
                providerConfig,
                url: target.url,
                filename: target.filename,
                preferFrameDownload,
              });

        results.push({
          id: target.id,
          fsId: target.fsId || target.id,
          filename: target.filename,
          ok: true,
          ...res,
        });
      } catch (err) {
        results.push({
          id: target.id,
          fsId: target.fsId || target.id,
          filename: target.filename,
          ok: false,
          error: err?.message || String(err),
        });
      }
    }

    return { provider: provider.id, mode: effectiveMode, results };
  }

  async function resolveStreamUrl({ providerId, itemId, providerCtx }) {
    const provider = registry.get(providerId);
    const coreConfig = await storage.getCoreConfig();
    if (!coreConfig.enabled) {
      throw new Error("PanDirect 下载规则当前已暂停，请先在插件弹窗中开启。");
    }

    await dnr.syncAllDnrRules();
    const resolved = await provider.resolveStreamTarget(itemId, providerCtx);
    if (!provider.isAllowedDownloadUrl(resolved.url)) {
      throw new Error("直链域名不在安全白名单范围内。");
    }

    return {
      provider: provider.id,
      id: resolved.id,
      fsId: resolved.fsId || resolved.id,
      filename: resolved.filename,
      size: resolved.size,
      url: resolved.url,
      credentials: provider.downloadCredentials || "omit",
    };
  }

  async function pushItemToAria2({
    providerId,
    itemId,
    relativePath,
    providerCtx,
  }) {
    const provider = registry.get(providerId);
    const coreConfig = await storage.getCoreConfig();
    const providerConfig = await storage.getProviderConfig(provider.id);
    const resolved = await provider.resolveStreamTarget(itemId, providerCtx);

    if (!provider.isAllowedDownloadUrl(resolved.url)) {
      throw new Error("直链域名不在白名单范围内，已拒绝推送。");
    }

    const headers =
      resolved.aria2Headers ||
      (typeof provider.getAria2Headers === "function"
        ? await provider.getAria2Headers(providerConfig, {
            url: resolved.url,
            coreConfig,
          })
        : []);

    return pushToAria2({
      url: resolved.url,
      filename: resolved.filename,
      relativePath,
      headers,
      coreConfig,
    });
  }

  async function downloadDirectUrl({
    providerId,
    url,
    filename,
    relativePath,
    mode,
  }) {
    const provider = providerId
      ? registry.get(providerId)
      : registry.findByDownloadUrl(url);

    if (!provider) {
      throw new Error("下载链接域名不在当前版本允许的网盘白名单范围内。");
    }

    const coreConfig = await storage.getCoreConfig();
    const providerConfig = await storage.getProviderConfig(provider.id);
    const effectiveMode = mode || coreConfig.downloadMode || "browser";

    if (effectiveMode === "aria2") {
      if (!provider.isAllowedDownloadUrl(url)) {
        throw new Error("直链域名不在白名单范围内，已拒绝推送。");
      }
      const headers =
        typeof provider.getAria2Headers === "function"
          ? await provider.getAria2Headers(providerConfig, { url, coreConfig })
          : [];
      return pushToAria2({
        url,
        filename,
        relativePath,
        headers,
        coreConfig,
      });
    }

    return startBrowserDownload({
      provider,
      providerConfig,
      url,
      filename,
      preferFrameDownload: false,
    });
  }

  return {
    probeAndResolveDownloadUrl,
    startBrowserDownload,
    downloadItemsByIds,
    resolveStreamUrl,
    pushItemToAria2,
    downloadDirectUrl,
  };
}
