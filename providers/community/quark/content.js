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

  function getSelectedItemsFromDom() {
    const ids = new Set();
    const names = new Set();

    const selectedRows = document.querySelectorAll(
      ".ant-table-row-selected, tr[aria-selected='true'], .file-item-selected, .is-selected"
    );

    selectedRows.forEach((row) => {
      const attrId =
        row.getAttribute("data-row-key") ||
        row.getAttribute("data-fid") ||
        row.getAttribute("data-id") ||
        row.dataset?.rowKey ||
        row.dataset?.fid ||
        row.dataset?.id;

      if (attrId && /^[0-9a-zA-Z_-]{8,64}$/.test(attrId)) {
        ids.add(attrId);
      }

      const nameEl = row.querySelector(
        ".filename-text, .file-name, .editable-cell-value-wrap, [title]"
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
    providerId: "quark",
    providerName: "夸克网盘（社区版）",
    rootDir: "0",
    getCurrentDir: () => parseQuarkHash(window.location.hash),
    getSelectedItemsFromDom,
    emptyErrorHint:
      "读取目录失败，请确认当前浏览器已登录 pan.quark.cn，然后点击「刷新」。",
  });
})();
