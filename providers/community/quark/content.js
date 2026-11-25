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
    "#pandirect-root, thead, .ant-modal, .ant-drawer, [aria-modal='true']";

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

  const TOOLBAR_EXCLUSIONS =
    ".btn-operate, .header-operate, .file-operate-bar, .list-header";

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
    "设为私密",
    "移入保险箱",
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
  ]);

  function resolveRowContextFromTarget(target) {
    const el = target && target.nodeType === 1 ? target : target?.parentElement;
    if (!el || typeof el.closest !== "function") return null;
    if (el.closest(EXCLUDED_CONTAINERS) || el.closest(".pd-inline-btn")) return null;
    const row = el.closest(ROW_SELECTOR) || el.closest("tbody tr");
    if (!row || row.closest?.(EXCLUDED_CONTAINERS)) return null;
    const item = extractQuarkRowItem(row);
    if (!item.id && !item.name) return null;
    const isMoreTrigger = Boolean(
      el.closest(
        "[title='更多'], [aria-label='更多'], [class*='more'], [class*='ellipsis'], [class*='dot']"
      )
    );
    const isActionArea =
      isMoreTrigger ||
      Boolean(el.closest("[class*='oper'], [class*='action']"));
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
      if (node.closest(".filename-text, .file-name")) {
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
        itemEl.querySelector("input[type='checkbox'], .filename-text")
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
        getItem: enclosingRow ? () => extractQuarkRowItem(enclosingRow) : null,
      });
    }

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
      resolveRowContextFromTarget,
      findMenuAnchors,
      findToolbarAnchors,
    },
  });
})();
