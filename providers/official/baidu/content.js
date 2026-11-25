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
    "#pandirect-root, thead, .el-dialog, .u-dialog, .u-modal, [aria-modal='true']";

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

  const TOOLBAR_EXCLUSIONS =
    ".wp-s-agile-tool-bar, .wp-s-header__toolbar, .wp-s-core-pan__header-tool-bar, .bar, .tcuLAu";

  const STRONG_MENU_LABELS = new Set([
    "重命名",
    "复制",
    "移动",
    "复制到",
    "移动到",
    "导出文件目录",
    "共享",
    "详细信息",
    "详情",
    "属性",
    "移入隐藏空间",
    "加入收藏",
  ]);

  const ALL_MENU_LABELS = new Set([
    ...STRONG_MENU_LABELS,
    "下载",
    "分享",
    "删除",
    "收藏",
    "播放",
    "打开",
    "预览",
    "转存",
    "解压",
    "在线编辑",
  ]);

  function resolveRowContextFromTarget(target) {
    const el = target && target.nodeType === 1 ? target : target?.parentElement;
    if (!el || typeof el.closest !== "function") return null;
    if (el.closest(EXCLUDED_CONTAINERS) || el.closest(".pd-inline-btn")) return null;
    const row = el.closest(ROW_SELECTOR) || el.closest("tbody tr");
    if (!row || row.closest?.(EXCLUDED_CONTAINERS)) return null;
    const item = extractBaiduRowItem(row);
    if (!item.id && !item.name) return null;
    const isMoreTrigger = Boolean(
      el.closest(
        "[title='更多'], [aria-label='更多'], [class*='more'], [class*='ellipsis'], [class*='dot']"
      )
    );
    const isActionArea =
      isMoreTrigger ||
      Boolean(el.closest("[class*='action'], [class*='operate'], .operate"));
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

  function isHorizontalPair(firstEl, secondEl) {
    if (
      typeof firstEl?.getBoundingClientRect !== "function" ||
      typeof secondEl?.getBoundingClientRect !== "function"
    ) {
      return false;
    }
    const r1 = firstEl.getBoundingClientRect();
    const r2 = secondEl.getBoundingClientRect();
    if (!r1 || !r2) return false;
    if (r1.width === 0 && r2.width === 0) return false;
    return Math.abs(r2.left - r1.left) >= 24 && Math.abs(r2.top - r1.top) < 10;
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
        node.closest(TOOLBAR_EXCLUSIONS) ||
        node.closest(".pd-inline-menu-item") ||
        node.closest(".pd-inline-btn")
      ) {
        continue;
      }
      if (node.closest(".wp-s-pan-list__file-name-title-text, .file-name")) {
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
      if (
        container.closest?.(EXCLUDED_CONTAINERS) ||
        container.closest?.(TOOLBAR_EXCLUSIONS)
      ) {
        continue;
      }
      if (
        typeof itemEl.querySelector === "function" &&
        itemEl.querySelector(
          "input[type='checkbox'], .wp-s-pan-list__file-name-title-text"
        )
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
      if (isHorizontalPair(firstEl, secondEl)) continue;

      const itemTag =
        (firstEl.tagName || "").toUpperCase() === "LI" ? "li" : "div";
      const enclosingRow =
        container.closest?.(ROW_SELECTOR) || container.closest?.("tbody tr") || null;
      results.push({
        menu: container,
        anchor: firstEl,
        insertPosition: "beforebegin",
        itemTag,
        getItem: enclosingRow ? () => extractBaiduRowItem(enclosingRow) : null,
      });
    }

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
      resolveRowContextFromTarget,
      findMenuAnchors,
      findToolbarAnchors,
    },
  });
})();
