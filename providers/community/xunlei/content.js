/**
 * Xunlei Cloud Drive (pan.xunlei.com) page adapter.
 * - Syncs ephemeral localStorage session tokens to the background service worker (memory-only).
 * - Mounts the shared PanDirect floating drawer & three-dots (•••) dropdown "直连下载" action.
 */
(() => {
  if (!window.PanDirectDrawer) return;

  const XUNLEI_READ_SESSION_MESSAGE = "PANDIRECT_XUNLEI_READ_SESSION";

  function decodeJwtPayload(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length < 2) return null;
      const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      if (typeof atob !== "function") return null;
      const json = atob(padded);
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  /**
   * Reads Xunlei web session headers directly from pan.xunlei.com window.localStorage.
   */
  function readXunleiLocalStorageSnapshot(storage) {
    const store = storage || window.localStorage;
    if (!store || typeof store.length !== "number") return null;

    const credsList = [];
    const captchasByClient = new Map();
    let fallbackCaptchaToken = "";
    let nickname = "";

    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (!key) continue;
        const rawVal = store.getItem(key);
        if (!rawVal) continue;

        if (key.startsWith("credentials_")) {
          try {
            const parsed = JSON.parse(rawVal);
            if (parsed && parsed.access_token) {
              credsList.push({
                clientId: key.slice("credentials_".length).trim(),
                creds: parsed,
              });
            }
          } catch {
            // ignore malformed entry
          }
        } else if (key.startsWith("captcha_")) {
          try {
            const parsed = JSON.parse(rawVal);
            const capToken = parsed?.token || parsed?.captcha_token || "";
            if (capToken) {
              const cid = key.slice("captcha_".length).trim();
              captchasByClient.set(cid, String(capToken));
              if (!fallbackCaptchaToken) {
                fallbackCaptchaToken = String(capToken);
              }
            }
          } catch {
            // ignore malformed entry
          }
        } else if (
          !nickname &&
          /^(?:user_?info|xl_?user_?info|account_?info)$/i.test(key)
        ) {
          try {
            const parsed = JSON.parse(rawVal);
            const candidate =
              parsed?.nickname || parsed?.nick_name || parsed?.name || "";
            if (candidate) nickname = String(candidate).trim();
          } catch {
            // ignore
          }
        }
      }
    } catch {
      return null;
    }

    if (credsList.length === 0) {
      return null;
    }

    // Prefer credentials entry whose clientId has a matching captcha_* token
    const chosen =
      credsList.find((item) => captchasByClient.has(item.clientId)) ||
      credsList[0];

    const { clientId, creds } = chosen;
    const tokenType = String(creds.token_type || "Bearer").trim() || "Bearer";
    const accessToken = String(creds.access_token || "").trim();
    if (!accessToken) return null;

    const captchaToken =
      captchasByClient.get(clientId) || fallbackCaptchaToken || "";

    let deviceId = "";
    try {
      const deviceRaw = store.getItem("deviceid") || "";
      const match = /([a-fA-F0-9]{32})/.exec(deviceRaw.split(",")[0] || "");
      if (match) {
        deviceId = match[1];
      }
    } catch {
      // ignore
    }

    let userId = String(creds.user_id || creds.sub || "").trim();
    if (!userId || !nickname) {
      const jwtPayload = decodeJwtPayload(accessToken);
      if (jwtPayload) {
        if (!userId) {
          userId = String(jwtPayload.user_id || jwtPayload.sub || "").trim();
        }
        if (!nickname && jwtPayload.nickname) {
          nickname = String(jwtPayload.nickname).trim();
        }
      }
    }

    return {
      authorization: `${tokenType} ${accessToken}`,
      captchaToken,
      deviceId,
      clientId,
      userId,
      nickname,
      syncedAt: Date.now(),
    };
  }

  let lastSyncedSignature = "";

  function pushSessionToBackground({ force = false } = {}) {
    if (
      typeof chrome === "undefined" ||
      typeof chrome.runtime?.sendMessage !== "function"
    ) {
      return;
    }
    const session = readXunleiLocalStorageSnapshot();
    const sig = session
      ? `${session.authorization}|${session.captchaToken}|${session.deviceId}|${session.clientId}`
      : "EMPTY";
    if (!force && sig === lastSyncedSignature) {
      return;
    }
    lastSyncedSignature = sig;

    try {
      chrome.runtime.sendMessage(
        {
          type: "PANDIRECT_PROVIDER_SYNC_SESSION",
          provider: "xunlei",
          session,
        },
        () => {
          // Consume chrome.runtime.lastError silently if SW is restarting
          void chrome.runtime?.lastError;
        }
      );
    } catch {
      // ignore
    }
  }

  // Register live on-demand session reader for Background Service Worker
  if (
    typeof chrome !== "undefined" &&
    typeof chrome.runtime?.onMessage?.addListener === "function"
  ) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === XUNLEI_READ_SESSION_MESSAGE) {
        const session = readXunleiLocalStorageSnapshot();
        sendResponse({ ok: Boolean(session), session });
        return false;
      }
      return undefined;
    });
  }

  if (typeof window.addEventListener === "function") {
    window.addEventListener("storage", (e) => {
      const k = e?.key || "";
      if (
        !k ||
        k.startsWith("credentials_") ||
        k.startsWith("captcha_") ||
        k === "deviceid"
      ) {
        pushSessionToBackground();
      }
    });
  }

  if (typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        pushSessionToBackground();
      }
    });
  }

  pushSessionToBackground({ force: true });

  /**
   * Parses Xunlei web routes:
   *   https://pan.xunlei.com/?path=%2FMovies%2FSciFi
   * resolves the folder ID via localStorage["xlPanHomeRoutes"], falling back to ?parent_id= or root "0".
   */
  function parseXunleiLocation(loc, storage) {
    const locationObj = loc || window.location || {};
    const store = storage || window.localStorage;
    try {
      const params = new URLSearchParams(locationObj.search || "");
      const rawPath = params.get("path") || "";
      const directParentId = (
        params.get("parent_id") ||
        params.get("folder_id") ||
        ""
      ).trim();

      let displayPath = "/";
      if (rawPath) {
        let decoded = rawPath;
        try {
          decoded = decodeURIComponent(rawPath);
        } catch {
          // keep rawPath
        }
        const clean = decoded.replace(/\/+$/, "");
        displayPath = clean
          ? clean.startsWith("/")
            ? clean
            : `/${clean}`
          : "/";

        if (displayPath !== "/" && store && typeof store.getItem === "function") {
          try {
            const routes = JSON.parse(store.getItem("xlPanHomeRoutes") || "{}");
            const routeValue =
              routes[rawPath] ||
              routes[displayPath] ||
              routes[`${displayPath}/`] ||
              routes[displayPath.slice(1)] ||
              routes[encodeURI(displayPath)] ||
              routes[encodeURIComponent(displayPath)] ||
              "";
            let routeIds = [];
            if (Array.isArray(routeValue)) {
              routeIds = routeValue.map((seg) => String(seg || "").trim()).filter(Boolean);
            } else if (routeValue && typeof routeValue === "object" && routeValue.id) {
              routeIds = [String(routeValue.id).trim()];
            } else {
              routeIds = String(routeValue || "")
                .split("/")
                .map((seg) => seg.trim())
                .filter(Boolean);
            }
            const lastId = routeIds[routeIds.length - 1] || "";
            if (lastId && lastId !== "0") {
              return { dir: lastId, displayPath };
            }
          } catch {
            // ignore malformed xlPanHomeRoutes
          }
        }
      }

      if (directParentId && directParentId !== "0" && directParentId !== "/") {
        return { dir: directParentId, displayPath };
      }

      const pathname = String(locationObj.pathname || "");
      const folderMatch = pathname.match(/^\/(?:folder|drive)\/([0-9a-zA-Z_-]{6,64})\/?$/);
      if (folderMatch && folderMatch[1]) {
        return { dir: folderMatch[1], displayPath };
      }

      return { dir: "0", displayPath: "/" };
    } catch {
      return { dir: "0", displayPath: "/" };
    }
  }

  const ROW_SELECTOR = [
    "[data-file-id]",
    "li[class*='SourceListItem__item']",
    "div[class*='SourceListItem__item']",
    "tr[data-file-id]",
    "[class*='file-list-item']",
  ].join(", ");

  const EXCLUDED_CONTAINERS =
    "#pandirect-root, thead, .el-dialog, .ant-modal, .ant-drawer, [role='dialog'], [aria-modal='true']";

  const ACTION_TITLES = new Set([
    "下载",
    "高速下载",
    "分享",
    "删除",
    "重命名",
    "更多",
    "复制",
    "移动",
    "收藏",
    "标星",
    "播放",
    "打开",
    "预览",
    "详情",
    "详细信息",
    "转存",
    "解压",
    "云解压",
    "在线解压",
  ]);

  function extractXunleiRowItem(row) {
    if (!row) return { id: "", name: "", isdir: null };

    const attrId =
      row.getAttribute?.("data-file-id") ||
      row.dataset?.fileId ||
      row.getAttribute?.("data-id") ||
      row.dataset?.id ||
      row.getAttribute?.("data-row-key") ||
      "";
    const id = /^[0-9a-zA-Z_-]{6,64}$/.test(String(attrId).trim())
      ? String(attrId).trim()
      : "";

    let name = "";
    const primaryNameEl = row.querySelector?.(
      "[class*='SourceListItem__name'] [title], [class*='SourceListItem__name'], [class*='filename'], [class*='file-name'], [title]"
    );
    if (primaryNameEl) {
      const candidate = (
        primaryNameEl.getAttribute?.("title") ||
        primaryNameEl.textContent ||
        ""
      ).trim();
      if (candidate && !ACTION_TITLES.has(candidate)) {
        name = candidate;
      }
    }

    if (!name && typeof row.querySelectorAll === "function") {
      const titledNodes = row.querySelectorAll("a[title], span[title], div[title], [title]");
      for (const node of titledNodes) {
        if (
          typeof node.closest === "function" &&
          node.closest(".pd-inline-btn, [class*='oper'], [class*='action'], [class*='more']")
        ) {
          continue;
        }
        const candidate = (node.getAttribute?.("title") || "").trim();
        if (!candidate || ACTION_TITLES.has(candidate)) continue;
        name = candidate;
        break;
      }
    }

    let isdir = null;
    if (typeof row.querySelector === "function") {
      const sizeEl = row.querySelector("[class*='SourceListItem__size']");
      const sizeText = String(sizeEl?.textContent || "").trim();
      if (sizeText === "-" || sizeText === "--") {
        isdir = true;
      } else if (
        row.querySelector(
          "[class*='folder'], img[src*='folder'], use[href*='folder'], use[xlink\\:href*='folder']"
        )
      ) {
        isdir = true;
      }
    }

    return { id, name, isdir };
  }

  function isRowSelected(row) {
    if (!row) return false;
    if (row.getAttribute?.("aria-selected") === "true") return true;
    const cls = String(row.className || "");
    if (
      /SourceListItem__active|\bis-selected\b|\bselected\b|\bactive\b/i.test(cls) &&
      typeof row.querySelector === "function" &&
      row.querySelector("input[type='checkbox']")
    ) {
      const cb = row.querySelector("input[type='checkbox']");
      return Boolean(cb?.checked || /SourceListItem__active|\bis-selected\b/i.test(cls));
    }
    if (typeof row.querySelector === "function") {
      const checkedBox = row.querySelector(
        "input[type='checkbox']:checked, [role='checkbox'][aria-checked='true']"
      );
      if (checkedBox) return true;
    }
    return false;
  }

  function getSelectedItemsFromDom() {
    const ids = new Set();
    const names = new Set();

    const rows = document.querySelectorAll(ROW_SELECTOR);
    rows.forEach((row) => {
      if (!isRowSelected(row)) return;
      const item = extractXunleiRowItem(row);
      if (item.id) ids.add(item.id);
      if (item.name) names.add(item.name);
    });

    return {
      ids: Array.from(ids),
      names: Array.from(names),
    };
  }

  const STRONG_MENU_LABELS = new Set([
    "重命名",
    "移动",
    "移动到",
    "复制",
    "复制到",
    "详情",
    "详细信息",
    "属性",
    "共享",
    "移入保险箱",
    "加入收藏",
    "标星",
    "添加标签",
  ]);

  const ALL_MENU_LABELS = new Set([
    ...STRONG_MENU_LABELS,
    "下载",
    "高速下载",
    "分享",
    "删除",
    "收藏",
    "播放",
    "打开",
    "预览",
    "转存",
    "解压",
    "云解压",
    "在线解压",
  ]);

  function resolveRowContextFromTarget(target) {
    const el = target && target.nodeType === 1 ? target : target?.parentElement;
    if (!el || typeof el.closest !== "function") return null;
    if (el.closest(EXCLUDED_CONTAINERS) || el.closest(".pd-inline-btn")) return null;
    const row = el.closest(ROW_SELECTOR);
    if (!row || row.closest?.(EXCLUDED_CONTAINERS)) return null;
    const item = extractXunleiRowItem(row);
    if (!item.id && !item.name) return null;
    const isMoreTrigger = Boolean(
      el.closest(
        "[title='更多'], [aria-label='更多'], [class*='more'], [class*='ellipsis'], [class*='dot']"
      )
    );
    const isActionArea =
      isMoreTrigger ||
      Boolean(el.closest("[class*='oper'], [class*='action'], [class*='tool']"));
    return { row, item, isMoreTrigger, isActionArea };
  }

  function normalizeMenuText(str) {
    return String(str || "")
      .replace(/[\uE000-\uF8FF\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, "")
      .trim();
  }

  function countDistinctMenuLabels(text) {
    let count = 0;
    for (const lbl of ALL_MENU_LABELS) {
      if (text.includes(lbl)) {
        count++;
        if (count >= 2) return count;
      }
    }
    return count;
  }

  function climbToMenuItem(el, label) {
    let cur = el;
    for (let depth = 0; depth < 6; depth++) {
      const parent = cur.parentElement;
      if (!parent) break;
      const tag = (parent.tagName || "").toUpperCase();
      if (
        tag === "BODY" ||
        tag === "HTML" ||
        tag === "UL" ||
        tag === "OL" ||
        tag === "DL" ||
        tag === "TABLE" ||
        tag === "TBODY" ||
        tag === "TR" ||
        tag === "TD"
      ) {
        break;
      }
      const parentText = normalizeMenuText(parent.textContent);
      if (!parentText) break;
      if (parentText === label) {
        cur = parent;
        continue;
      }
      if (
        parentText.length <= label.length + 3 &&
        parentText.includes(label) &&
        countDistinctMenuLabels(parentText) <= 1
      ) {
        cur = parent;
        continue;
      }
      break;
    }
    return cur;
  }

  function isVisibleVerticalMenuPair(firstEl, secondEl) {
    if (
      typeof firstEl?.getBoundingClientRect !== "function" ||
      typeof secondEl?.getBoundingClientRect !== "function"
    ) {
      return true;
    }
    const r1 = firstEl.getBoundingClientRect();
    const r2 = secondEl.getBoundingClientRect();
    if (!r1 || !r2) return true;
    if (r1.width <= 0 || r2.width <= 0) return false;
    const isHorizontal =
      Math.abs(r2.left - r1.left) >= 24 && Math.abs(r2.top - r1.top) < 10;
    return !isHorizontal;
  }

  function collectLabelHolderElements(doc) {
    const holders = [];
    if (typeof doc.createTreeWalker === "function" && doc.body) {
      const SHOW_TEXT =
        typeof NodeFilter !== "undefined" && NodeFilter.SHOW_TEXT
          ? NodeFilter.SHOW_TEXT
          : 4;
      const walker = doc.createTreeWalker(doc.body, SHOW_TEXT);
      let textNode = walker.nextNode();
      while (textNode) {
        const label = normalizeMenuText(textNode.nodeValue);
        if (label && ALL_MENU_LABELS.has(label)) {
          const parentEl = textNode.parentElement;
          if (parentEl) {
            holders.push({ node: parentEl, label });
          }
        }
        textNode = walker.nextNode();
      }
      return holders;
    }

    if (typeof doc.querySelectorAll === "function") {
      doc
        .querySelectorAll("li, [role='menuitem'], a, button, div, span, p, dd")
        .forEach((node) => {
          const label = normalizeMenuText(node.textContent);
          if (label && ALL_MENU_LABELS.has(label)) {
            holders.push({ node, label });
          }
        });
    }
    return holders;
  }

  function findMenuAnchors(doc) {
    const grouped = new Map();
    const holders = collectLabelHolderElements(doc);

    for (const { node, label } of holders) {
      if (!node || typeof node.closest !== "function") continue;
      if (
        node.closest(EXCLUDED_CONTAINERS) ||
        node.closest(".pd-inline-menu-item") ||
        node.closest(".pd-inline-btn")
      ) {
        continue;
      }
      if (node.closest("[class*='SourceListItem__name'], .filename, .file-name")) {
        continue;
      }

      const itemEl = climbToMenuItem(node, label);
      const container = itemEl.parentElement;
      if (!container) continue;
      const cTag = (container.tagName || "").toUpperCase();
      if (
        cTag === "BODY" ||
        cTag === "HTML" ||
        cTag === "TABLE" ||
        cTag === "TBODY" ||
        cTag === "THEAD" ||
        cTag === "TR" ||
        cTag === "TD"
      ) {
        continue;
      }
      if (container.closest?.(EXCLUDED_CONTAINERS)) {
        continue;
      }
      if (
        typeof itemEl.querySelector === "function" &&
        itemEl.querySelector("input[type='checkbox'], [class*='SourceListItem__name']")
      ) {
        continue;
      }

      if (!grouped.has(container)) {
        grouped.set(container, new Map());
      }
      const itemMap = grouped.get(container);
      if (!itemMap.has(itemEl)) {
        itemMap.set(itemEl, label);
      }
    }

    const results = [];
    for (const [container, itemMap] of grouped.entries()) {
      const entries = Array.from(itemMap.entries());
      const distinctLabels = new Set(entries.map(([, lbl]) => lbl));
      if (distinctLabels.size < 2) continue;

      let hasStrong = false;
      for (const lbl of distinctLabels) {
        if (STRONG_MENU_LABELS.has(lbl)) {
          hasStrong = true;
          break;
        }
      }
      if (!hasStrong) continue;

      const [firstEl] = entries[0];
      const [secondEl] = entries[1];
      if (!isVisibleVerticalMenuPair(firstEl, secondEl)) continue;

      const itemTag =
        (firstEl.tagName || "").toUpperCase() === "LI" ? "li" : "div";
      const enclosingRow = container.closest?.(ROW_SELECTOR) || null;
      results.push({
        menu: container,
        anchor: firstEl,
        insertPosition: "beforebegin",
        itemTag,
        getItem: enclosingRow ? () => extractXunleiRowItem(enclosingRow) : null,
      });
    }

    return results;
  }

  window.PanDirectDrawer.mount({
    providerId: "xunlei",
    providerName: "迅雷云盘（社区版）",
    rootDir: "0",
    idIsFolderPath: true,
    getCurrentDir: () => {
      pushSessionToBackground();
      return parseXunleiLocation(window.location, window.localStorage);
    },
    getSelectedItemsFromDom,
    emptyErrorHint:
      "读取目录失败，请确认当前浏览器已登录 pan.xunlei.com（或刷新页面更新会话令牌），然后点击「刷新」。",
    inlineActions: {
      resolveRowContextFromTarget,
      findMenuAnchors,
    },
  });
})();
