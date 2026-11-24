import { defineProvider } from "../../base-provider.js";
import { sanitizeFilename, sanitizeSegment } from "../../../core/utils.js";

export const DEFAULT_QUARK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.56 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch";

const QUARK_REFERER = "https://pan.quark.cn/";
const QUARK_ORIGIN = "https://pan.quark.cn";
const QUARK_API_BASE = "https://drive-pc.quark.cn/1/clouddrive";
const QUARK_ACCOUNT_INFO_URL = "https://pan.quark.cn/account/info";
const QUARK_WEB_URL = "https://pan.quark.cn/list#/list/all";

const DEFAULT_QUARK_CONFIG = {
  userAgent: DEFAULT_QUARK_USER_AGENT,
  aria2Cookie: "",
  loggedIn: false,
  nickname: "",
  checkedAt: 0,
};

export function normalizeQuarkDirId(dir) {
  if (!dir || typeof dir !== "string") return "0";
  const trimmed = dir.trim();
  if (!trimmed || trimmed === "/" || trimmed === "0") return "0";
  if (trimmed.startsWith("fid:")) {
    return trimmed.slice(4).trim() || "0";
  }
  return trimmed;
}

export function isQuarkDirItem(item) {
  if (typeof item?.dir === "boolean") return item.dir;
  if (typeof item?.file === "boolean") return !item.file;
  if (item?.file_type !== undefined && item?.file_type !== null) {
    return Number(item.file_type) === 0;
  }
  return false;
}

export function isAllowedQuarkDownloadUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return (
      host === "pds.quark.cn" ||
      host.endsWith(".pds.quark.cn") ||
      host === "quark.cn" ||
      host.endsWith(".quark.cn") ||
      host.endsWith(".uc.cn")
    );
  } catch {
    return false;
  }
}

export function buildQuarkDownloadRequestHeaders(userAgent) {
  return [
    {
      header: "user-agent",
      operation: "set",
      value: userAgent,
    },
    {
      header: "referer",
      operation: "set",
      value: QUARK_REFERER,
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

export function buildQuarkApiDownloadHeaders(userAgent) {
  return [
    {
      header: "user-agent",
      operation: "set",
      value: userAgent,
    },
    {
      header: "referer",
      operation: "set",
      value: QUARK_REFERER,
    },
    {
      header: "origin",
      operation: "set",
      value: QUARK_ORIGIN,
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
  ];
}

export function formatQuarkApiError(status, code, message) {
  const msgText = String(message || "");
  if (
    status === 401 ||
    code === 401 ||
    /require login|未登录|登录/i.test(msgText)
  ) {
    return "尚未登录夸克网盘或登录态已失效，请先在浏览器打开 pan.quark.cn 登录后重试。";
  }
  if (code === 23018) {
    return "触发夸克客户端下载限制（code=23018），请确认 PanDirect 开关已开启（DNR 客户端 UA 规则生效）后重试。";
  }
  if (code === 31001 || code === 41013 || status === 404) {
    return "目标文件或文件夹不存在（可能已被移动或删除）。";
  }
  if (code === 429 || status === 429) {
    return "夸克接口请求过于频繁（HTTP 429），请稍后再试。";
  }
  return `夸克接口返回错误（status=${status ?? "?"}, code=${code ?? "?"}${
    msgText ? `, ${msgText}` : ""
  }）`;
}

async function parseJsonSafe(res, label) {
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${label}返回非 JSON 数据（HTTP ${res.status}）`);
  }

  if (res.status === 401 || data?.status === 401) {
    throw new Error(
      formatQuarkApiError(
        data?.status ?? res.status,
        data?.code,
        data?.message || "require login"
      )
    );
  }

  if (!res.ok) {
    throw new Error(
      formatQuarkApiError(
        data?.status ?? res.status,
        data?.code,
        data?.message || `HTTP ${res.status}`
      )
    );
  }

  if (
    (typeof data?.status === "number" && data.status !== 200) ||
    (typeof data?.code === "number" && data.code !== 0)
  ) {
    throw new Error(
      formatQuarkApiError(data?.status, data?.code, data?.message)
    );
  }

  return data;
}

async function fetchQuarkFileInfo(fid) {
  const cleanFid = normalizeQuarkDirId(fid);
  if (cleanFid === "0") {
    return { fid: "0", file_name: "", pdir_fid: null };
  }

  const url = new URL(`${QUARK_API_BASE}/file/info`);
  url.searchParams.set("pr", "ucpro");
  url.searchParams.set("fr", "pc");
  url.searchParams.set("uc_param_str", "");
  url.searchParams.set("fid", cleanFid);
  url.searchParams.set("_fetch_full_path", "0");

  const res = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json, text/plain, */*",
    },
  });

  const data = await parseJsonSafe(res, "获取夸克文件信息");
  return data?.data || null;
}

async function fetchQuarkSortPage({ pdirFid, page, size, sort }) {
  const url = new URL(`${QUARK_API_BASE}/file/sort`);
  url.searchParams.set("pr", "ucpro");
  url.searchParams.set("fr", "pc");
  url.searchParams.set("uc_param_str", "");
  url.searchParams.set("pdir_fid", pdirFid);
  url.searchParams.set("_page", String(page));
  url.searchParams.set("_size", String(size));
  url.searchParams.set("_fetch_total", "1");
  url.searchParams.set("_fetch_sub_dirs", "0");
  url.searchParams.set("_sort", sort);

  const res = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json, text/plain, */*",
    },
  });

  return parseJsonSafe(res, "读取夸克目录列表");
}

async function checkQuarkSession() {
  const url = new URL(QUARK_ACCOUNT_INFO_URL);
  url.searchParams.set("fr", "pc");
  url.searchParams.set("platform", "pc");

  const res = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json, text/plain, */*",
    },
  });

  if (!res.ok) {
    return { loggedIn: false, nickname: "" };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { loggedIn: false, nickname: "" };
  }

  const nickname = data?.data?.nickname || data?.data?.mobilekps || "";
  if (data?.data && nickname) {
    return { loggedIn: true, nickname: String(nickname) };
  }
  return { loggedIn: false, nickname: "" };
}

export function sanitizeCookieInput(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw
    .replace(/[\r\n]+/g, " ")
    .trim()
    .replace(/^cookie\s*:\s*/i, "")
    .trim();
}

export function isTrustedLocalAria2Url(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".local")
    ) {
      return true;
    }
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    const m172 = host.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
    if (m172) {
      const second = Number(m172[1]);
      if (second >= 16 && second <= 31) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function compareCookiePriority(a, b) {
  const domA = String(a?.domain || "").replace(/^\./, "").length;
  const domB = String(b?.domain || "").replace(/^\./, "").length;
  if (domB !== domA) return domB - domA;

  const pathA = String(a?.path || "").length;
  const pathB = String(b?.path || "").length;
  if (pathB !== pathA) return pathB - pathA;

  const expA = Number(a?.expirationDate) || 0;
  const expB = Number(b?.expirationDate) || 0;
  return expB - expA;
}

function isCookieExpired(cookie, nowSec) {
  return (
    typeof cookie?.expirationDate === "number" &&
    cookie.expirationDate > 0 &&
    cookie.expirationDate <= nowSec
  );
}

function sanitizeCookiePair(name, value) {
  const cleanName = String(name || "").replace(/[\r\n;=]/g, "").trim();
  const cleanVal = String(value ?? "").replace(/[\r\n]+/g, "").trim();
  if (!cleanName) return null;
  return { name: cleanName, value: cleanVal, pair: `${cleanName}=${cleanVal}` };
}

/**
 * Selects exact-scope Quark cookies for Aria2 download requests without pulling in
 * unrelated *.quark.cn subdomains (such as pan.quark.cn or ai.quark.cn).
 * Prioritizes:
 * 1. Freshly rotated `__puus` observed during `POST /1/clouddrive/file/download`
 * 2. Most-specific domain / longest path / latest expirationDate matching the download URL
 * 3. Newer `__puus` from `drive-pc.quark.cn` if rotated host-only
 */
export function selectQuarkCookiesForUrl({
  targetCookies = [],
  apiCookies = [],
  fallbackPuusCookies = [],
  rotatedPuus = "",
  nowSec = Date.now() / 1000,
} = {}) {
  const filterAndSort = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((c) => c && !isCookieExpired(c, nowSec))
      .sort(compareCookiePriority);

  const validTarget = filterAndSort(targetCookies);
  const validApi = filterAndSort(apiCookies);
  const validFallbackPuus = filterAndSort(fallbackPuusCookies);

  const byName = new Map();
  let targetPuusCookie = null;

  // Match Chrome's exact cookie scope for the download URL (fall back to API URL only if empty)
  const baseCookies = validTarget.length > 0 ? validTarget : validApi;
  for (const c of baseCookies) {
    const entry = sanitizeCookiePair(c.name, c.value);
    if (!entry || byName.has(entry.name)) continue;
    byName.set(entry.name, entry.pair);
    if (entry.name === "__puus") {
      targetPuusCookie = c;
    }
  }

  // If drive-pc.quark.cn holds a strictly newer __puus (or target had none), upgrade __puus
  const apiPuusCookie = validApi.find(
    (c) => String(c?.name || "").trim() === "__puus"
  );
  if (apiPuusCookie) {
    const targetExp = Number(targetPuusCookie?.expirationDate) || 0;
    const apiExp = Number(apiPuusCookie.expirationDate) || 0;
    if (!targetPuusCookie || (apiExp > 0 && apiExp > targetExp)) {
      const entry = sanitizeCookiePair("__puus", apiPuusCookie.value);
      if (entry) {
        byName.set("__puus", entry.pair);
      }
    }
  }

  // Highest priority: exact __puus rotated by the file/download call that minted this URL
  const cleanRotated = String(rotatedPuus || "").replace(/[\r\n]+/g, "").trim();
  if (cleanRotated) {
    byName.set("__puus", `__puus=${cleanRotated}`);
  }

  // Last-resort fallback: ONLY __puus from quark.cn if still missing
  if (!byName.has("__puus") && validFallbackPuus.length > 0) {
    const bestPuus = validFallbackPuus.find(
      (c) => String(c?.name || "").trim() === "__puus"
    );
    if (bestPuus) {
      const entry = sanitizeCookiePair("__puus", bestPuus.value);
      if (entry) {
        byName.set("__puus", entry.pair);
      }
    }
  }

  return Array.from(byName.values()).join("; ");
}

async function flushQuarkPuusCookie() {
  try {
    const flushUrl = `${QUARK_API_BASE}/auth/pc/flush?pr=ucpro&fr=pc`;
    await fetch(flushUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json, text/plain, */*",
      },
    });
  } catch {
    // non-fatal; caller re-checks cookie jar
  }
}

/**
 * Reads active Quark session cookies from the browser cookie jar on-demand
 * exclusively for forwarding to the user's local Aria2 RPC. Never persisted or logged.
 */
async function readQuarkSessionCookieHeader(targetUrl, { rotatedPuus = "" } = {}) {
  if (typeof chrome === "undefined" || !chrome.cookies?.getAll) {
    return "";
  }

  let targetCookies = [];
  if (targetUrl) {
    try {
      targetCookies = await chrome.cookies.getAll({ url: targetUrl });
    } catch {
      targetCookies = [];
    }
  }

  let apiCookies = [];
  try {
    apiCookies = await chrome.cookies.getAll({
      url: `${QUARK_API_BASE}/file/download`,
    });
  } catch {
    apiCookies = [];
  }

  let header = selectQuarkCookiesForUrl({
    targetCookies,
    apiCookies,
    rotatedPuus,
  });

  if (!/(?:^|;\s*)__puus=/.test(header)) {
    let fallbackPuusCookies = [];
    try {
      fallbackPuusCookies = await chrome.cookies.getAll({
        domain: "quark.cn",
        name: "__puus",
      });
    } catch {
      fallbackPuusCookies = [];
    }
    header = selectQuarkCookiesForUrl({
      targetCookies,
      apiCookies,
      fallbackPuusCookies,
      rotatedPuus,
    });
  }

  return header;
}

export const quarkProvider = defineProvider({
  id: "quark",
  name: "夸克网盘",
  tier: "community",
  description:
    "社区实验性夸克网盘适配器：复用浏览器已登录会话，通过 DNR 注入客户端 UA 获取单文件与整文件夹直链",
  authType: "browser_session",
  dnrRuleIdBase: 2000,
  downloadCredentials: "include",
  defaultConfig: DEFAULT_QUARK_CONFIG,
  disallowedUrlMessage:
    "仅允许下载夸克网盘域名（*.pds.quark.cn / *.quark.cn / *.uc.cn）的直链。",

  normalizeConfig(raw = {}) {
    return {
      userAgent:
        (raw.userAgent || DEFAULT_QUARK_USER_AGENT).trim() ||
        DEFAULT_QUARK_USER_AGENT,
      aria2Cookie: sanitizeCookieInput(raw.aria2Cookie || ""),
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
      hasAria2Cookie: Boolean(config.aria2Cookie),
    };
  },

  isAllowedDownloadUrl: isAllowedQuarkDownloadUrl,

  getDownloadRequestHeaders(config) {
    return buildQuarkDownloadRequestHeaders(config.userAgent);
  },

  async getAria2Headers(config, { url, coreConfig, target } = {}) {
    const headers = [
      `User-Agent: ${config.userAgent}`,
      `Referer: ${QUARK_REFERER}`,
    ];

    let cookieHeader = sanitizeCookieInput(config.aria2Cookie || "");

    if (!cookieHeader) {
      const rpcUrl = coreConfig?.aria2Url || "http://localhost:6800/jsonrpc";
      if (!isTrustedLocalAria2Url(rpcUrl)) {
        throw new Error(
          `安全保护：拒绝将浏览器夸克会话 Cookie 自动发送至非本机/局域网 Aria2 地址（${rpcUrl}）。如需使用远程 Aria2，请手动填写 Cookie 或改用本机 Aria2。`
        );
      }

      const rotatedPuus = target?._rotatedPuus || "";
      cookieHeader = await readQuarkSessionCookieHeader(url, { rotatedPuus });

      if (!cookieHeader || !/(?:^|;\s*)__puus=/.test(cookieHeader)) {
        await flushQuarkPuusCookie();
        cookieHeader = await readQuarkSessionCookieHeader(url, { rotatedPuus });
      }

      if (!cookieHeader || !/(?:^|;\s*)__puus=/.test(cookieHeader)) {
        throw new Error(
          "未读取到有效的夸克登录 Cookie（缺少 __puus），请确认已在当前浏览器登录 pan.quark.cn，并刷新扩展授权 cookies 权限后重试。"
        );
      }
    }

    headers.push(`Cookie: ${cookieHeader}`);
    return headers;
  },

  getDnrRules(config, { ruleIdBase, resourceTypes }) {
    const apiResourceTypes = ["xmlhttprequest", "other"];
    const excludedWebPages = ["pan.quark.cn", "drive.quark.cn"];

    return [
      // Priority 2: inject Quark desktop client UA on file/download to bypass web code=23018
      {
        id: ruleIdBase + 1,
        priority: 2,
        action: {
          type: "modifyHeaders",
          requestHeaders: buildQuarkApiDownloadHeaders(config.userAgent),
        },
        condition: {
          urlFilter: "||drive-pc.quark.cn/1/clouddrive/file/download",
          excludedInitiatorDomains: excludedWebPages,
          resourceTypes: apiResourceTypes,
        },
      },
      // Priority 1: supply required Referer/Origin for extension-initiated Quark API calls
      {
        id: ruleIdBase + 2,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "referer",
              operation: "set",
              value: QUARK_REFERER,
            },
            {
              header: "origin",
              operation: "set",
              value: QUARK_ORIGIN,
            },
          ],
        },
        condition: {
          urlFilter: "||drive-pc.quark.cn/1/clouddrive/",
          excludedInitiatorDomains: excludedWebPages,
          resourceTypes: apiResourceTypes,
        },
      },
      // Priority 1: inject desktop UA + Referer on Quark download CDN nodes (including hidden iframe)
      {
        id: ruleIdBase + 3,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: buildQuarkDownloadRequestHeaders(config.userAgent),
        },
        condition: {
          urlFilter: "||pds.quark.cn/",
          resourceTypes,
        },
      },
      // Priority 1: also cover *.drive.quark.cn regional download nodes (e.g. dl-pc-sz.drive.quark.cn)
      {
        id: ruleIdBase + 5,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: buildQuarkDownloadRequestHeaders(config.userAgent),
        },
        condition: {
          urlFilter: ".drive.quark.cn/",
          requestDomains: ["drive.quark.cn"],
          resourceTypes,
        },
      },
      // Priority 1: supply Referer when checking account/info from extension SW
      {
        id: ruleIdBase + 4,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            {
              header: "referer",
              operation: "set",
              value: QUARK_REFERER,
            },
          ],
        },
        condition: {
          urlFilter: "||pan.quark.cn/account/info",
          excludedInitiatorDomains: excludedWebPages,
          resourceTypes: apiResourceTypes,
        },
      },
    ];
  },

  /**
   * Checks whether the current browser profile has an active pan.quark.cn session.
   * Never reads or exports cookies via chrome.cookies; relies strictly on credentials: "include".
   */
  async startAuth(params, ctx) {
    await ctx.syncDnrRules();
    const session = await checkQuarkSession();
    await ctx.setConfig({
      loggedIn: session.loggedIn,
      nickname: session.nickname,
      checkedAt: Date.now(),
    });

    if (!session.loggedIn && params?.openLoginIfNeeded !== false) {
      await chrome.tabs.create({ url: QUARK_WEB_URL });
      return {
        loggedIn: false,
        nickname: "",
        openedLoginTab: true,
      };
    }

    return {
      loggedIn: session.loggedIn,
      nickname: session.nickname,
      openedLoginTab: false,
    };
  },

  async logout(ctx) {
    await ctx.setConfig({
      loggedIn: false,
      nickname: "",
      checkedAt: 0,
      aria2Cookie: "",
    });
  },

  async listFiles(dir = "0", ctx) {
    await ctx.syncDnrRules();
    const currentFid = normalizeQuarkDirId(dir);
    const PAGE_SIZE = 100;
    const MAX_PAGES = 2; // up to 200 entries in drawer list, matching Baidu
    const items = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await fetchQuarkSortPage({
        pdirFid: currentFid,
        page,
        size: PAGE_SIZE,
        sort: "file_type:asc,updated_at:desc",
      });

      const list = data?.data?.list || [];
      items.push(...list);

      const total = Number(data?.metadata?._total) || 0;
      if (list.length < PAGE_SIZE || (total > 0 && items.length >= total)) {
        break;
      }
    }

    let displayPath = "/";
    let parentDir = null;
    if (currentFid !== "0") {
      try {
        const info = await fetchQuarkFileInfo(currentFid);
        if (info?.file_name) {
          displayPath = `/${info.file_name}`;
        }
        parentDir =
          info?.pdir_fid !== undefined && info?.pdir_fid !== null
            ? String(info.pdir_fid)
            : "0";
      } catch {
        parentDir = "0";
      }
    }

    const files = items.map((item) => {
      const fid = String(item.fid);
      const isdir = isQuarkDirItem(item);
      return {
        id: fid,
        fsId: fid,
        name: item.file_name,
        path: fid,
        size: Number(item.size) || 0,
        isdir,
      };
    });

    return {
      dir: currentFid,
      displayPath,
      parentDir,
      isRoot: currentFid === "0",
      files,
    };
  },

  async listFolderRecursive(folderRef, ctx) {
    await ctx.syncDnrRules();
    const rootFid = normalizeQuarkDirId(folderRef);

    let folderName = "QuarkNetdisk";
    let displayPath = "/";

    if (rootFid !== "0") {
      try {
        const info = await fetchQuarkFileInfo(rootFid);
        if (info?.file_name) {
          folderName = sanitizeSegment(info.file_name) || "QuarkFolder";
          displayPath = `/${info.file_name}`;
        } else {
          folderName = "QuarkFolder";
          displayPath = `/${rootFid}`;
        }
      } catch {
        folderName = "QuarkFolder";
        displayPath = `/${rootFid}`;
      }
    }

    const allFiles = [];
    const dirQueue = [{ fid: rootFid, relPrefix: folderName }];
    const visitedFids = new Set([rootFid]);
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

      let page = 1;
      let fetchedInDir = 0;
      while (true) {
        const data = await fetchQuarkSortPage({
          pdirFid: current.fid,
          page,
          size: PAGE_SIZE,
          sort: "file_type:asc,file_name:asc",
        });

        const list = data?.data?.list || [];
        if (list.length === 0) break;

        fetchedInDir += list.length;

        for (const item of list) {
          const fid = String(item.fid);
          if (isQuarkDirItem(item)) {
            if (fid && !visitedFids.has(fid)) {
              visitedFids.add(fid);
              const safeDirName = sanitizeSegment(item.file_name) || fid;
              dirQueue.push({
                fid,
                relPrefix: `${current.relPrefix}/${safeDirName}`,
              });
            }
            continue;
          }

          if (allFiles.length >= MAX_FILES) {
            truncated = true;
            break;
          }

          const safeFileName = sanitizeFilename(item.file_name) || fid;
          const relativePath = `${current.relPrefix}/${safeFileName}`;

          allFiles.push({
            id: fid,
            fsId: fid,
            name: item.file_name,
            path: fid,
            relativePath,
            size: Number(item.size) || 0,
          });
        }

        const total = Number(data?.metadata?._total) || 0;
        if (
          list.length < PAGE_SIZE ||
          (total > 0 && fetchedInDir >= total) ||
          allFiles.length >= MAX_FILES
        ) {
          break;
        }
        page++;
      }
    }

    return {
      folderPath: rootFid,
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
        "PanDirect 下载规则当前已暂停，请先在插件弹窗中开启（夸克获取直链需注入客户端 UA）。"
      );
    }
    await ctx.syncDnrRules();

    const cleanIds = (itemIds || [])
      .map((id) => String(id || "").trim())
      .filter(Boolean);

    if (cleanIds.length === 0) {
      throw new Error("未获取到有效的夸克文件 fid。");
    }

    const combined = [];
    const BATCH_SIZE = 50;

    for (let i = 0; i < cleanIds.length; i += BATCH_SIZE) {
      const batch = cleanIds.slice(i, i + BATCH_SIZE);
      const url = new URL(`${QUARK_API_BASE}/file/download`);
      url.searchParams.set("pr", "ucpro");
      url.searchParams.set("fr", "pc");
      url.searchParams.set("sys", "win32");
      url.searchParams.set("ve", "2.5.56");
      url.searchParams.set("ut", "");
      url.searchParams.set("guid", "");

      // Observe ephemeral __puus Set-Cookie rotation triggered by this file/download request
      let rotatedPuus = "";
      const canObserveCookies =
        typeof chrome !== "undefined" &&
        typeof chrome.cookies?.onChanged?.addListener === "function" &&
        typeof chrome.cookies?.onChanged?.removeListener === "function";
      const onCookieChanged = (changeInfo) => {
        const cookie = changeInfo?.cookie;
        if (
          !changeInfo?.removed &&
          cookie?.name === "__puus" &&
          typeof cookie?.domain === "string" &&
          cookie.domain.toLowerCase().endsWith("quark.cn") &&
          cookie?.value
        ) {
          rotatedPuus = String(cookie.value).replace(/[\r\n]+/g, "").trim();
        }
      };

      if (canObserveCookies) {
        chrome.cookies.onChanged.addListener(onCookieChanged);
      }

      let data;
      try {
        const res = await fetch(url.toString(), {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/plain, */*",
          },
          body: JSON.stringify({ fids: batch }),
        });

        data = await parseJsonSafe(res, "获取夸克下载直链");
      } finally {
        if (canObserveCookies) {
          chrome.cookies.onChanged.removeListener(onCookieChanged);
        }
      }

      const list = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.data?.list)
        ? data.data.list
        : [];
      for (const item of list) {
        combined.push({ item, rotatedPuus });
      }
    }

    if (combined.length === 0) {
      throw new Error("未获取到夸克文件下载链接，请确认文件存在且已登录夸克网盘。");
    }

    return combined.map(({ item, rotatedPuus }) => {
      const fid = String(item.fid);
      const downloadUrl = item.download_url || null;
      return {
        id: fid,
        fsId: fid,
        filename: item.file_name,
        size: Number(item.size) || 0,
        url: downloadUrl,
        ...(rotatedPuus ? { _rotatedPuus: rotatedPuus } : {}),
        error: downloadUrl
          ? undefined
          : "该条目未返回下载直链（可能是文件夹或无权限）",
      };
    });
  },

  async resolveStreamTarget(itemId, ctx) {
    const targets = await this.resolveDownloadTargets([itemId], ctx);
    const target = targets[0];
    if (!target || !target.url) {
      throw new Error(
        target?.error || "未获取到夸克文件下载直链（可能无权限或为文件夹）"
      );
    }
    return target;
  },
});
