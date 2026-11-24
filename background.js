const DEFAULT_CONFIG = {
  enabled: true,
  userAgent: "pan.baidu.com",
  appKey: "",
  accessToken: "",
  tokenExpiresAt: 0,
  downloadMode: "browser", // "browser" | "aria2"
  aria2Url: "http://localhost:6800/jsonrpc",
  aria2Secret: "",
};

const OOB_REDIRECT_URI = "oob";
const OOB_SUCCESS_PREFIX = "https://openapi.baidu.com/oauth/2.0/login_success";
const PENDING_OAUTH_KEY = "pandirectPendingOAuth";

const RULE_IDS = [1001, 1002, 1003, 1004];

const ALL_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "media",
  "other",
];

function isAllowedDownloadUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return (
      host === "d.pcs.baidu.com" ||
      host.endsWith(".pcs.baidu.com") ||
      host.endsWith(".pcsdata.baidu.com") ||
      host === "baidupcs.com" ||
      host.endsWith(".baidupcs.com")
    );
  } catch {
    return false;
  }
}

function sanitizeSegment(seg) {
  if (!seg || typeof seg !== "string") return "";
  return seg
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^\.+/, "")
    .trim();
}

function sanitizeFilename(name) {
  const cleaned = sanitizeSegment(name);
  return cleaned || undefined;
}

function sanitizeRelativePath(relPath) {
  if (!relPath || typeof relPath !== "string") return undefined;
  const parts = relPath
    .split("/")
    .map((p) => sanitizeSegment(p))
    .filter((p) => p && p !== "." && p !== "..");
  return parts.length > 0 ? parts.join("/") : undefined;
}

async function getConfig() {
  const stored = await chrome.storage.local.get(DEFAULT_CONFIG);
  return {
    enabled: Boolean(stored.enabled),
    userAgent:
      (stored.userAgent || DEFAULT_CONFIG.userAgent).trim() ||
      DEFAULT_CONFIG.userAgent,
    appKey: (stored.appKey || "").trim(),
    accessToken: (stored.accessToken || "").trim(),
    tokenExpiresAt: Number(stored.tokenExpiresAt) || 0,
    downloadMode: stored.downloadMode === "aria2" ? "aria2" : "browser",
    aria2Url: (stored.aria2Url || DEFAULT_CONFIG.aria2Url).trim(),
    aria2Secret: (stored.aria2Secret || "").trim(),
  };
}

function buildPublicStatus(config, activeRuleCount) {
  const now = Date.now();
  const hasToken = Boolean(config.accessToken);
  const tokenValid =
    hasToken && (config.tokenExpiresAt === 0 || config.tokenExpiresAt > now);

  return {
    version: chrome.runtime.getManifest().version,
    enabled: config.enabled,
    userAgent: config.userAgent,
    appKey: config.appKey,
    hasToken,
    tokenValid,
    tokenExpiresAt: config.tokenExpiresAt,
    downloadMode: config.downloadMode,
    aria2Url: config.aria2Url,
    aria2HasSecret: Boolean(config.aria2Secret),
    activeRuleCount,
  };
}

function buildModifyRequestHeaders(userAgent) {
  return [
    {
      header: "user-agent",
      operation: "set",
      value: userAgent,
    },
    {
      header: "sec-ch-ua",
      operation: "remove",
    },
    {
      header: "sec-ch-ua-mobile",
      operation: "remove",
    },
    {
      header: "sec-ch-ua-platform",
      operation: "remove",
    },
    {
      header: "referer",
      operation: "remove",
    },
    {
      header: "origin",
      operation: "remove",
    },
  ];
}

function buildDnrRules(userAgent) {
  const modifyAction = {
    type: "modifyHeaders",
    requestHeaders: buildModifyRequestHeaders(userAgent),
  };

  return [
    {
      id: RULE_IDS[0],
      priority: 1,
      action: modifyAction,
      condition: {
        urlFilter: "||pcs.baidu.com/",
        resourceTypes: ALL_RESOURCE_TYPES,
      },
    },
    {
      id: RULE_IDS[1],
      priority: 1,
      action: modifyAction,
      condition: {
        urlFilter: "||baidupcs.com/",
        resourceTypes: ALL_RESOURCE_TYPES,
      },
    },
    {
      id: RULE_IDS[2],
      priority: 1,
      action: modifyAction,
      condition: {
        urlFilter: "||pcsdata.baidu.com/",
        resourceTypes: ALL_RESOURCE_TYPES,
      },
    },
  ];
}

async function syncDnrRules() {
  const config = await getConfig();

  if (config.enabled) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: RULE_IDS,
      addRules: buildDnrRules(config.userAgent),
    });
    await chrome.action.setBadgeText({ text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
  } else {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: RULE_IDS,
      addRules: [],
    });
    await chrome.action.setBadgeText({ text: "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
  }

  return config;
}

async function completeOAuthFromUrl(finalUrl, appKey, windowId) {
  const parsed = new URL(finalUrl);
  const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
  const queryParams = parsed.searchParams;

  await chrome.storage.session.remove(PENDING_OAUTH_KEY);
  if (windowId) {
    chrome.windows.remove(windowId).catch(() => {});
  }

  const error = hashParams.get("error") || queryParams.get("error");
  if (error) {
    const desc =
      hashParams.get("error_description") ||
      queryParams.get("error_description") ||
      error;
    throw new Error(`百度授权失败：${desc}`);
  }

  const accessToken = hashParams.get("access_token");
  if (!accessToken) {
    throw new Error("未从百度回调页中获取到 access_token，请重试授权。");
  }

  const expiresIn = Number(hashParams.get("expires_in")) || 2592000;
  const tokenExpiresAt = Date.now() + expiresIn * 1000;

  await chrome.storage.local.set({
    appKey,
    accessToken,
    tokenExpiresAt,
  });

  await syncDnrRules();
  return { tokenExpiresAt, expiresIn };
}

/**
 * Standard explicit OAuth 2.0 implicit flow (response_type=token, redirect_uri=oob).
 * Uses Baidu's built-in China-direct login_success callback (no callback URL setup required)
 * inside a normal browser popup window so it reuses the user's logged-in Baidu session.
 */
async function startOAuthFlow(overrideAppKey) {
  const config = await getConfig();
  const appKey = (overrideAppKey || config.appKey || "").trim();
  if (!appKey) {
    throw new Error("请先在扩展弹窗中填写百度开放平台应用的 AppKey。");
  }

  await chrome.storage.local.set({ appKey });

  const authUrl = new URL("https://openapi.baidu.com/oauth/2.0/authorize");
  authUrl.searchParams.set("response_type", "token");
  authUrl.searchParams.set("client_id", appKey);
  authUrl.searchParams.set("redirect_uri", OOB_REDIRECT_URI);
  authUrl.searchParams.set("scope", "basic,netdisk");
  authUrl.searchParams.set("display", "popup");

  const win = await chrome.windows.create({
    url: authUrl.toString(),
    type: "popup",
    width: 620,
    height: 640,
    focused: true,
  });

  const tabId = win.tabs?.[0]?.id;
  await chrome.storage.session.set({
    [PENDING_OAUTH_KEY]: {
      windowId: win.id,
      tabId,
      appKey,
      startedAt: Date.now(),
    },
  });

  return { opened: true, windowId: win.id };
}

// Top-level listener captures Baidu's oob login_success redirect reliably even if SW idles.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const candidateUrl = changeInfo.url || tab?.url || "";
  if (!candidateUrl || !candidateUrl.startsWith(OOB_SUCCESS_PREFIX)) return;

  const stored = await chrome.storage.session.get(PENDING_OAUTH_KEY);
  const pending = stored?.[PENDING_OAUTH_KEY];
  if (!pending) return;

  const isTargetTab =
    (pending.tabId && tabId === pending.tabId) ||
    (pending.windowId && tab?.windowId === pending.windowId);
  if (!isTargetTab) return;

  if (!candidateUrl.includes("access_token=") && !candidateUrl.includes("error=")) {
    return;
  }

  try {
    await completeOAuthFromUrl(candidateUrl, pending.appKey, pending.windowId);
  } catch (err) {
    console.warn("[PanDirect] OAuth callback error:", err?.message || err);
  }
});

chrome.windows.onRemoved.addListener(async (removedWindowId) => {
  const stored = await chrome.storage.session.get(PENDING_OAUTH_KEY);
  const pending = stored?.[PENDING_OAUTH_KEY];
  if (pending && pending.windowId === removedWindowId) {
    await chrome.storage.session.remove(PENDING_OAUTH_KEY);
  }
});

async function requireValidToken() {
  const config = await getConfig();
  if (!config.accessToken) {
    throw new Error("尚未完成百度授权，请点击右上角 PanDirect 图标完成一次授权。");
  }
  if (config.tokenExpiresAt && config.tokenExpiresAt <= Date.now()) {
    throw new Error("授权已过期，请在 PanDirect 弹窗中重新点击「百度授权」。");
  }
  return config;
}

function formatBaiduApiError(errno, errmsg) {
  const map = {
    [-6]: "身份验证失败或应用无权访问该目录（errno=-6，请检查授权是否有效，或确认应用是否仅限 /apps/PanDirect 沙盒目录）",
    [-7]: "目录路径或参数无效（errno=-7）",
    [-9]: "文件或目录不存在（errno=-9）",
    [2]: "参数错误（errno=2）",
    [111]: "access_token 已过期（errno=111），请重新授权",
    [31034]: "接口请求频次超限（errno=31034），请稍后再试",
    [31326]: "命中防盗链校验（errno=31326），请确认 PanDirect UA 规则已开启",
  };
  return map[errno] || `百度接口返回错误（errno=${errno}${errmsg ? `, ${errmsg}` : ""}）`;
}

async function listDirectoryFiles(dir = "/") {
  const config = await requireValidToken();
  const normalizedDir = dir && dir.startsWith("/") ? dir : "/";

  const url = new URL("https://pan.baidu.com/rest/2.0/xpan/file");
  url.searchParams.set("method", "list");
  url.searchParams.set("access_token", config.accessToken);
  url.searchParams.set("dir", normalizedDir);
  url.searchParams.set("order", "time");
  url.searchParams.set("desc", "1");
  url.searchParams.set("start", "0");
  url.searchParams.set("limit", "200");

  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok) {
    throw new Error(`请求文件列表失败：HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.errno !== 0) {
    throw new Error(formatBaiduApiError(data.errno, data.errmsg));
  }

  const files = (data.list || []).map((item) => ({
    fsId: String(item.fs_id),
    name: item.server_filename,
    path: item.path,
    size: Number(item.size) || 0,
    isdir: Boolean(item.isdir),
  }));

  return { dir: normalizedDir, files };
}

/**
 * Recursively list all files inside a folder via BFS over xpan/file?method=list.
 * Uses the standard file list API instead of multimedia?method=listall (which returns
 * errno=20020 on personal apps without extra capability grants).
 */
async function listFolderRecursive(folderPath) {
  const config = await requireValidToken();
  const normalized =
    folderPath && folderPath.startsWith("/")
      ? folderPath.replace(/\/+$/, "") || "/"
      : "/";

  const folderName =
    normalized === "/"
      ? "BaiduNetdisk"
      : sanitizeSegment(normalized.split("/").filter(Boolean).pop()) || "Folder";

  const prefixWithSlash = normalized === "/" ? "/" : `${normalized}/`;

  const allFiles = [];
  const dirQueue = [normalized];
  const visitedDirs = new Set([normalized]);
  const PAGE_SIZE = 200;
  const MAX_DIRS = 500;
  const MAX_FILES = 10000;
  let dirsScanned = 0;
  let truncated = false;

  while (dirQueue.length > 0) {
    if (dirsScanned >= MAX_DIRS || allFiles.length >= MAX_FILES) {
      truncated = true;
      break;
    }

    const currentDir = dirQueue.shift();
    dirsScanned++;

    let start = 0;
    while (true) {
      const url = new URL("https://pan.baidu.com/rest/2.0/xpan/file");
      url.searchParams.set("method", "list");
      url.searchParams.set("access_token", config.accessToken);
      url.searchParams.set("dir", currentDir);
      url.searchParams.set("order", "name");
      url.searchParams.set("desc", "0");
      url.searchParams.set("start", String(start));
      url.searchParams.set("limit", String(PAGE_SIZE));

      const res = await fetch(url.toString(), { method: "GET" });
      if (!res.ok) {
        throw new Error(`遍历目录 ${currentDir} 失败：HTTP ${res.status}`);
      }
      const data = await res.json();
      if (data.errno !== 0) {
        throw new Error(formatBaiduApiError(data.errno, data.errmsg));
      }

      const list = data.list || [];
      for (const item of list) {
        if (item.isdir) {
          const subPath = (item.path || "").replace(/\/+$/, "");
          if (subPath && !visitedDirs.has(subPath)) {
            visitedDirs.add(subPath);
            dirQueue.push(subPath);
          }
          continue;
        }

        if (allFiles.length >= MAX_FILES) {
          truncated = true;
          break;
        }

        const fullPath = item.path || "";
        const innerRel = fullPath.startsWith(prefixWithSlash)
          ? fullPath.slice(prefixWithSlash.length)
          : item.server_filename || String(item.fs_id);

        const safeInner =
          sanitizeRelativePath(innerRel) ||
          sanitizeFilename(item.server_filename) ||
          String(item.fs_id);
        const relativePath = `${folderName}/${safeInner}`;

        allFiles.push({
          fsId: String(item.fs_id),
          name: item.server_filename,
          path: fullPath,
          relativePath,
          size: Number(item.size) || 0,
        });
      }

      if (list.length < PAGE_SIZE || allFiles.length >= MAX_FILES) {
        break;
      }
      start += list.length;
    }
  }

  return {
    folderPath: normalized,
    folderName,
    dirsScanned,
    truncated,
    files: allFiles,
    totalSize: allFiles.reduce((sum, f) => sum + f.size, 0),
  };
}

async function fetchFileMetas(fsIds) {
  const config = await requireValidToken();
  const cleanIds = fsIds
    .map((id) => Number(id))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (cleanIds.length === 0) {
    throw new Error("未获取到有效的文件 fs_id。");
  }

  // Baidu filemetas supports at most 100 fsids per request
  const combined = [];
  for (let i = 0; i < cleanIds.length; i += 100) {
    const batch = cleanIds.slice(i, i + 100);
    const url = new URL("https://pan.baidu.com/rest/2.0/xpan/multimedia");
    url.searchParams.set("method", "filemetas");
    url.searchParams.set("access_token", config.accessToken);
    url.searchParams.set("fsids", JSON.stringify(batch));
    url.searchParams.set("dlink", "1");

    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      throw new Error(`请求 filemetas 失败：HTTP ${res.status}`);
    }
    const data = await res.json();
    if (data.errno !== 0) {
      throw new Error(formatBaiduApiError(data.errno, data.errmsg));
    }
    combined.push(...(data.list || []));
  }

  if (combined.length === 0) {
    throw new Error("未查到对应文件信息，可能超出当前应用可访问的目录权限范围。");
  }

  return { config, list: combined };
}

async function ensureResolvedHostRule({ resolvedUrl, userAgent, filename, forceAttachment }) {
  try {
    const parsed = new URL(resolvedUrl);
    const action = {
      type: "modifyHeaders",
      requestHeaders: buildModifyRequestHeaders(userAgent),
    };

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

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_IDS[3]],
      addRules: [
        {
          id: RULE_IDS[3],
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

async function probeAndResolveDownloadUrl(url) {
  await syncDnrRules();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!res.ok) {
      let bodySnippet = "";
      try {
        bodySnippet = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 240);
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

async function startBrowserDownload({ url, filename, preferFrameDownload = false }) {
  if (!isAllowedDownloadUrl(url)) {
    throw new Error(
      "仅允许下载百度网盘 PCS 域名（*.pcs.baidu.com / *.baidupcs.com）的直链。"
    );
  }

  const config = await getConfig();
  if (!config.enabled) {
    throw new Error("PanDirect 当前已暂停，请先在插件弹窗中开启 UA 规则。");
  }

  const { resolvedUrl, hasAttachment } = await probeAndResolveDownloadUrl(url);

  await ensureResolvedHostRule({
    resolvedUrl,
    userAgent: config.userAgent,
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

async function pushToAria2({ url, filename, relativePath, config }) {
  if (!isAllowedDownloadUrl(url)) {
    throw new Error("直链域名不在白名单范围内，已拒绝推送。");
  }

  const rpcUrl = (config.aria2Url || DEFAULT_CONFIG.aria2Url).trim();
  if (!rpcUrl) {
    throw new Error("请先在 PanDirect 设置中填写 Aria2 RPC 地址。");
  }

  const aria2Options = {
    header: [`User-Agent: ${config.userAgent}`],
  };

  // Preserve subdirectory path in Aria2 when downloading folders
  const safeOut = relativePath
    ? sanitizeRelativePath(relativePath)
    : sanitizeFilename(filename);
  if (safeOut) {
    aria2Options.out = safeOut;
  }

  const params = [];
  if (config.aria2Secret) {
    params.push(`token:${config.aria2Secret}`);
  }
  params.push([url]);
  params.push(aria2Options);

  const payload = {
    jsonrpc: "2.0",
    id: `pandirect_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    method: "aria2.addUri",
    params,
  };

  let res;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(
      `无法连接 Aria2 RPC（${rpcUrl}），请确认 Aria2 / Motrix 已启动。`
    );
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Aria2 返回错误：${data.error.message || JSON.stringify(data.error)}`);
  }

  return { mode: "aria2", gid: data.result };
}

async function resolveDlinkForFsId(fsId) {
  const { config, list } = await fetchFileMetas([fsId]);
  const item = list[0];
  if (!item || !item.dlink) {
    throw new Error("未获取到文件 dlink（可能无权限或为文件夹）");
  }

  const sep = item.dlink.includes("?") ? "&" : "?";
  const fullUrl = `${item.dlink}${sep}access_token=${encodeURIComponent(
    config.accessToken
  )}`;

  return {
    fsId: String(item.fs_id),
    filename: item.filename,
    size: Number(item.size) || 0,
    url: fullUrl,
    config,
  };
}

async function downloadByFsIds({ fsIds, mode, preferFrameDownload = false }) {
  const { config, list } = await fetchFileMetas(fsIds);
  const effectiveMode = mode || config.downloadMode || "browser";
  const results = [];

  for (const item of list) {
    if (!item.dlink) {
      results.push({
        fsId: String(item.fs_id),
        filename: item.filename,
        ok: false,
        error: "该条目未返回 dlink（可能是文件夹或无权限）",
      });
      continue;
    }

    const sep = item.dlink.includes("?") ? "&" : "?";
    const fullUrl = `${item.dlink}${sep}access_token=${encodeURIComponent(
      config.accessToken
    )}`;

    try {
      const r =
        effectiveMode === "aria2"
          ? await pushToAria2({
              url: fullUrl,
              filename: item.filename,
              config,
            })
          : await startBrowserDownload({
              url: fullUrl,
              filename: item.filename,
              preferFrameDownload,
            });
      results.push({
        fsId: String(item.fs_id),
        filename: item.filename,
        ok: true,
        ...r,
      });
    } catch (err) {
      results.push({
        fsId: String(item.fs_id),
        filename: item.filename,
        ok: false,
        error: err?.message || String(err),
      });
    }
  }

  return { mode: effectiveMode, results };
}

chrome.runtime.onInstalled.addListener(async () => {
  await syncDnrRules();
});

chrome.runtime.onStartup.addListener(async () => {
  await syncDnrRules();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "PANDIRECT_GET_STATUS": {
          const config = await getConfig();
          const activeRules = await chrome.declarativeNetRequest.getDynamicRules();
          sendResponse({
            ok: true,
            ...buildPublicStatus(config, activeRules.length),
          });
          break;
        }

        case "PANDIRECT_SET_CONFIG": {
          const current = await getConfig();
          const next = {
            enabled:
              typeof message.enabled === "boolean"
                ? message.enabled
                : current.enabled,
            userAgent:
              typeof message.userAgent === "string" && message.userAgent.trim()
                ? message.userAgent.trim()
                : current.userAgent,
            appKey:
              typeof message.appKey === "string"
                ? message.appKey.trim()
                : current.appKey,
            downloadMode:
              message.downloadMode === "aria2" || message.downloadMode === "browser"
                ? message.downloadMode
                : current.downloadMode,
            aria2Url:
              typeof message.aria2Url === "string" && message.aria2Url.trim()
                ? message.aria2Url.trim()
                : current.aria2Url,
            aria2Secret:
              typeof message.aria2Secret === "string"
                ? message.aria2Secret.trim()
                : current.aria2Secret,
          };

          await chrome.storage.local.set(next);
          const synced = await syncDnrRules();
          const activeRules = await chrome.declarativeNetRequest.getDynamicRules();
          sendResponse({
            ok: true,
            ...buildPublicStatus(synced, activeRules.length),
          });
          break;
        }

        case "PANDIRECT_OAUTH_LOGIN": {
          await startOAuthFlow(message.appKey);
          const synced = await syncDnrRules();
          const activeRules = await chrome.declarativeNetRequest.getDynamicRules();
          sendResponse({
            ok: true,
            ...buildPublicStatus(synced, activeRules.length),
          });
          break;
        }

        case "PANDIRECT_OAUTH_LOGOUT": {
          await chrome.storage.local.set({ accessToken: "", tokenExpiresAt: 0 });
          const config = await getConfig();
          const activeRules = await chrome.declarativeNetRequest.getDynamicRules();
          sendResponse({
            ok: true,
            ...buildPublicStatus(config, activeRules.length),
          });
          break;
        }

        case "PANDIRECT_LIST_FILES": {
          const result = await listDirectoryFiles(message.dir);
          sendResponse({ ok: true, ...result });
          break;
        }

        case "PANDIRECT_LIST_FOLDER_RECURSIVE": {
          const result = await listFolderRecursive(message.path);
          sendResponse({ ok: true, ...result });
          break;
        }

        case "PANDIRECT_OPEN_FOLDER_DOWNLOADER": {
          const folderPath = message.path || "/";
          const mode = message.mode === "aria2" ? "aria2" : "browser";
          const targetUrl = chrome.runtime.getURL(
            `downloader/downloader.html?path=${encodeURIComponent(folderPath)}&mode=${mode}`
          );
          await chrome.tabs.create({ url: targetUrl });
          sendResponse({ ok: true });
          break;
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
          const config = await getConfig();
          if (!config.enabled) {
            throw new Error("PanDirect UA 规则当前已暂停，请先在插件弹窗中开启。");
          }
          await syncDnrRules();
          const resolved = await resolveDlinkForFsId(message.fsId);
          sendResponse({
            ok: true,
            fsId: resolved.fsId,
            filename: resolved.filename,
            size: resolved.size,
            url: resolved.url,
          });
          break;
        }

        case "PANDIRECT_PUSH_FSID_TO_ARIA2": {
          const resolved = await resolveDlinkForFsId(message.fsId);
          const result = await pushToAria2({
            url: resolved.url,
            filename: resolved.filename,
            relativePath: message.relativePath,
            config: resolved.config,
          });
          sendResponse({ ok: true, ...result });
          break;
        }

        case "PANDIRECT_DOWNLOAD_FSIDS": {
          const result = await downloadByFsIds({
            fsIds: message.fsIds || [],
            mode: message.mode,
            preferFrameDownload: Boolean(message.preferFrameDownload),
          });
          sendResponse({ ok: true, ...result });
          break;
        }

        case "PANDIRECT_DOWNLOAD": {
          const config = await getConfig();
          const mode = message.mode || "browser";
          const result =
            mode === "aria2"
              ? await pushToAria2({
                  url: message.url,
                  filename: message.filename,
                  relativePath: message.relativePath,
                  config,
                })
              : await startBrowserDownload({
                  url: message.url,
                  filename: message.filename,
                });
          sendResponse({ ok: true, ...result });
          break;
        }

        case "PANDIRECT_TEST_ARIA2": {
          const config = await getConfig();
          const rpcUrl = (message.aria2Url || config.aria2Url).trim();
          const secret =
            typeof message.aria2Secret === "string"
              ? message.aria2Secret.trim()
              : config.aria2Secret;
          const params = secret ? [`token:${secret}`] : [];
          const res = await fetch(rpcUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: `pandirect_ver_${Date.now()}`,
              method: "aria2.getVersion",
              params,
            }),
          });
          const data = await res.json();
          if (data.error) {
            throw new Error(data.error.message || "Aria2 鉴权失败");
          }
          sendResponse({ ok: true, version: data.result?.version || "unknown" });
          break;
        }

        default:
          sendResponse({ ok: false, error: "未知消息类型" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});
