import { defineProvider } from "../../base-provider.js";
import {
  sanitizeFilename,
  sanitizeRelativePath,
  sanitizeSegment,
} from "../../../core/utils.js";

const DEFAULT_BAIDU_CONFIG = {
  userAgent: "pan.baidu.com",
  appKey: "",
  accessToken: "",
  tokenExpiresAt: 0,
};

const OOB_REDIRECT_URI = "oob";
const OOB_SUCCESS_PREFIX = "https://openapi.baidu.com/oauth/2.0/login_success";
const PENDING_OAUTH_KEY = "pandirectPendingOAuth";

export function isAllowedBaiduDownloadUrl(rawUrl) {
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

export function buildBaiduModifyRequestHeaders(userAgent) {
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

export function formatBaiduApiError(errno, errmsg) {
  const map = {
    [-6]: "身份验证失败或应用无权访问该目录（errno=-6，请检查授权是否有效，或确认应用是否仅限 /apps/PanDirect 沙盒目录）",
    [-7]: "目录路径或参数无效（errno=-7）",
    [-9]: "文件或目录不存在（errno=-9）",
    [2]: "参数错误（errno=2）",
    [111]: "access_token 已过期（errno=111），请重新授权",
    [31034]: "接口请求频次超限（errno=31034），请稍后再试",
    [31326]: "命中防盗链校验（errno=31326），请确认 PanDirect UA 规则已开启",
  };
  return (
    map[errno] ||
    `百度接口返回错误（errno=${errno}${errmsg ? `, ${errmsg}` : ""}）`
  );
}

async function requireValidToken(ctx) {
  const config = await ctx.getConfig();
  if (!config.accessToken) {
    throw new Error("尚未完成百度授权，请点击右上角 PanDirect 图标完成一次授权。");
  }
  if (config.tokenExpiresAt && config.tokenExpiresAt <= Date.now()) {
    throw new Error("授权已过期，请在 PanDirect 弹窗中重新点击「百度授权」。");
  }
  return config;
}

async function completeOAuthFromUrl(finalUrl, appKey, windowId, ctx) {
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

  await ctx.setConfig({
    appKey,
    accessToken,
    tokenExpiresAt,
  });

  await ctx.syncDnrRules();
  return { tokenExpiresAt, expiresIn };
}

async function fetchBaiduFileMetas(fsIds, ctx) {
  const config = await requireValidToken(ctx);
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

export const baiduProvider = defineProvider({
  id: "baidu",
  name: "百度网盘",
  tier: "official",
  description: "基于百度网盘开放平台官方 OAuth（oob 国内直连）与 xpan OpenAPI",
  authType: "oauth_oob",
  dnrRuleIdBase: 1000,
  defaultConfig: DEFAULT_BAIDU_CONFIG,
  disallowedUrlMessage:
    "仅允许下载百度网盘 PCS 域名（*.pcs.baidu.com / *.baidupcs.com）的直链。",

  normalizeConfig(raw = {}) {
    return {
      userAgent:
        (raw.userAgent || DEFAULT_BAIDU_CONFIG.userAgent).trim() ||
        DEFAULT_BAIDU_CONFIG.userAgent,
      appKey: (raw.appKey || "").trim(),
      accessToken: (raw.accessToken || "").trim(),
      tokenExpiresAt: Number(raw.tokenExpiresAt) || 0,
    };
  },

  getPublicStatus(config) {
    const now = Date.now();
    const hasToken = Boolean(config.accessToken);
    const tokenValid =
      hasToken && (config.tokenExpiresAt === 0 || config.tokenExpiresAt > now);

    return {
      userAgent: config.userAgent,
      appKey: config.appKey,
      hasToken,
      tokenValid,
      tokenExpiresAt: config.tokenExpiresAt,
    };
  },

  isAllowedDownloadUrl: isAllowedBaiduDownloadUrl,

  getDownloadRequestHeaders(config) {
    return buildBaiduModifyRequestHeaders(config.userAgent);
  },

  getAria2Headers(config) {
    return [`User-Agent: ${config.userAgent}`];
  },

  getDnrRules(config, { ruleIdBase, resourceTypes }) {
    const modifyAction = {
      type: "modifyHeaders",
      requestHeaders: buildBaiduModifyRequestHeaders(config.userAgent),
    };

    // Match full host patterns (do NOT hardcode /rest/2.0/pcs/file; dlink uses /file/...)
    return [
      {
        id: ruleIdBase + 1,
        priority: 1,
        action: modifyAction,
        condition: {
          urlFilter: "||pcs.baidu.com/",
          resourceTypes,
        },
      },
      {
        id: ruleIdBase + 2,
        priority: 1,
        action: modifyAction,
        condition: {
          urlFilter: "||baidupcs.com/",
          resourceTypes,
        },
      },
      {
        id: ruleIdBase + 3,
        priority: 1,
        action: modifyAction,
        condition: {
          urlFilter: "||pcsdata.baidu.com/",
          resourceTypes,
        },
      },
    ];
  },

  /**
   * Standard explicit OAuth 2.0 implicit flow (response_type=token, redirect_uri=oob).
   * Uses Baidu's built-in China-direct login_success callback inside a normal browser
   * popup window so it reuses the user's logged-in Baidu session.
   */
  async startAuth(params, ctx) {
    const config = await ctx.getConfig();
    const appKey = (params?.appKey || config.appKey || "").trim();
    if (!appKey) {
      throw new Error("请先在扩展弹窗中填写百度开放平台应用的 AppKey。");
    }

    await ctx.setConfig({ appKey });

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
  },

  async logout(ctx) {
    await ctx.setConfig({ accessToken: "", tokenExpiresAt: 0 });
  },

  async onTabUpdated(tabId, changeInfo, tab, ctx) {
    const candidateUrl = changeInfo?.url || tab?.url || "";
    if (!candidateUrl || !candidateUrl.startsWith(OOB_SUCCESS_PREFIX)) return;

    const stored = await chrome.storage.session.get(PENDING_OAUTH_KEY);
    const pending = stored?.[PENDING_OAUTH_KEY];
    if (!pending) return;

    const isTargetTab =
      (pending.tabId && tabId === pending.tabId) ||
      (pending.windowId && tab?.windowId === pending.windowId);
    if (!isTargetTab) return;

    if (
      !candidateUrl.includes("access_token=") &&
      !candidateUrl.includes("error=")
    ) {
      return;
    }

    await completeOAuthFromUrl(
      candidateUrl,
      pending.appKey,
      pending.windowId,
      ctx
    );
  },

  async onWindowRemoved(removedWindowId) {
    const stored = await chrome.storage.session.get(PENDING_OAUTH_KEY);
    const pending = stored?.[PENDING_OAUTH_KEY];
    if (pending && pending.windowId === removedWindowId) {
      await chrome.storage.session.remove(PENDING_OAUTH_KEY);
    }
  },

  async listFiles(dir = "/", ctx) {
    const config = await requireValidToken(ctx);
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
      id: String(item.fs_id),
      fsId: String(item.fs_id),
      name: item.server_filename,
      path: item.path,
      size: Number(item.size) || 0,
      isdir: Boolean(item.isdir),
    }));

    return { dir: normalizedDir, files };
  },

  /**
   * Recursively list all files inside a folder via BFS over xpan/file?method=list.
   * Uses the standard file list API instead of multimedia?method=listall (which returns
   * errno=20020 on personal apps without extra capability grants).
   */
  async listFolderRecursive(folderPath, ctx) {
    const config = await requireValidToken(ctx);
    const normalized =
      folderPath && folderPath.startsWith("/")
        ? folderPath.replace(/\/+$/, "") || "/"
        : "/";

    const folderName =
      normalized === "/"
        ? "BaiduNetdisk"
        : sanitizeSegment(normalized.split("/").filter(Boolean).pop()) ||
          "Folder";

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
            id: String(item.fs_id),
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
      maxFiles: MAX_FILES,
      files: allFiles,
      totalSize: allFiles.reduce((sum, f) => sum + f.size, 0),
    };
  },

  async resolveDownloadTargets(itemIds, ctx) {
    const { config, list } = await fetchBaiduFileMetas(itemIds, ctx);

    return list.map((item) => {
      if (!item.dlink) {
        return {
          id: String(item.fs_id),
          fsId: String(item.fs_id),
          filename: item.filename,
          size: Number(item.size) || 0,
          url: null,
          error: "该条目未返回 dlink（可能是文件夹或无权限）",
        };
      }

      const sep = item.dlink.includes("?") ? "&" : "?";
      const fullUrl = `${item.dlink}${sep}access_token=${encodeURIComponent(
        config.accessToken
      )}`;

      return {
        id: String(item.fs_id),
        fsId: String(item.fs_id),
        filename: item.filename,
        size: Number(item.size) || 0,
        url: fullUrl,
      };
    });
  },

  async resolveStreamTarget(itemId, ctx) {
    const targets = await this.resolveDownloadTargets([itemId], ctx);
    const target = targets[0];
    if (!target || !target.url) {
      throw new Error(
        target?.error || "未获取到文件 dlink（可能无权限或为文件夹）"
      );
    }
    return target;
  },
});
