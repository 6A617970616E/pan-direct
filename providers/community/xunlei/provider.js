import { defineProvider } from "../../base-provider.js";
import { sanitizeFilename, sanitizeSegment } from "../../../core/utils.js";

export const DEFAULT_XUNLEI_USER_AGENT =
  "Dalvik/2.1.0 (Linux; U; Android 12; M2004J7AC Build/SP1A.210812.016)";

export const XUNLEI_SESSION_STORAGE_KEY = "xunlei_session";
export const XUNLEI_READ_SESSION_MESSAGE = "PANDIRECT_XUNLEI_READ_SESSION";

const XUNLEI_REFERER = "https://pan.xunlei.com/";
const XUNLEI_ORIGIN = "https://pan.xunlei.com";
const XUNLEI_API_BASE = "https://api-pan.xunlei.com/drive/v1";
const XUNLEI_WEB_URL = "https://pan.xunlei.com/";
const SESSION_FRESH_TTL_MS = 15000;

const ALLOWED_XUNLEI_DOWNLOAD_DOMAINS = [
  "xunlei.com",
  "xunlei.cn",
  "xunlei.net",
  "xunleix.com",
  "sdpan.cn",
  "sandai.net",
  "88cdn.com",
  "xycdn.com",
  "xlpan.com",
  "onethingpcs.com",
  "p2cdn.com",
  "kanimg.com",
];

const DEFAULT_XUNLEI_CONFIG = {
  userAgent: DEFAULT_XUNLEI_USER_AGENT,
  loggedIn: false,
  nickname: "",
  checkedAt: 0,
};

const FILE_LIST_FILTERS = JSON.stringify({
  phase: { eq: "PHASE_TYPE_COMPLETE" },
  trashed: { eq: false },
});

const TOKEN_EXPIRED_CODES = new Set([10, 16, 4121, 4122]);

export function normalizeXunleiDirId(dir) {
  if (!dir || typeof dir !== "string") return "";
  const trimmed = dir.trim();
  if (!trimmed || trimmed === "/" || trimmed === "0") return "";
  if (trimmed.startsWith("fid:")) {
    const rest = trimmed.slice(4).trim();
    return !rest || rest === "/" || rest === "0" ? "" : rest;
  }
  return trimmed;
}

export function isXunleiDirItem(item) {
  if (!item || typeof item !== "object") return false;
  return (
    item.kind === "drive#folder" ||
    item.kind === "folder" ||
    item.type === "folder" ||
    item.file_category === "FOLDER" ||
    item.is_dir === true ||
    item.isDir === true ||
    item.is_folder === true
  );
}

export function isAllowedXunleiDownloadUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_XUNLEI_DOWNLOAD_DOMAINS.some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

export function buildXunleiDownloadRequestHeaders(userAgent) {
  return [
    {
      header: "user-agent",
      operation: "set",
      value: userAgent,
    },
    {
      header: "referer",
      operation: "set",
      value: XUNLEI_REFERER,
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
      header: "origin",
      operation: "remove",
    },
  ];
}

function cleanHeaderValue(raw) {
  return String(raw ?? "")
    .replace(/[\r\n]+/g, "")
    .trim();
}

export function sanitizeXunleiSession(raw) {
  if (!raw || typeof raw !== "object") return null;

  let authorization = cleanHeaderValue(raw.authorization);
  if (!authorization && raw.accessToken) {
    const tokenType = cleanHeaderValue(raw.tokenType) || "Bearer";
    const accessToken = cleanHeaderValue(raw.accessToken);
    if (accessToken) {
      authorization = `${tokenType} ${accessToken}`;
    }
  }
  if (authorization && !/^(Bearer|Basic|Digest|Token)\s+/i.test(authorization)) {
    authorization = `Bearer ${authorization}`;
  }
  if (!authorization) return null;

  const captchaToken = cleanHeaderValue(raw.captchaToken);
  const deviceRaw = cleanHeaderValue(raw.deviceId);
  const deviceMatch = /([a-fA-F0-9]{32})/.exec(deviceRaw.split(",")[0] || "");
  const deviceId = deviceMatch ? deviceMatch[1] : deviceRaw;
  const clientId = cleanHeaderValue(raw.clientId);
  const userId = cleanHeaderValue(raw.userId);
  const nickname = cleanHeaderValue(raw.nickname);

  return {
    authorization,
    captchaToken,
    deviceId,
    clientId,
    userId,
    nickname,
    syncedAt: Number(raw.syncedAt) || Date.now(),
  };
}

export function extractXunleiDownloadLink(data) {
  if (!data || typeof data !== "object") {
    return {
      url: null,
      size: 0,
      error: "迅雷接口未返回有效文件详情。",
    };
  }

  const size = Number(data.size) || 0;

  if (typeof data.web_content_link === "string" && /^https?:\/\//i.test(data.web_content_link)) {
    return { url: data.web_content_link, size };
  }

  if (data.links && typeof data.links === "object") {
    const preferredKeys = [
      "application/octet-stream",
      "primary",
      "download",
      "download_url",
    ];
    for (const key of preferredKeys) {
      const entry = data.links[key];
      const candidate = typeof entry === "string" ? entry : entry?.url;
      if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) {
        return { url: candidate, size };
      }
    }
    for (const entry of Object.values(data.links)) {
      const candidate = typeof entry === "string" ? entry : entry?.url;
      if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) {
        return { url: candidate, size };
      }
    }
  }

  if (Array.isArray(data.medias) && data.medias.length > 0) {
    const originMedia = data.medias.find(
      (m) => m && (m.is_origin === true || m.category === "category_origin")
    );
    if (
      originMedia?.link?.url &&
      /^https?:\/\//i.test(originMedia.link.url) &&
      !originMedia.need_more_quota
    ) {
      return { url: originMedia.link.url, size };
    }

    const availableMedia = data.medias.find(
      (m) =>
        m?.link?.url &&
        /^https?:\/\//i.test(m.link.url) &&
        !m.need_more_quota &&
        (!Array.isArray(m.vip_types) || m.vip_types.length === 0)
    );
    if (availableMedia) {
      return {
        url: availableMedia.link.url,
        size,
        warning: availableMedia.media_name
          ? `当前返回媒体画质：${availableMedia.media_name}`
          : undefined,
      };
    }

    const anyMedia = data.medias.find(
      (m) => m?.link?.url && /^https?:\/\//i.test(m.link.url) && !m.need_more_quota
    );
    if (anyMedia) {
      return { url: anyMedia.link.url, size };
    }

    const vipHint =
      Array.isArray(originMedia?.vip_types) && originMedia.vip_types.length > 0
        ? originMedia.vip_types.join(" / ")
        : "迅雷会员";
    return {
      url: null,
      size,
      error: `该文件原画/原文件受限于 ${vipHint} 配额，暂无法获取直链。`,
    };
  }

  return {
    url: null,
    size,
    error: "该条目未返回可用下载直链（可能是文件夹、受限资源或会员专属文件）。",
  };
}

export function formatXunleiApiError(status, code, errorKey, description) {
  const numCode =
    code !== undefined && code !== null && code !== "" ? Number(code) : NaN;
  const errStr = String(errorKey || "");
  const descStr = String(description || "");
  const combined = `${errStr} ${descStr}`.trim();

  if (
    numCode === 9 ||
    /captcha_invalid|invalid.*captcha|captcha/i.test(combined)
  ) {
    return "迅雷验证码令牌（X-Captcha-Token）已失效，请在 pan.xunlei.com 页面刷新或切换任意目录后重试。";
  }

  if (
    status === 401 ||
    TOKEN_EXPIRED_CODES.has(numCode) ||
    /unauthenticated|invalid_token|token.*expired|unauthorized/i.test(combined)
  ) {
    return "尚未登录迅雷云盘或登录态已过期，请先在浏览器打开 pan.xunlei.com 登录并刷新页面后重试。";
  }

  if (/review_panel/i.test(combined)) {
    return "迅雷账号触发安全验证，请先在 pan.xunlei.com 完成验证后重试。";
  }

  if (
    status === 404 ||
    /file_not_found|not_found/i.test(combined)
  ) {
    return "目标迅雷文件或文件夹不存在（可能已被移动或删除）。";
  }

  if (status === 429 || /too_many_requests|rate_limit/i.test(combined)) {
    return "迅雷接口请求过于频繁（HTTP 429），请稍后再试。";
  }

  if (status === 403) {
    return `迅雷接口拒绝访问（HTTP 403${combined ? `，${combined}` : ""}），请确认已在 pan.xunlei.com 正常登录。`;
  }

  return `迅雷接口返回错误（status=${status ?? "?"}, code=${
    code ?? "?"
  }${combined ? `, ${combined}` : ""}）`;
}

function isRetryableAuthOrCaptchaError(err) {
  if (!err) return false;
  if (err.status === 401 || err.status === 403) return true;
  const numCode = Number(err.code);
  if (numCode === 9 || TOKEN_EXPIRED_CODES.has(numCode)) return true;
  const key = `${err.errorKey || ""} ${err.rawDescription || ""}`;
  return /captcha_invalid|unauthenticated|invalid_token|token.*expired/i.test(key);
}

function isTrustedXunleiOrigin(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "https:" && parsed.hostname === "pan.xunlei.com";
  } catch {
    return false;
  }
}

async function readStoredSession() {
  if (typeof chrome === "undefined" || !chrome.storage?.session?.get) {
    return null;
  }
  try {
    const data = await chrome.storage.session.get([XUNLEI_SESSION_STORAGE_KEY]);
    return sanitizeXunleiSession(data?.[XUNLEI_SESSION_STORAGE_KEY]);
  } catch {
    return null;
  }
}

async function writeStoredSession(session) {
  if (typeof chrome === "undefined" || !chrome.storage?.session) {
    return;
  }
  try {
    if (!session) {
      await chrome.storage.session.remove?.([XUNLEI_SESSION_STORAGE_KEY]);
    } else {
      await chrome.storage.session.set?.({
        [XUNLEI_SESSION_STORAGE_KEY]: session,
      });
    }
  } catch {
    // non-fatal
  }
}

async function queryLiveSessionFromXunleiTabs() {
  if (
    typeof chrome === "undefined" ||
    typeof chrome.tabs?.query !== "function" ||
    typeof chrome.tabs?.sendMessage !== "function"
  ) {
    return null;
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://pan.xunlei.com/*" });
  } catch {
    return null;
  }
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return null;
  }

  // Prefer the active tab first so we read the most up-to-date localStorage
  const orderedTabs = [...tabs].sort(
    (a, b) => Number(Boolean(b?.active)) - Number(Boolean(a?.active))
  );

  for (const tab of orderedTabs) {
    if (tab?.id === undefined || tab?.id === null) continue;
    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: XUNLEI_READ_SESSION_MESSAGE,
      });
      const sanitized = sanitizeXunleiSession(res?.session || res);
      if (sanitized) {
        return sanitized;
      }
    } catch {
      // Tab may not have content script loaded yet (e.g. opened prior to extension reload)
    }
  }

  return null;
}

async function resolveXunleiSession(ctx, { forceLiveTab = false } = {}) {
  const cached = await readStoredSession();

  if (
    !forceLiveTab &&
    cached &&
    Date.now() - cached.syncedAt < SESSION_FRESH_TTL_MS
  ) {
    return cached;
  }

  const live = await queryLiveSessionFromXunleiTabs();
  if (live) {
    await writeStoredSession(live);
    if (ctx && typeof ctx.setConfig === "function") {
      const displayNick =
        live.nickname || (live.userId ? `UID ${live.userId}` : "");
      try {
        await ctx.setConfig({
          loggedIn: true,
          ...(displayNick ? { nickname: displayNick } : {}),
          checkedAt: Date.now(),
        });
      } catch {
        // non-fatal
      }
    }
    return live;
  }

  return cached;
}

function buildXunleiApiHeaders(session) {
  const headers = {
    Authorization: session.authorization,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
  };
  if (session.captchaToken) {
    headers["X-Captcha-Token"] = session.captchaToken;
  }
  if (session.deviceId) {
    headers["X-Device-Id"] = session.deviceId;
  }
  if (session.clientId) {
    headers["X-Client-Id"] = session.clientId;
  }
  return headers;
}

function makeXunleiApiError({ status, code, errorKey, description }) {
  const err = new Error(
    formatXunleiApiError(status, code, errorKey, description)
  );
  err.status = status;
  err.code = code;
  err.errorKey = errorKey;
  err.rawDescription = description;
  return err;
}

async function parseXunleiJsonResponse(res, label) {
  let data;
  try {
    data = await res.json();
  } catch {
    throw makeXunleiApiError({
      status: res.status,
      description: `${label}返回非 JSON 数据（HTTP ${res.status}）`,
    });
  }

  const hasApiError =
    !res.ok ||
    (data?.error && data.error !== "success") ||
    (data?.error_code !== undefined &&
      data.error_code !== null &&
      String(data.error_code) !== "0" &&
      data.error_code !== "");

  if (hasApiError) {
    throw makeXunleiApiError({
      status: res.status,
      code: data?.error_code ?? data?.code,
      errorKey: data?.error,
      description:
        data?.error_description || data?.message || data?.errmsg || "",
    });
  }

  return data;
}

async function xunleiApiGetJson(url, ctx, label, { allowRetry = true } = {}) {
  const session = await resolveXunleiSession(ctx, { forceLiveTab: false });
  if (!session) {
    throw new Error(
      "未检测到迅雷云盘登录会话，请先在浏览器打开并登录 pan.xunlei.com（若已打开请刷新页面）后重试。"
    );
  }

  const execute = async (activeSession) => {
    const res = await fetch(url, {
      method: "GET",
      credentials: "omit",
      headers: buildXunleiApiHeaders(activeSession),
    });
    return parseXunleiJsonResponse(res, label);
  };

  try {
    return await execute(session);
  } catch (err) {
    if (!allowRetry || !isRetryableAuthOrCaptchaError(err)) {
      throw err;
    }

    const refreshed = await resolveXunleiSession(ctx, { forceLiveTab: true });
    if (
      refreshed &&
      (refreshed.authorization !== session.authorization ||
        refreshed.captchaToken !== session.captchaToken)
    ) {
      return execute(refreshed);
    }

    throw err;
  }
}

async function fetchXunleiFilesPage({ parentId, pageToken = "", limit = 100 }, ctx) {
  const url = new URL(`${XUNLEI_API_BASE}/files`);
  url.searchParams.set("space", "");
  url.searchParams.set("__type", "drive");
  url.searchParams.set("refresh", "true");
  url.searchParams.set("__sync", "true");
  url.searchParams.set("parent_id", parentId);
  url.searchParams.set("page_token", pageToken);
  url.searchParams.set("with_audit", "true");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("filters", FILE_LIST_FILTERS);

  return xunleiApiGetJson(url.toString(), ctx, "读取迅雷目录列表");
}

async function fetchXunleiFileInfo(fileId, ctx, { usage = "PLAY" } = {}) {
  const url = new URL(
    `${XUNLEI_API_BASE}/files/${encodeURIComponent(fileId)}`
  );
  url.searchParams.set("space", "");
  if (usage) {
    url.searchParams.set("usage", usage);
  }
  return xunleiApiGetJson(url.toString(), ctx, "获取迅雷文件详情");
}

async function resolveSingleXunleiFileTarget(fileId, ctx) {
  let info = await fetchXunleiFileInfo(fileId, ctx, { usage: "PLAY" });
  if (isXunleiDirItem(info)) {
    return {
      id: String(info.id || fileId),
      fsId: String(info.id || fileId),
      filename: info.name || fileId,
      size: Number(info.size) || 0,
      url: null,
      error: "该条目为文件夹，请使用整文件夹下载功能。",
    };
  }

  let linkInfo = extractXunleiDownloadLink(info);

  // Fallback to CONSUME if PLAY unexpectedly returned no download URL
  if (!linkInfo.url) {
    try {
      const consumeInfo = await fetchXunleiFileInfo(fileId, ctx, {
        usage: "CONSUME",
      });
      const consumeLink = extractXunleiDownloadLink(consumeInfo);
      if (consumeLink.url) {
        info = consumeInfo;
        linkInfo = consumeLink;
      }
    } catch {
      // keep initial PLAY diagnostic error
    }
  }

  const id = String(info?.id || fileId);
  return {
    id,
    fsId: id,
    filename: info?.name || fileId,
    size: linkInfo.size || Number(info?.size) || 0,
    url: linkInfo.url,
    ...(linkInfo.warning ? { warning: linkInfo.warning } : {}),
    ...(linkInfo.url ? {} : { error: linkInfo.error }),
  };
}

export const xunleiProvider = defineProvider({
  id: "xunlei",
  name: "迅雷云盘",
  tier: "community",
  description:
    "社区实验性迅雷云盘适配器：复用浏览器已登录 pan.xunlei.com 会话，获取单文件与整文件夹直链",
  authType: "browser_session",
  dnrRuleIdBase: 3000,
  downloadCredentials: "omit",
  contentScriptDomains: ["pan.xunlei.com"],
  defaultConfig: DEFAULT_XUNLEI_CONFIG,
  disallowedUrlMessage:
    "仅允许下载迅雷云盘官方 CDN 域名（*.xunlei.com / *.sdpan.cn / *.sandai.net / *.88cdn.com / *.xycdn.com 等）的直链。",

  normalizeConfig(raw = {}) {
    return {
      userAgent:
        (raw.userAgent || DEFAULT_XUNLEI_USER_AGENT).trim() ||
        DEFAULT_XUNLEI_USER_AGENT,
      loggedIn: Boolean(raw.loggedIn),
      nickname: (raw.nickname || "").trim(),
      checkedAt: Number(raw.checkedAt) || 0,
    };
  },

  getPublicStatus(config) {
    return {
      userAgent: config.userAgent,
      loggedIn: Boolean(config.loggedIn),
      nickname: config.nickname || "",
      checkedAt: Number(config.checkedAt) || 0,
    };
  },

  isAllowedDownloadUrl: isAllowedXunleiDownloadUrl,

  getDownloadRequestHeaders(config) {
    return buildXunleiDownloadRequestHeaders(config.userAgent);
  },

  getAria2Headers(config) {
    return [
      `User-Agent: ${config.userAgent}`,
      `Referer: ${XUNLEI_REFERER}`,
    ];
  },

  getDnrRules(config, { ruleIdBase, resourceTypes, extensionId } = {}) {
    const apiResourceTypes = ["xmlhttprequest", "other"];
    const nonMainFrameResourceTypes = Array.isArray(resourceTypes)
      ? resourceTypes.filter((t) => t !== "main_frame")
      : ["sub_frame", "xmlhttprequest", "media", "other"];
    const excludedWebPages = ["pan.xunlei.com"];
    const downloadMethods = ["get", "head"];
    const downloadHeaders = buildXunleiDownloadRequestHeaders(config.userAgent);
    const effectiveExtId =
      extensionId ||
      (typeof chrome !== "undefined" && chrome.runtime?.id
        ? chrome.runtime.id
        : "");
    // Shared commercial CDNs (e.g. 88cdn.com / p2cdn.com / xycdn.com) are used by
    // unrelated websites; restrict base rules strictly to extension-initiated fetch/streaming
    // calls (hidden iframe downloads use per-download scoped session rules instead).
    const sharedCdnScope = effectiveExtId
      ? { initiatorDomains: [effectiveExtId] }
      : { excludedInitiatorDomains: excludedWebPages };

    return [
      // Priority 1: supply Origin/Referer for extension-initiated Xunlei API calls
      {
        id: ruleIdBase + 1,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "origin",
              operation: "set",
              value: XUNLEI_ORIGIN,
            },
            {
              header: "referer",
              operation: "set",
              value: XUNLEI_REFERER,
            },
          ],
        },
        condition: {
          urlFilter: "||api-pan.xunlei.com/drive/v1/",
          excludedInitiatorDomains: excludedWebPages,
          resourceTypes: apiResourceTypes,
        },
      },
      // Priority 1: inject download UA + Referer on dedicated Xunlei download hosts
      // (exclude pan.xunlei.com & non-GET/HEAD so web uploads/previews are untouched;
      // hidden iframe downloads use exact-URL priority-2 session rules instead).
      {
        id: ruleIdBase + 2,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: downloadHeaders,
        },
        condition: {
          urlFilter: "||sdpan.cn/",
          excludedInitiatorDomains: excludedWebPages,
          requestMethods: downloadMethods,
          resourceTypes: nonMainFrameResourceTypes,
        },
      },
      {
        id: ruleIdBase + 3,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: downloadHeaders,
        },
        condition: {
          urlFilter: ".xunlei.com/download/",
          excludedInitiatorDomains: excludedWebPages,
          requestMethods: downloadMethods,
          resourceTypes: nonMainFrameResourceTypes,
        },
      },
      {
        id: ruleIdBase + 4,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: downloadHeaders,
        },
        condition: {
          urlFilter: "||sandai.net/",
          ...sharedCdnScope,
          requestMethods: downloadMethods,
          resourceTypes: apiResourceTypes,
        },
      },
      {
        id: ruleIdBase + 5,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: downloadHeaders,
        },
        condition: {
          urlFilter: "||xycdn.com/",
          ...sharedCdnScope,
          requestMethods: downloadMethods,
          resourceTypes: apiResourceTypes,
        },
      },
      {
        id: ruleIdBase + 6,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: downloadHeaders,
        },
        condition: {
          urlFilter: "||88cdn.com/",
          ...sharedCdnScope,
          requestMethods: downloadMethods,
          resourceTypes: apiResourceTypes,
        },
      },
      {
        id: ruleIdBase + 7,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: downloadHeaders,
        },
        condition: {
          urlFilter: "||xlpan.com/",
          ...sharedCdnScope,
          requestMethods: downloadMethods,
          resourceTypes: apiResourceTypes,
        },
      },
      {
        id: ruleIdBase + 8,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: downloadHeaders,
        },
        condition: {
          urlFilter: "||onethingpcs.com/",
          ...sharedCdnScope,
          requestMethods: downloadMethods,
          resourceTypes: apiResourceTypes,
        },
      },
      {
        id: ruleIdBase + 9,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: downloadHeaders,
        },
        condition: {
          urlFilter: "||p2cdn.com/",
          ...sharedCdnScope,
          requestMethods: downloadMethods,
          resourceTypes: apiResourceTypes,
        },
      },
    ];
  },

  /**
   * Receives ephemeral session tokens from pan.xunlei.com content script and keeps them
   * strictly in chrome.storage.session (never written to chrome.storage.local).
   */
  async syncSession(rawSession, ctx, sender = {}) {
    if (
      typeof chrome !== "undefined" &&
      chrome.runtime?.id &&
      sender?.id !== chrome.runtime.id
    ) {
      throw new Error("未授权的迅雷会话同步来源");
    }
    const senderUrl = sender?.tab?.url || sender?.url || "";
    if (!senderUrl || !isTrustedXunleiOrigin(senderUrl)) {
      throw new Error("未授权的迅雷会话同步来源");
    }

    const sanitized = sanitizeXunleiSession(rawSession);
    if (!sanitized) {
      await writeStoredSession(null);
      await ctx.setConfig({
        loggedIn: false,
        nickname: "",
        checkedAt: Date.now(),
      });
      return { loggedIn: false, synced: false };
    }

    await writeStoredSession(sanitized);
    const displayNick =
      sanitized.nickname || (sanitized.userId ? `UID ${sanitized.userId}` : "");
    await ctx.setConfig({
      loggedIn: true,
      ...(displayNick ? { nickname: displayNick } : {}),
      checkedAt: Date.now(),
    });
    return { loggedIn: true, synced: true, nickname: displayNick };
  },

  async startAuth(params, ctx) {
    await ctx.syncDnrRules();

    const session = await resolveXunleiSession(ctx, { forceLiveTab: true });
    if (!session) {
      await ctx.setConfig({
        loggedIn: false,
        nickname: "",
        checkedAt: Date.now(),
      });
      if (params?.openLoginIfNeeded !== false) {
        await chrome.tabs.create({ url: XUNLEI_WEB_URL });
        return {
          loggedIn: false,
          nickname: "",
          openedLoginTab: true,
        };
      }
      return {
        loggedIn: false,
        nickname: "",
        openedLoginTab: false,
      };
    }

    try {
      await fetchXunleiFilesPage({ parentId: "", pageToken: "", limit: 1 }, ctx);
      const activeSession = (await readStoredSession()) || session;
      const displayNick =
        activeSession.nickname ||
        (activeSession.userId ? `UID ${activeSession.userId}` : "");
      await ctx.setConfig({
        loggedIn: true,
        nickname: displayNick,
        checkedAt: Date.now(),
      });
      return {
        loggedIn: true,
        nickname: displayNick,
        openedLoginTab: false,
      };
    } catch (err) {
      const numCode = Number(err?.code);
      const isCaptchaErr =
        numCode === 9 || /captcha_invalid|captcha/i.test(err?.errorKey || "");
      if (isCaptchaErr) {
        throw err;
      }

      const isAuthErr =
        err?.status === 401 ||
        TOKEN_EXPIRED_CODES.has(numCode) ||
        /unauthenticated|invalid_token|token.*expired/i.test(
          `${err?.errorKey || ""} ${err?.rawDescription || ""}`
        );

      if (isAuthErr) {
        await writeStoredSession(null);
        await ctx.setConfig({
          loggedIn: false,
          nickname: "",
          checkedAt: Date.now(),
        });
        if (params?.openLoginIfNeeded !== false) {
          await chrome.tabs.create({ url: XUNLEI_WEB_URL });
          return {
            loggedIn: false,
            nickname: "",
            openedLoginTab: true,
          };
        }
        return {
          loggedIn: false,
          nickname: "",
          openedLoginTab: false,
        };
      }

      throw err;
    }
  },

  async logout(ctx) {
    await writeStoredSession(null);
    await ctx.setConfig({
      loggedIn: false,
      nickname: "",
      checkedAt: 0,
    });
  },

  async listFiles(dir = "0", ctx) {
    await ctx.syncDnrRules();
    const currentParentId = normalizeXunleiDirId(dir);
    const PAGE_SIZE = 100;
    const MAX_PAGES = 2; // up to 200 entries in drawer list, matching Baidu & Quark
    const rawItems = [];
    let pageToken = "";

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await fetchXunleiFilesPage(
        { parentId: currentParentId, pageToken, limit: PAGE_SIZE },
        ctx
      );
      const list = Array.isArray(data?.files) ? data.files : [];
      rawItems.push(...list);

      const nextToken = data?.next_page_token || "";
      if (!nextToken || nextToken === pageToken || list.length === 0) {
        break;
      }
      pageToken = nextToken;
    }

    let displayPath = "/";
    let parentDir = null;
    if (currentParentId !== "") {
      try {
        const info = await fetchXunleiFileInfo(currentParentId, ctx, {
          usage: "DISPLAY",
        });
        if (info?.name) {
          displayPath = `/${info.name}`;
        }
        const normalizedParent = normalizeXunleiDirId(info?.parent_id);
        parentDir = normalizedParent || "0";
      } catch {
        parentDir = "0";
      }
    }

    const activeItems = rawItems.filter((item) => item && item.trashed !== true);
    const folders = [];
    const regularFiles = [];

    for (const item of activeItems) {
      const id = String(item.id || "");
      if (!id) continue;
      const isdir = isXunleiDirItem(item);
      const entry = {
        id,
        fsId: id,
        name: item.name || id,
        path: id,
        size: Number(item.size) || 0,
        isdir,
      };
      if (isdir) {
        folders.push(entry);
      } else {
        regularFiles.push(entry);
      }
    }

    return {
      dir: currentParentId || "0",
      displayPath,
      parentDir,
      isRoot: currentParentId === "",
      files: [...folders, ...regularFiles],
    };
  },

  async listFolderRecursive(folderRef, ctx) {
    await ctx.syncDnrRules();
    const rootParentId = normalizeXunleiDirId(folderRef);

    let folderName = "XunleiNetdisk";
    let displayPath = "/";

    if (rootParentId !== "") {
      try {
        const info = await fetchXunleiFileInfo(rootParentId, ctx, {
          usage: "DISPLAY",
        });
        if (info?.name) {
          folderName = sanitizeSegment(info.name) || "XunleiFolder";
          displayPath = `/${info.name}`;
        } else {
          folderName = "XunleiFolder";
          displayPath = `/${rootParentId}`;
        }
      } catch {
        folderName = "XunleiFolder";
        displayPath = `/${rootParentId}`;
      }
    }

    const allFiles = [];
    const dirQueue = [{ id: rootParentId, relPrefix: folderName }];
    const visitedIds = new Set([rootParentId]);
    const PAGE_SIZE = 100;
    const MAX_DIRS = 500;
    const MAX_FILES = 10000;
    let dirsScanned = 0;
    let truncated = false;

    while (dirQueue.length > 0) {
      if (dirsScanned >= MAX_DIRS || allFiles.length >= MAX_FILES) {
        truncated = true;
        break;
      }

      const current = dirQueue.shift();
      dirsScanned++;

      let pageToken = "";
      while (true) {
        const data = await fetchXunleiFilesPage(
          { parentId: current.id, pageToken, limit: PAGE_SIZE },
          ctx
        );
        const list = Array.isArray(data?.files) ? data.files : [];
        if (list.length === 0) break;

        for (const item of list) {
          if (!item || item.trashed === true) continue;
          const id = String(item.id || "");
          if (!id) continue;

          if (isXunleiDirItem(item)) {
            if (!visitedIds.has(id)) {
              visitedIds.add(id);
              const safeDirName = sanitizeSegment(item.name) || id;
              dirQueue.push({
                id,
                relPrefix: `${current.relPrefix}/${safeDirName}`,
              });
            }
            continue;
          }

          if (allFiles.length >= MAX_FILES) {
            truncated = true;
            break;
          }

          const safeFileName = sanitizeFilename(item.name) || id;
          const relativePath = `${current.relPrefix}/${safeFileName}`;

          allFiles.push({
            id,
            fsId: id,
            name: item.name || id,
            path: id,
            relativePath,
            size: Number(item.size) || 0,
          });
        }

        const nextToken = data?.next_page_token || "";
        if (!nextToken || nextToken === pageToken || allFiles.length >= MAX_FILES) {
          break;
        }
        pageToken = nextToken;
      }
    }

    return {
      folderPath: rootParentId || "0",
      displayPath,
      folderName,
      dirsScanned,
      truncated,
      maxFiles: MAX_FILES,
      files: allFiles,
      totalSize: allFiles.reduce((sum, f) => sum + f.size, 0),
    };
  },

  async resolveDownloadTargets(itemIds, ctx) {
    const coreConfig = await ctx.getCoreConfig();
    if (!coreConfig.enabled) {
      throw new Error(
        "PanDirect 下载规则当前已暂停，请先在插件弹窗中开启后再试。"
      );
    }
    await ctx.syncDnrRules();

    const cleanIds = (itemIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean);

    if (cleanIds.length === 0) {
      throw new Error("未获取到有效的迅雷文件 ID。");
    }

    const CONCURRENCY = 4;
    const results = new Array(cleanIds.length);

    for (let i = 0; i < cleanIds.length; i += CONCURRENCY) {
      const batch = cleanIds.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (fileId) => {
          try {
            return await resolveSingleXunleiFileTarget(fileId, ctx);
          } catch (err) {
            if (cleanIds.length === 1) {
              throw err;
            }
            return {
              id: fileId,
              fsId: fileId,
              filename: fileId,
              size: 0,
              url: null,
              error: err?.message || String(err),
            };
          }
        })
      );
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    }

    return results;
  },

  async resolveStreamTarget(itemId, ctx) {
    const targets = await this.resolveDownloadTargets([itemId], ctx);
    const target = targets[0];
    if (!target || !target.url) {
      throw new Error(
        target?.error || "未获取到迅雷文件下载直链（可能无权限或为文件夹）"
      );
    }
    return target;
  },
});
