/**
 * Baidu Netdisk page adapter.
 * Mounts the shared PanDirect floating drawer with Baidu-specific URL & DOM readers.
 */
(() => {
  if (!window.PanDirectDrawer) return;

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

  function getSelectedItemsFromDom() {
    const ids = new Set();
    const names = new Set();

    const selectedRows = document.querySelectorAll(
      "tr.selected, tr.is-selected, .wp-s-pan-table__body-row.selected, .wp-s-file-grid-list__item.is-selected, dd.g-clearfix.JS-item-active"
    );

    selectedRows.forEach((row) => {
      const attrId =
        row.getAttribute("data-id") ||
        row.getAttribute("data-fsid") ||
        row.dataset?.id ||
        row.dataset?.fsid;
      if (attrId && /^\d+$/.test(attrId)) {
        ids.add(attrId);
      }

      const nameEl = row.querySelector(
        ".wp-s-pan-list__file-name-title-text, .file-name a, .text a, [title]"
      );
      const name = (
        nameEl?.getAttribute("title") ||
        nameEl?.textContent ||
        ""
      ).trim();
      if (name) {
        names.add(name);
      }
    });

    return {
      ids: Array.from(ids),
      names: Array.from(names),
    };
  }

  window.PanDirectDrawer.mount({
    providerId: "baidu",
    providerName: "百度网盘",
    getCurrentDir: getCurrentPathFromUrl,
    getSelectedItemsFromDom,
    fallbackDir: "/apps/PanDirect",
    fallbackHint: "读取失败。如果是应用沙盒限制，可尝试点击下方进入专属目录：",
  });
})();
