/**
 * Quark Netdisk (pan.quark.cn / drive.quark.cn) page adapter.
 * Mounts the shared PanDirect floating drawer with Quark URL hash & AntD table DOM readers.
 */
(() => {
  if (!window.PanDirectDrawer) return;

  /**
   * Parses Quark SPA hash routes like:
   *   #/list/all
   *   #/list/all/3b2a1f...-Movies/9c8d7e...-SciFi
   * Returns { dir: "<fid or 0>", displayPath: "/Movies/SciFi" }.
   */
  function parseQuarkHash(rawHash) {
    try {
      const cleaned = (rawHash || "")
        .replace(/^#/, "")
        .split("?")[0]
        .replace(/\/+$/, "");

      const match = cleaned.match(/^\/list\/(?:all|file|folder)\/?(.*)$/i);
      if (!match || !match[1]) {
        return { dir: "0", displayPath: "/" };
      }

      const rawSegments = match[1].split("/").filter(Boolean);
      if (rawSegments.length === 0) {
        return { dir: "0", displayPath: "/" };
      }

      const names = [];
      let lastFid = "0";

      for (const seg of rawSegments) {
        const dashIdx = seg.indexOf("-");
        if (dashIdx > 0) {
          const fidPart = seg.slice(0, dashIdx).trim();
          const nameRaw = seg.slice(dashIdx + 1);
          let decodedName = nameRaw;
          try {
            decodedName = decodeURIComponent(nameRaw);
          } catch {
            // keep raw segment if malformed URI encoding
          }
          if (fidPart) lastFid = fidPart;
          names.push(decodedName || fidPart);
        } else if (/^[0-9a-zA-Z]{8,64}$/.test(seg)) {
          lastFid = seg;
          names.push(seg);
        }
      }

      return {
        dir: lastFid || "0",
        displayPath: names.length > 0 ? `/${names.join("/")}` : "/",
      };
    } catch {
      return { dir: "0", displayPath: "/" };
    }
  }

  const ROW_SELECTOR = [
    "tr.ant-table-row",
    "tr[data-row-key]",
    ".file-item",
  ].join(", ");

  const EXCLUDED_CONTAINERS =
    "#pandirect-root, thead, .ant-modal, .ant-drawer, [role='dialog']";

  const ACTION_TITLES = new Set([
    "下载",
    "分享",
    "删除",
    "重命名",
    "更多",
    "复制",
    "移动",
    "收藏",
    "播放",
    "打开",
    "预览",
    "详情",
    "转存",
  ]);

  const FORBIDDEN_DOWNLOAD_RE = /客户端|离线|app|极速|传输/i;

  function normalizeText(str) {
    return String(str || "").replace(/\s+/g, "").trim();
  }

  function isElementHiddenInline(el) {
    if (!el) return true;
    if (el.hidden) return true;
    if (el.style && el.style.display === "none") return true;
    return false;
  }

  function extractQuarkRowItem(row) {
    if (!row) return { id: "", name: "", isdir: null };

    const attrId =
      row.getAttribute?.("data-row-key") ||
      row.getAttribute?.("data-fid") ||
      row.getAttribute?.("data-id") ||
      row.dataset?.rowKey ||
      row.dataset?.fid ||
      row.dataset?.id ||
      "";
    const id = /^[0-9a-zA-Z_-]{8,64}$/.test(attrId) ? attrId : "";

    let name = "";
    const primaryNameEl = row.querySelector?.(
      ".filename-text, .file-name, .editable-cell-value-wrap, [title]"
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
          node.closest(".pd-inline-btn, [class*='oper'], [class*='action']")
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
    if (
      typeof row.querySelector === "function" &&
      row.querySelector(
        "[class*='folder'], img[src*='folder'], use[href*='folder'], use[xlink\\:href*='folder']"
      )
    ) {
      isdir = true;
    }

    return { id, name, isdir };
  }

  function getSelectedItemsFromDom() {
    const ids = new Set();
    const names = new Set();

    const selectedRows = document.querySelectorAll(
      ".ant-table-row-selected, tr[aria-selected='true'], .file-item-selected, .is-selected"
    );

    selectedRows.forEach((row) => {
      const item = extractQuarkRowItem(row);
      if (item.id) ids.add(item.id);
      if (item.name) names.add(item.name);
    });

    return {
      ids: Array.from(ids),
      names: Array.from(names),
    };
  }

  function resolveRowAnchorElement(el, row) {
    let anchor = el;
    for (let depth = 0; depth < 2; depth++) {
      const parent = anchor.parentElement;
      if (!parent || parent === row) break;
      const tag = (parent.tagName || "").toUpperCase();
      if (tag === "TD" || tag === "TR" || tag === "TBODY" || tag === "TABLE") {
        break;
      }
      const parentTitle = normalizeText(
        parent.getAttribute?.("title") || parent.getAttribute?.("aria-label")
      );
      const isDirectWrapper =
        tag === "A" || tag === "BUTTON" || parentTitle === "下载";
      if (!isDirectWrapper) break;
      anchor = parent;
      if (tag === "A" || tag === "BUTTON") break;
    }
    return anchor;
  }

  function findRowAnchors(doc) {
    const results = [];
    const seenRows = new Set();
    const candidates = doc.querySelectorAll(
      "[title='下载'], [aria-label='下载'], .icon-download, [class*='download'], [class*='oper'] button, [class*='oper'] a, [class*='oper'] span, tr.ant-table-row button, tr.ant-table-row a"
    );

    candidates.forEach((el) => {
      if (typeof el.closest !== "function") return;
      if (el.closest(EXCLUDED_CONTAINERS) || el.closest(".pd-inline-btn")) return;

      const text = normalizeText(el.textContent);
      const title = normalizeText(
        el.getAttribute?.("title") || el.getAttribute?.("aria-label")
      );
      const classStr = typeof el.className === "string" ? el.className : "";
      if (FORBIDDEN_DOWNLOAD_RE.test(`${text} ${title}`)) return;

      const looksLikeDownload =
        title === "下载" ||
        text === "下载" ||
        (/download/i.test(classStr) && text.length <= 4);
      if (!looksLikeDownload) return;

      const row = el.closest(ROW_SELECTOR) || el.closest("tbody tr");
      if (!row || seenRows.has(row)) return;
      if (row.closest?.(EXCLUDED_CONTAINERS)) return;

      const anchor = resolveRowAnchorElement(el, row);
      if (!anchor || isElementHiddenInline(anchor)) return;

      const preview = extractQuarkRowItem(row);
      if (!preview.id && !preview.name) return;

      seenRows.add(row);
      results.push({
        anchor,
        insertPosition: "afterend",
        getItem: () => extractQuarkRowItem(row),
      });
    });

    return results;
  }

  function findToolbarAnchors(doc) {
    const results = [];
    const seenContainers = new Set();
    const candidates = doc.querySelectorAll(
      ".btn-operate button, .btn-operate a, .btn-operate [role='button'], .header-operate button, .header-operate a, .file-operate-bar button, .ant-btn, button, a, [role='button']"
    );

    candidates.forEach((el) => {
      if (typeof el.closest !== "function") return;
      if (el.closest(EXCLUDED_CONTAINERS) || el.closest(".pd-inline-btn")) return;
      if (el.closest(ROW_SELECTOR) || el.closest("tbody tr")) return;
      if (isElementHiddenInline(el)) return;

      const text = normalizeText(el.textContent);
      const title = normalizeText(
        el.getAttribute?.("title") || el.getAttribute?.("aria-label")
      );
      if (FORBIDDEN_DOWNLOAD_RE.test(`${text} ${title}`)) return;
      if (text !== "下载" && !(text === "" && title === "下载")) return;

      const container = el.parentElement;
      if (!container || seenContainers.has(container)) return;
      seenContainers.add(container);

      results.push({
        anchor: el,
        insertPosition: "afterend",
      });
    });

    return results;
  }

  window.PanDirectDrawer.mount({
    providerId: "quark",
    providerName: "夸克网盘（社区版）",
    rootDir: "0",
    idIsFolderPath: true,
    getCurrentDir: () => parseQuarkHash(window.location.hash),
    getSelectedItemsFromDom,
    emptyErrorHint:
      "读取目录失败，请确认当前浏览器已登录 pan.quark.cn，然后点击「刷新」。",
    inlineActions: {
      findRowAnchors,
      findToolbarAnchors,
    },
  });
})();
