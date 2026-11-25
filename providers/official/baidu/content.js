/**
 * Baidu Netdisk page adapter.
 * Mounts the shared PanDirect floating drawer and non-intrusive inline shortcut buttons
 * with Baidu-specific URL & DOM readers.
 */
(() => {
  if (!window.PanDirectDrawer) return;

  const ROW_SELECTOR = [
    "tr.wp-s-pan-table__body-row",
    "tr.wp-s-table-skin-hoc__tr",
    "tr[data-id]",
    ".wp-s-pan-table__body-row",
    ".wp-s-file-grid-list__item",
    "dd.g-clearfix",
  ].join(", ");

  const EXCLUDED_CONTAINERS =
    "#pandirect-root, thead, .el-dialog, .u-dialog, .u-modal, [role='dialog']";

  const ACTION_TITLES = new Set([
    "下载",
    "分享",
    "删除",
    "重命名",
    "更多",
    "复制",
    "移动",
    "复制到",
    "移动到",
    "收藏",
    "在线编辑",
    "播放",
    "打开",
    "预览",
    "查看",
    "详情",
    "属性",
    "锁定",
    "加密",
    "解压",
    "转存",
  ]);

  const FORBIDDEN_DOWNLOAD_RE = /客户端|离线|app|极速|传输/i;

  function getCurrentPathFromUrl() {
    try {
      const hash = window.location.hash || "";
      const qIndex = hash.indexOf("?");
      if (qIndex !== -1) {
        const params = new URLSearchParams(hash.slice(qIndex + 1));
        const p = params.get("path");
        if (p) return p;
      }
      const searchParams = new URLSearchParams(window.location.search);
      const sp = searchParams.get("path");
      if (sp) return sp;
    } catch {
      // ignore
    }
    return "/";
  }

  function normalizeText(str) {
    return String(str || "").replace(/\s+/g, "").trim();
  }

  function isElementHiddenInline(el) {
    if (!el) return true;
    if (el.hidden) return true;
    if (el.style && el.style.display === "none") return true;
    return false;
  }

  function extractBaiduRowItem(row) {
    if (!row) return { id: "", name: "", isdir: null };

    let id =
      row.getAttribute?.("data-id") ||
      row.getAttribute?.("data-fsid") ||
      row.dataset?.id ||
      row.dataset?.fsid ||
      "";
    if (!/^\d+$/.test(id)) {
      const idHolder = row.querySelector?.("[data-id], [data-fsid]");
      const childId =
        idHolder?.getAttribute?.("data-id") ||
        idHolder?.getAttribute?.("data-fsid") ||
        "";
      id = /^\d+$/.test(childId) ? childId : "";
    }

    let name = "";
    const primaryNameEl = row.querySelector?.(
      ".wp-s-pan-list__file-name-title-text, .wp-s-file-grid-list__item-title, .file-name a, .text a"
    );
    if (primaryNameEl) {
      name = (
        primaryNameEl.getAttribute?.("title") ||
        primaryNameEl.textContent ||
        ""
      ).trim();
    }

    if (!name && typeof row.querySelectorAll === "function") {
      const titledNodes = row.querySelectorAll("a[title], span[title], div[title], [title]");
      for (const node of titledNodes) {
        if (
          typeof node.closest === "function" &&
          node.closest(
            ".pd-inline-btn, [class*='action'], [class*='operate'], .operate"
          )
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
    const rowSet = new Set();

    const selectedRows = document.querySelectorAll(
      "tr.selected, tr.is-selected, tr.is-checked, .wp-s-pan-table__body-row.selected, .wp-s-pan-table__body-row.is-checked, .wp-s-table-skin-hoc__tr.selected, .wp-s-file-grid-list__item.is-selected, dd.g-clearfix.JS-item-active"
    );
    selectedRows.forEach((row) => rowSet.add(row));

    const checkedBoxes = document.querySelectorAll(
      ".u-checkbox.is-checked, input[type='checkbox']:checked"
    );
    checkedBoxes.forEach((box) => {
      if (typeof box.closest !== "function") return;
      if (box.closest(EXCLUDED_CONTAINERS)) return;
      const row = box.closest(ROW_SELECTOR) || box.closest("tbody tr");
      if (row) rowSet.add(row);
    });

    rowSet.forEach((row) => {
      const item = extractBaiduRowItem(row);
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
      "[title='下载'], [aria-label='下载'], .u-icon-download, .icon-download, [class*='icon-download'], [class*='action-download'], [class*='action'] button, [class*='action'] a, [class*='action'] span, [class*='operate'] a"
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

      const preview = extractBaiduRowItem(row);
      if (!preview.id && !preview.name) return;

      seenRows.add(row);
      results.push({
        anchor,
        insertPosition: "afterend",
        getItem: () => extractBaiduRowItem(row),
      });
    });

    return results;
  }

  function findToolbarAnchors(doc) {
    const results = [];
    const seenContainers = new Set();
    const candidates = doc.querySelectorAll(
      ".wp-s-agile-tool-bar button, .wp-s-agile-tool-bar a, .wp-s-header__toolbar button, .wp-s-core-pan__header-tool-bar button, .bar a.g-button, .tcuLAu a.g-button, button.u-button, a.g-button, [role='button']"
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

      let anchor = el;
      const parent = el.parentElement;
      if (
        parent &&
        parent.classList?.contains("wp-s-agile-tool-bar__h-action") &&
        typeof parent.querySelectorAll === "function" &&
        parent.querySelectorAll("button, a").length <= 1
      ) {
        anchor = parent;
      }

      const container = anchor.parentElement;
      if (!container || seenContainers.has(container)) return;
      seenContainers.add(container);

      results.push({
        anchor,
        insertPosition: "afterend",
      });
    });

    return results;
  }

  window.PanDirectDrawer.mount({
    providerId: "baidu",
    providerName: "百度网盘",
    getCurrentDir: getCurrentPathFromUrl,
    getSelectedItemsFromDom,
    fallbackDir: "/apps/PanDirect",
    fallbackHint: "读取失败。如果是应用沙盒限制，可尝试点击下方进入专属目录：",
    inlineActions: {
      findRowAnchors,
      findToolbarAnchors,
    },
  });
})();
