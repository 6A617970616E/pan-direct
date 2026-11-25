/**
 * Reusable floating drawer UI shared across all netdisk content scripts.
 * Supports both path-based providers and ID-tree providers.
 * Provider-specific content scripts call `window.PanDirectDrawer.mount(adapter)`.
 */
(() => {
  if (window.PanDirectDrawer) return;

  function getParentPath(dir) {
    const clean = (dir || "/").replace(/\/+$/, "");
    if (!clean || clean === "/") return "/";
    const idx = clean.lastIndexOf("/");
    return idx <= 0 ? "/" : clean.slice(0, idx);
  }

  function joinDisplayPath(baseDisplay, name) {
    const cleanBase = (baseDisplay || "/").replace(/\/+$/, "");
    if (!name) return cleanBase || "/";
    if (!cleanBase || cleanBase === "/") return `/${name}`;
    return `${cleanBase}/${name}`;
  }

  function formatSize(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let val = bytes;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(res);
      });
    });
  }

  function triggerHiddenFrameDownload(url) {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.referrerPolicy = "no-referrer";
    iframe.src = url;
    document.body.appendChild(iframe);
    setTimeout(() => {
      iframe.remove();
    }, 60000);
  }

  function mount(adapter) {
    if (window.__PANDIRECT_INJECTED__) return;
    window.__PANDIRECT_INJECTED__ = true;

    const providerId = adapter.providerId;
    const providerName = adapter.providerName || "网盘";
    const rootDir = adapter.rootDir || "/";
    const getCurrentDir =
      typeof adapter.getCurrentDir === "function"
        ? adapter.getCurrentDir
        : () => ({ dir: rootDir, displayPath: "/" });
    const getSelectedItemsFromDom =
      typeof adapter.getSelectedItemsFromDom === "function"
        ? adapter.getSelectedItemsFromDom
        : () => ({ ids: [], names: [] });
    const fallbackDir = adapter.fallbackDir || null;
    const fallbackHint =
      adapter.fallbackHint || "读取失败。如果是应用沙盒限制，可尝试点击下方进入专属目录：";
    const emptyErrorHint =
      adapter.emptyErrorHint || "读取目录失败，请确认授权或登录状态后重试。";
    const idIsFolderPath = Boolean(adapter.idIsFolderPath);
    const inlineActions =
      adapter.inlineActions && typeof adapter.inlineActions === "object"
        ? adapter.inlineActions
        : null;

    function normalizeDirTarget(raw) {
      if (raw && typeof raw === "object") {
        const dir = raw.dir || rootDir;
        const displayPath =
          raw.displayPath || (dir === rootDir ? "/" : String(dir));
        return { dir, displayPath };
      }
      const dir = raw || rootDir;
      const displayPath = dir === rootDir ? "/" : String(dir);
      return { dir, displayPath };
    }

    let svgUidCounter = 0;

    function renderBrandIconSvg(uid) {
      const safeUid = uid || `inl_${++svgUidCounter}`;
      return `
        <svg viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <defs>
            <linearGradient id="pdBg_${safeUid}" x1="10" y1="8" x2="118" y2="122" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#1E3A8A" />
              <stop offset="50%" stop-color="#2563EB" />
              <stop offset="100%" stop-color="#0EA5E9" />
            </linearGradient>
            <linearGradient id="pdLoop_${safeUid}" x1="48" y1="26" x2="98" y2="74" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#BAE6FD" />
              <stop offset="100%" stop-color="#38BDF8" />
            </linearGradient>
          </defs>
          <rect x="4" y="4" width="120" height="120" rx="28" fill="url(#pdBg_${safeUid})" />
          <path d="M48 31 H74 C88.5 31 98 40.2 98 52.5 C98 64.8 88.5 74 74 74 H64" fill="none" stroke="url(#pdLoop_${safeUid})" stroke-width="14.5" stroke-linecap="round" />
          <path d="M48 31 V93" fill="none" stroke="#FFFFFF" stroke-width="14.5" stroke-linecap="round" />
          <path d="M29 77 L48 96 L67 77" fill="none" stroke="#FFFFFF" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      `;
    }

    const root = document.createElement("div");
    root.id = "pandirect-root";
    root.className = "pd-hidden";
    root.innerHTML = `
      <div id="pd-toast" class="pd-toast pd-hidden" role="status" aria-live="polite">
        <span id="pd-toast-text"></span>
        <button id="pd-toast-close" class="pd-toast-close" type="button" title="关闭">✕</button>
      </div>

      <button id="pd-fab" title="打开 PanDirect 直链下载面板">
        <span class="pd-fab-badge">${renderBrandIconSvg("fab")}</span>
        <span>PanDirect 直下</span>
      </button>

      <div id="pd-drawer" class="pd-hidden" role="dialog" aria-label="PanDirect 直链下载">
        <div class="pd-header">
          <div class="pd-title-wrap">
            <span class="pd-logo">${renderBrandIconSvg("hdr")}</span>
            <div>
              <div class="pd-title">PanDirect · ${providerName}</div>
              <div class="pd-path" id="pd-current-path">/</div>
            </div>
          </div>
          <button id="pd-close" class="pd-icon-btn" title="关闭">✕</button>
        </div>

        <div class="pd-toolbar">
          <div class="pd-mode-group">
            <label class="pd-radio">
              <input type="radio" name="pd-mode" value="browser" checked />
              <span>浏览器直下</span>
            </label>
            <label class="pd-radio">
              <input type="radio" name="pd-mode" value="aria2" />
              <span>推送 Aria2</span>
            </label>
          </div>
          <div class="pd-actions">
            <button id="pd-up" class="pd-btn-ghost pd-hidden">返回上级</button>
            <button id="pd-refresh" class="pd-btn-ghost">刷新</button>
            <button id="pd-dl-dir" class="pd-btn-ghost" title="递归下载当前文件夹内所有文件">下当前目录</button>
            <button id="pd-dl-selected" class="pd-btn-primary">下已勾选</button>
          </div>
        </div>

        <div id="pd-notice" class="pd-notice pd-hidden"></div>

        <div id="pd-list" class="pd-list">
          <div class="pd-empty">点击「刷新」加载当前文件夹文件列表</div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    const toastEl = root.querySelector("#pd-toast");
    const toastTextEl = root.querySelector("#pd-toast-text");
    const toastCloseBtn = root.querySelector("#pd-toast-close");
    const fab = root.querySelector("#pd-fab");
    const drawer = root.querySelector("#pd-drawer");
    const closeBtn = root.querySelector("#pd-close");
    const pathEl = root.querySelector("#pd-current-path");
    const noticeEl = root.querySelector("#pd-notice");
    const listEl = root.querySelector("#pd-list");
    const upBtn = root.querySelector("#pd-up");
    const refreshBtn = root.querySelector("#pd-refresh");
    const dlDirBtn = root.querySelector("#pd-dl-dir");
    const dlSelectedBtn = root.querySelector("#pd-dl-selected");

    let cachedFiles = [];
    let cachedDir = null;
    let cachedDisplayPath = "/";
    let cachedAt = 0;
    let pendingListPromise = null;
    let pendingListDir = null;

    let activeDir = rootDir;
    let activeDisplayPath = "/";
    let activeParentDir = null;
    let navStack = [];

    let isEnabled = false;
    let currentDownloadMode = "browser";
    let modeSynced = false;
    let toastTimer = null;

    const DIR_CACHE_TTL_MS = 30000;
    const injectedEntries = new Set();
    const anchorToEntry = new Map();
    let inlineObserver = null;
    let inlineScanScheduled = false;

    function getModeLabel(mode = getSelectedMode()) {
      return mode === "aria2" ? "推送 Aria2" : "浏览器直下";
    }

    function getInlineTooltip(kind) {
      const modeLabel = getModeLabel();
      if (kind === "toolbar") {
        return `PanDirect 批量直下已勾选（${modeLabel}）`;
      }
      if (kind === "menu") {
        return `PanDirect 直连下载（${modeLabel}）`;
      }
      return `PanDirect 一键直下（${modeLabel}）`;
    }

    function refreshInlineButtonTooltips() {
      for (const entry of injectedEntries) {
        if (entry.btn) {
          entry.btn.title = getInlineTooltip(entry.kind);
        }
      }
    }

    function applyDownloadMode(mode) {
      const normalized = mode === "aria2" ? "aria2" : "browser";
      currentDownloadMode = normalized;
      modeSynced = true;
      root.querySelectorAll('input[name="pd-mode"]').forEach((radio) => {
        radio.checked = radio.value === normalized;
      });
      refreshInlineButtonTooltips();
    }

    function getSelectedMode() {
      const checked = root.querySelector('input[name="pd-mode"]:checked');
      return checked ? checked.value : currentDownloadMode;
    }

    function hideToast() {
      if (toastTimer && typeof clearTimeout === "function") {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      if (toastEl) {
        toastEl.className = "pd-toast pd-hidden";
      }
    }

    function showToast(text, type = "info") {
      if (!toastEl || !toastTextEl || !isEnabled) return;
      if (toastTimer && typeof clearTimeout === "function") {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      toastTextEl.textContent = text;
      toastEl.className = `pd-toast pd-toast-${type}`;
      const duration = type === "error" ? 6500 : type === "success" ? 3600 : 5000;
      toastTimer = setTimeout(() => {
        hideToast();
      }, duration);
    }

    function showNotice(text, type = "info") {
      noticeEl.textContent = text;
      noticeEl.className = `pd-notice pd-notice-${type}`;
      if (drawer.classList.contains("pd-hidden")) {
        showToast(text, type);
      }
    }

    function hideNotice() {
      noticeEl.className = "pd-notice pd-hidden";
    }

    if (toastCloseBtn) {
      toastCloseBtn.addEventListener("click", () => hideToast());
    }

    async function syncDefaultMode() {
      try {
        const status = await sendMessage({ type: "PANDIRECT_GET_STATUS" });
        if (status?.ok) {
          applyDownloadMode(status.downloadMode || "browser");
          return;
        }
      } catch {
        // ignore
      }
      modeSynced = true;
    }

    async function ensureModeSynced() {
      if (!modeSynced) {
        await syncDefaultMode();
      }
    }

    async function ensureDirFilesLoaded({ forceRefresh = false } = {}) {
      const target = normalizeDirTarget(getCurrentDir());
      const cacheFresh =
        !forceRefresh &&
        cachedDir === target.dir &&
        cachedAt > 0 &&
        Date.now() - cachedAt < DIR_CACHE_TTL_MS;

      if (cacheFresh) {
        return {
          ok: true,
          dir: cachedDir,
          displayPath: cachedDisplayPath,
          files: cachedFiles,
          fromCache: true,
        };
      }

      if (!forceRefresh && pendingListPromise && pendingListDir === target.dir) {
        return pendingListPromise;
      }

      pendingListDir = target.dir;
      pendingListPromise = (async () => {
        try {
          const res = await sendMessage({
            type: "PANDIRECT_LIST_FILES",
            provider: providerId,
            dir: target.dir,
          });
          if (!res?.ok) {
            return { ok: false, error: res?.error || "读取目录失败" };
          }
          cachedDir = res.dir || target.dir;
          cachedDisplayPath =
            res.displayPath &&
            (target.displayPath === target.dir || target.displayPath === "/")
              ? res.displayPath
              : target.displayPath;
          cachedFiles = res.files || [];
          cachedAt = Date.now();
          activeDir = cachedDir;
          activeDisplayPath = cachedDisplayPath;
          return {
            ok: true,
            dir: cachedDir,
            displayPath: cachedDisplayPath,
            files: cachedFiles,
            fromCache: false,
          };
        } catch (err) {
          return { ok: false, error: err?.message || "请求失败" };
        } finally {
          if (pendingListDir === target.dir) {
            pendingListPromise = null;
            pendingListDir = null;
          }
        }
      })();

      return pendingListPromise;
    }

    async function openFolderDownloader(folderPath, folderLabel) {
      await ensureModeSynced();
      const mode = getSelectedMode();
      try {
        const res = await sendMessage({
          type: "PANDIRECT_OPEN_FOLDER_DOWNLOADER",
          provider: providerId,
          path: folderPath,
          label: folderLabel || undefined,
          mode,
        });
        if (!res?.ok) {
          showNotice(res?.error || "打开文件夹下载器失败", "error");
        } else if (drawer.classList.contains("pd-hidden")) {
          showToast(
            `已打开「${folderLabel || folderPath}」文件夹流式下载器`,
            "success"
          );
        }
      } catch (err) {
        showNotice(err?.message || "调用失败", "error");
      }
    }

    async function triggerDownloadItems(itemIds) {
      await ensureModeSynced();
      const mode = getSelectedMode();
      showNotice(
        mode === "aria2"
          ? `正在获取直链并推送 ${itemIds.length} 个文件到 Aria2...`
          : `正在预检直链并启动浏览器原生下载（${itemIds.length} 个文件）...`,
        "info"
      );

      try {
        const res = await sendMessage({
          type: "PANDIRECT_DOWNLOAD_ITEMS",
          provider: providerId,
          itemIds,
          fsIds: itemIds,
          mode,
          preferFrameDownload: mode === "browser",
        });

        if (!res?.ok) {
          showNotice(res?.error || "获取直链失败", "error");
          return;
        }

        const succeeded = (res.results || []).filter((r) => r.ok);
        const failed = (res.results || []).filter((r) => !r.ok);

        if (mode === "browser") {
          succeeded.forEach((item, index) => {
            if (item.frameDownloadUrl) {
              setTimeout(() => {
                triggerHiddenFrameDownload(item.frameDownloadUrl);
              }, index * 300);
            }
          });
        }

        if (failed.length === 0) {
          showNotice(
            mode === "aria2"
              ? `已推送 ${succeeded.length} 个文件到 Aria2！`
              : `已启动 ${succeeded.length} 个文件的浏览器直下！`,
            "success"
          );
        } else {
          showNotice(
            `成功 ${succeeded.length} 个，失败 ${failed.length} 个：${failed[0].error}`,
            "error"
          );
        }
      } catch (err) {
        showNotice(err?.message || "下载调用异常", "error");
      }
    }

    function matchSingleItem(files, item) {
      if (!Array.isArray(files) || files.length === 0 || !item) return null;
      if (item.id) {
        const byId = files.find(
          (f) => String(f.id || f.fsId || "") === String(item.id)
        );
        if (byId) return byId;
      }
      if (item.name) {
        const byName = files.find((f) => f.name === item.name);
        if (byName) return byName;
      }
      return null;
    }

    async function handleInlineRowDownload(itemOrGetter) {
      await ensureModeSynced();
      const rawItem =
        typeof itemOrGetter === "function" ? itemOrGetter() : itemOrGetter;
      const item = rawItem && typeof rawItem === "object" ? rawItem : {};

      if (!item.id && !item.name) {
        showNotice(
          "未能识别当前行文件，请点击右下角「PanDirect 直下」面板操作。",
          "info"
        );
        return;
      }

      let listRes = await ensureDirFilesLoaded();
      let matched = listRes.ok ? matchSingleItem(listRes.files, item) : null;

      if (!matched && listRes.ok && listRes.fromCache) {
        listRes = await ensureDirFilesLoaded({ forceRefresh: true });
        matched = listRes.ok ? matchSingleItem(listRes.files, item) : null;
      }

      if (matched) {
        if (matched.isdir) {
          const folderLabel =
            matched.displayPath ||
            joinDisplayPath(listRes.displayPath || activeDisplayPath, matched.name);
          await openFolderDownloader(matched.path, folderLabel);
        } else {
          await triggerDownloadItems([matched.id || matched.fsId]);
        }
        return;
      }

      if (item.id) {
        if (item.isdir === true) {
          if (idIsFolderPath) {
            const label = item.name ? `/${item.name}` : "/";
            await openFolderDownloader(item.id, label);
          } else {
            showNotice(
              "当前视图未能解析该文件夹路径，请进入所在目录或打开右下角「PanDirect 直下」面板下载。",
              "info"
            );
          }
          return;
        }
        await triggerDownloadItems([item.id]);
        return;
      }

      showNotice(
        listRes?.error ||
          "未在当前目录匹配到该文件，请刷新页面或点击右下角「PanDirect 直下」面板下载。",
        "error"
      );
    }

    async function handleDownloadSelected() {
      await ensureModeSynced();
      const domSel = getSelectedItemsFromDom();
      const domIds = domSel.ids || domSel.fsIds || [];
      const domNames = domSel.names || [];

      if (domIds.length === 0 && domNames.length === 0) {
        showNotice(
          "未检测到页面已勾选的文件，请先在网盘列表勾选文件，或直接点击文件行旁的 PanDirect 快捷图标。",
          "info"
        );
        return;
      }

      const idSet = new Set(domIds.map(String));
      const nameSet = new Set(domNames);

      let listRes = await ensureDirFilesLoaded();
      let files = listRes.ok ? listRes.files : cachedFiles;
      let displayBase = listRes.ok ? listRes.displayPath : activeDisplayPath;

      let matchedItems = files.filter((f) => {
        const itemId = String(f.id || f.fsId || "");
        return (itemId && idSet.has(itemId)) || nameSet.has(f.name);
      });

      if (matchedItems.length === 0 && listRes.ok && listRes.fromCache) {
        listRes = await ensureDirFilesLoaded({ forceRefresh: true });
        files = listRes.ok ? listRes.files : cachedFiles;
        displayBase = listRes.ok ? listRes.displayPath : activeDisplayPath;
        matchedItems = files.filter((f) => {
          const itemId = String(f.id || f.fsId || "");
          return (itemId && idSet.has(itemId)) || nameSet.has(f.name);
        });
      }

      const selectedFolders = matchedItems.filter((f) => f.isdir);
      const selectedFiles = matchedItems.filter((f) => !f.isdir);

      if (selectedFolders.length === 1 && selectedFiles.length === 0) {
        const folder = selectedFolders[0];
        const folderLabel =
          folder.displayPath || joinDisplayPath(displayBase, folder.name);
        await openFolderDownloader(folder.path, folderLabel);
        return;
      }

      if (selectedFolders.length > 0 && selectedFiles.length === 0) {
        showNotice(
          "勾选了多个文件夹，请点击对应文件夹旁的 PanDirect 快捷图标或抽屉中的「下整夹」。",
          "info"
        );
        return;
      }

      let targetIds = selectedFiles.map((f) => f.id || f.fsId);
      if (targetIds.length === 0 && domIds.length > 0) {
        targetIds = domIds;
      }

      if (targetIds.length === 0) {
        showNotice(
          listRes?.error ||
            "未在当前目录匹配到已勾选的文件，请刷新或使用右下角「PanDirect 直下」面板。",
          "info"
        );
        return;
      }

      await triggerDownloadItems(targetIds);
    }

    function renderFileList(files) {
      if (!files || files.length === 0) {
        listEl.innerHTML = `<div class="pd-empty">当前目录为空</div>`;
        return;
      }

      listEl.innerHTML = "";
      files.forEach((file) => {
        const itemId = file.id || file.fsId;
        const row = document.createElement("div");
        row.className = "pd-file-row";

        const info = document.createElement("div");
        info.className = "pd-file-info";

        const name = document.createElement("div");
        name.className = "pd-file-name";
        name.textContent = (file.isdir ? "📁 " : "📄 ") + file.name;
        name.title = file.name;

        const meta = document.createElement("div");
        meta.className = "pd-file-meta";
        meta.textContent = file.isdir ? "文件夹" : formatSize(file.size);

        info.appendChild(name);
        info.appendChild(meta);
        row.appendChild(info);

        const btnWrap = document.createElement("div");
        btnWrap.className = "pd-row-btns";

        if (file.isdir) {
          const childDisplayPath =
            file.displayPath || joinDisplayPath(activeDisplayPath, file.name);

          const openBtn = document.createElement("button");
          openBtn.className = "pd-btn-ghost pd-btn-sm";
          openBtn.textContent = "进入";
          openBtn.addEventListener("click", () => {
            navStack.push({
              dir: activeDir,
              displayPath: activeDisplayPath,
            });
            loadDirectory({
              dir: file.path,
              displayPath: childDisplayPath,
            });
          });

          const dlFolderBtn = document.createElement("button");
          dlFolderBtn.className = "pd-btn-primary pd-btn-sm";
          dlFolderBtn.textContent = "下整夹";
          dlFolderBtn.title = "打开整文件夹流式下载器（保留完整子目录结构）";
          dlFolderBtn.addEventListener("click", () =>
            openFolderDownloader(file.path, childDisplayPath)
          );

          btnWrap.appendChild(openBtn);
          btnWrap.appendChild(dlFolderBtn);
        } else {
          const dlBtn = document.createElement("button");
          dlBtn.className = "pd-btn-primary pd-btn-sm";
          dlBtn.textContent = "直下";
          dlBtn.addEventListener("click", () => triggerDownloadItems([itemId]));
          btnWrap.appendChild(dlBtn);
        }

        row.appendChild(btnWrap);
        listEl.appendChild(row);
      });
    }

    async function loadDirectory(rawTarget, { resetHistory = false } = {}) {
      if (resetHistory) {
        navStack = [];
      }

      const target = normalizeDirTarget(rawTarget || getCurrentDir());
      activeDir = target.dir;
      activeDisplayPath = target.displayPath;
      activeParentDir = null;

      pathEl.textContent = activeDisplayPath;
      pathEl.title = activeDisplayPath;
      const initiallyRoot = activeDir === rootDir || activeDir === "/";
      upBtn.classList.toggle("pd-hidden", initiallyRoot && navStack.length === 0);
      hideNotice();
      listEl.innerHTML = `<div class="pd-empty">正在读取目录 ${activeDisplayPath} ...</div>`;

      try {
        const res = await sendMessage({
          type: "PANDIRECT_LIST_FILES",
          provider: providerId,
          dir: activeDir,
        });

        if (!res?.ok) {
          cachedFiles = [];
          cachedDir = null;
          cachedAt = 0;
          showNotice(res?.error || "读取目录失败", "error");
          if (fallbackDir) {
            listEl.innerHTML = `
              <div class="pd-empty">
                ${fallbackHint}
                <div style="margin-top:8px;">
                  <button id="pd-try-fallback" class="pd-btn-ghost pd-btn-sm">尝试打开 ${fallbackDir}</button>
                </div>
              </div>
            `;
            const tryBtn = listEl.querySelector("#pd-try-fallback");
            if (tryBtn) {
              tryBtn.addEventListener("click", () =>
                loadDirectory(fallbackDir, { resetHistory: true })
              );
            }
          } else {
            listEl.innerHTML = `<div class="pd-empty">${emptyErrorHint}</div>`;
          }
          return;
        }

        if (res.dir) {
          activeDir = res.dir;
        }
        if (
          res.displayPath &&
          (activeDisplayPath === activeDir || activeDisplayPath === "/")
        ) {
          activeDisplayPath = res.displayPath;
        }
        activeParentDir = res.parentDir ?? null;

        const isRoot =
          typeof res.isRoot === "boolean"
            ? res.isRoot
            : activeDir === rootDir || activeDir === "/";

        pathEl.textContent = activeDisplayPath;
        pathEl.title = activeDisplayPath;
        upBtn.classList.toggle("pd-hidden", isRoot && navStack.length === 0);

        cachedFiles = res.files || [];
        cachedDir = activeDir;
        cachedDisplayPath = activeDisplayPath;
        cachedAt = Date.now();
        renderFileList(cachedFiles);
      } catch (err) {
        showNotice(err?.message || "请求失败", "error");
      }
    }

    function insertAdjacentCompat(anchor, position, el) {
      if (typeof anchor.insertAdjacentElement === "function") {
        anchor.insertAdjacentElement(position, el);
        return true;
      }
      const parent = anchor.parentElement || anchor.parentNode;
      if (!parent || typeof parent.insertBefore !== "function") return false;
      if (position === "beforebegin") {
        parent.insertBefore(el, anchor);
      } else {
        parent.insertBefore(el, anchor.nextSibling || null);
      }
      return true;
    }

    function removeEntry(entry) {
      if (entry.btn && typeof entry.btn.remove === "function") {
        entry.btn.remove();
      } else if (entry.btn?.parentNode?.removeChild) {
        entry.btn.parentNode.removeChild(entry.btn);
      }
      if (entry.anchor) {
        anchorToEntry.delete(entry.anchor);
      }
      injectedEntries.delete(entry);
    }

    function cleanupOrphanedInlineButtons() {
      for (const entry of Array.from(injectedEntries)) {
        const anchorGone =
          !entry.anchor ||
          entry.anchor.isConnected === false ||
          (!entry.anchor.parentElement && !entry.anchor.parentNode);
        const btnGone =
          !entry.btn ||
          entry.btn.isConnected === false ||
          (!entry.btn.parentElement && !entry.btn.parentNode);
        if (anchorGone || btnGone) {
          removeEntry(entry);
        }
      }
    }

    let activeMenuTarget = null;
    let rowLockUntil = 0;
    let rowTrackingAttached = false;

    function isElementVisible(el) {
      if (!el || el.isConnected === false) return false;
      if (el.hidden || el.style?.display === "none") return false;
      if (typeof getComputedStyle === "function") {
        try {
          const cs = getComputedStyle(el);
          if (cs && (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")) {
            return false;
          }
        } catch {
          // ignore
        }
      }
      if (typeof el.getBoundingClientRect === "function") {
        const rect = el.getBoundingClientRect();
        if (rect && rect.width === 0 && rect.height === 0) return false;
      }
      return true;
    }

    function hasVisibleInjectedMenu() {
      for (const entry of injectedEntries) {
        if (entry.kind === "menu" && isElementVisible(entry.btn)) {
          return true;
        }
      }
      return false;
    }

    function dismissNativeMenu() {
      setTimeout(() => {
        try {
          if (typeof KeyboardEvent === "function" && typeof document.dispatchEvent === "function") {
            document.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })
            );
          }
          if (typeof MouseEvent === "function" && document.body && typeof document.body.dispatchEvent === "function") {
            document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
            document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          }
        } catch {
          // ignore
        }
      }, 0);
    }

    function handleRowPointerEvent(e) {
      updateActiveRowFromEvent(e, { strong: true });
    }

    function handleRowHoverEvent(e) {
      updateActiveRowFromEvent(e, { strong: false });
    }

    function updateActiveRowFromEvent(e, { strong = false } = {}) {
      if (!isEnabled || !inlineActions) return;
      if (typeof inlineActions.resolveRowContextFromTarget !== "function") return;
      const target = e?.target;
      if (!target || isOwnUiNode(target)) return;

      let ctx = null;
      try {
        ctx = inlineActions.resolveRowContextFromTarget(target);
      } catch {
        ctx = null;
      }
      if (!ctx || !ctx.item || (!ctx.item.id && !ctx.item.name)) return;

      const now = Date.now();
      if (strong) {
        activeMenuTarget = { item: ctx.item, row: ctx.row || null, updatedAt: now };
        rowLockUntil = now + 1200;
        scheduleInlineScan();
        setTimeout(() => {
          if (isEnabled) syncInlineButtons();
        }, 80);
        return;
      }

      if (ctx.isMoreTrigger) {
        activeMenuTarget = { item: ctx.item, row: ctx.row || null, updatedAt: now };
        rowLockUntil = now + 900;
        scheduleInlineScan();
        setTimeout(() => {
          if (isEnabled) syncInlineButtons();
        }, 80);
        return;
      }

      if (now >= rowLockUntil && !hasVisibleInjectedMenu()) {
        activeMenuTarget = { item: ctx.item, row: ctx.row || null, updatedAt: now };
      }
    }

    function attachRowTrackingListeners() {
      if (
        rowTrackingAttached ||
        !inlineActions ||
        typeof inlineActions.resolveRowContextFromTarget !== "function" ||
        typeof document.addEventListener !== "function"
      ) {
        return;
      }
      document.addEventListener("pointerdown", handleRowPointerEvent, true);
      document.addEventListener("mousedown", handleRowPointerEvent, true);
      document.addEventListener("click", handleRowPointerEvent, true);
      document.addEventListener("contextmenu", handleRowPointerEvent, true);
      document.addEventListener("mouseover", handleRowHoverEvent, true);
      rowTrackingAttached = true;
    }

    function detachRowTrackingListeners() {
      if (!rowTrackingAttached || typeof document.removeEventListener !== "function") {
        rowTrackingAttached = false;
        return;
      }
      document.removeEventListener("pointerdown", handleRowPointerEvent, true);
      document.removeEventListener("mousedown", handleRowPointerEvent, true);
      document.removeEventListener("click", handleRowPointerEvent, true);
      document.removeEventListener("contextmenu", handleRowPointerEvent, true);
      document.removeEventListener("mouseover", handleRowHoverEvent, true);
      rowTrackingAttached = false;
    }

    function clearInlineButtons() {
      if (inlineObserver) {
        inlineObserver.disconnect();
        inlineObserver = null;
      }
      detachRowTrackingListeners();
      activeMenuTarget = null;
      rowLockUntil = 0;
      inlineScanScheduled = false;
      for (const entry of Array.from(injectedEntries)) {
        removeEntry(entry);
      }
      if (typeof document.querySelectorAll === "function") {
        try {
          document
            .querySelectorAll(".pd-inline-btn, .pd-inline-menu-item")
            .forEach((el) => {
              if (typeof el.remove === "function") el.remove();
            });
        } catch {
          // ignore
        }
      }
    }

    function createInlineToolbarButton(onActivate) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pd-inline-btn pd-inline-toolbar-btn";
      if (typeof btn.setAttribute === "function") {
        btn.setAttribute("data-pd-inline", "toolbar");
        btn.setAttribute("aria-label", getInlineTooltip("toolbar"));
      }
      btn.title = getInlineTooltip("toolbar");
      btn.innerHTML = `<span class="pd-inline-toolbar-icon">${renderBrandIconSvg()}</span><span>PD 直下</span>`;

      const stopBubble = (e) => {
        if (typeof e.stopPropagation === "function") e.stopPropagation();
      };
      btn.addEventListener("mousedown", stopBubble);
      btn.addEventListener("pointerdown", stopBubble);
      btn.addEventListener("click", async (e) => {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") {
          e.stopImmediatePropagation();
        }
        if (btn.classList.contains("pd-inline-busy")) return;
        btn.classList.add("pd-inline-busy");
        try {
          await onActivate();
        } finally {
          btn.classList.remove("pd-inline-busy");
        }
      });

      return btn;
    }

    function createInlineMenuItem(itemTag, onActivate) {
      const tag = String(itemTag || "div").toLowerCase() === "li" ? "li" : "div";
      const itemEl = document.createElement(tag);
      itemEl.className = "pd-inline-menu-item";
      if (typeof itemEl.setAttribute === "function") {
        itemEl.setAttribute("role", "menuitem");
        itemEl.setAttribute("tabindex", "0");
        itemEl.setAttribute("data-pd-inline", "menu");
        itemEl.setAttribute("aria-label", getInlineTooltip("menu"));
      }
      itemEl.title = getInlineTooltip("menu");
      itemEl.innerHTML = `<span class="pd-inline-menu-icon">${renderBrandIconSvg()}</span><span class="pd-inline-menu-label">直连下载</span>`;

      const stopBubble = (e) => {
        if (typeof e.stopPropagation === "function") e.stopPropagation();
      };
      itemEl.addEventListener("mousedown", stopBubble);
      itemEl.addEventListener("pointerdown", stopBubble);

      const activate = async (e) => {
        if (typeof e?.preventDefault === "function") e.preventDefault();
        if (typeof e?.stopPropagation === "function") e.stopPropagation();
        if (typeof e?.stopImmediatePropagation === "function") {
          e.stopImmediatePropagation();
        }
        if (itemEl.classList.contains("pd-inline-busy")) return;
        const snapshot = activeMenuTarget?.item ? { ...activeMenuTarget.item } : null;
        dismissNativeMenu();
        itemEl.classList.add("pd-inline-busy");
        try {
          await onActivate(snapshot);
        } finally {
          itemEl.classList.remove("pd-inline-busy");
        }
      };

      itemEl.addEventListener("click", activate);
      itemEl.addEventListener("keydown", (e) => {
        if (e?.key === "Enter" || e?.key === " ") {
          activate(e);
        }
      });

      return itemEl;
    }

    function hasSiblingInlineNode(anchor, kind) {
      const parent = anchor?.parentElement || anchor?.parentNode;
      if (!parent || typeof parent.querySelector !== "function") return false;
      if (kind === "toolbar") {
        return Boolean(parent.querySelector(".pd-inline-toolbar-btn"));
      }
      if (kind === "menu") {
        return Boolean(parent.querySelector(".pd-inline-menu-item"));
      }
      return false;
    }

    function syncInlineButtons() {
      inlineScanScheduled = false;
      if (!inlineActions || !isEnabled) return;

      cleanupOrphanedInlineButtons();

      if (typeof inlineActions.findMenuAnchors === "function") {
        let menuTargets = [];
        try {
          menuTargets = inlineActions.findMenuAnchors(document) || [];
        } catch {
          menuTargets = [];
        }

        for (const target of menuTargets) {
          const anchor = target?.anchor;
          if (!anchor) continue;
          if (typeof anchor.closest === "function" && anchor.closest("#pandirect-root")) {
            continue;
          }
          if (anchorToEntry.has(anchor) || hasSiblingInlineNode(anchor, "menu")) {
            continue;
          }
          const position = target.insertPosition || "beforebegin";
          const directItemGetter =
            typeof target.getItem === "function" ? target.getItem : null;
          const itemEl = createInlineMenuItem(target.itemTag, (snapshot) => {
            const resolved = directItemGetter ? directItemGetter() : snapshot;
            return handleInlineRowDownload(resolved || snapshot);
          });
          if (insertAdjacentCompat(anchor, position, itemEl)) {
            const entry = { btn: itemEl, anchor, kind: "menu" };
            injectedEntries.add(entry);
            anchorToEntry.set(anchor, entry);
          }
        }
      }

      if (typeof inlineActions.findToolbarAnchors === "function") {
        let toolbarTargets = [];
        try {
          toolbarTargets = inlineActions.findToolbarAnchors(document) || [];
        } catch {
          toolbarTargets = [];
        }

        for (const target of toolbarTargets) {
          const anchor = target?.anchor;
          if (!anchor) continue;
          if (typeof anchor.closest === "function" && anchor.closest("#pandirect-root")) {
            continue;
          }
          if (anchorToEntry.has(anchor) || hasSiblingInlineNode(anchor, "toolbar")) {
            continue;
          }
          const position = target.insertPosition || "afterend";
          const btn = createInlineToolbarButton(() => handleDownloadSelected());
          if (insertAdjacentCompat(anchor, position, btn)) {
            const entry = { btn, anchor, kind: "toolbar" };
            injectedEntries.add(entry);
            anchorToEntry.set(anchor, entry);
          }
        }
      }
    }

    function scheduleInlineScan() {
      if (!inlineActions || !isEnabled || inlineScanScheduled) return;
      inlineScanScheduled = true;
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => syncInlineButtons());
      } else {
        setTimeout(() => syncInlineButtons(), 16);
      }
    }

    function isOwnUiNode(node) {
      if (!node || node.nodeType !== 1) return false;
      if (node.id === "pandirect-root") return true;
      if (
        node.classList?.contains("pd-inline-btn") ||
        node.classList?.contains("pd-inline-menu-item")
      ) {
        return true;
      }
      if (
        typeof node.closest === "function" &&
        (node.closest("#pandirect-root") ||
          node.closest(".pd-inline-btn") ||
          node.closest(".pd-inline-menu-item"))
      ) {
        return true;
      }
      return false;
    }

    function startInlineObserver() {
      if (!inlineActions || !isEnabled) return;
      attachRowTrackingListeners();
      syncInlineButtons();
      if (inlineObserver || typeof MutationObserver !== "function" || !document.body) {
        return;
      }
      inlineObserver = new MutationObserver((mutations) => {
        if (!isEnabled) return;
        for (const m of mutations) {
          if (m.target && isOwnUiNode(m.target)) continue;
          let relevant = false;
          for (const n of m.addedNodes || []) {
            if (!isOwnUiNode(n)) {
              relevant = true;
              break;
            }
          }
          if (!relevant) {
            for (const n of m.removedNodes || []) {
              if (!isOwnUiNode(n)) {
                relevant = true;
                break;
              }
            }
          }
          if (relevant) {
            scheduleInlineScan();
            return;
          }
        }
      });
      inlineObserver.observe(document.body, { childList: true, subtree: true });
    }

    fab.addEventListener("click", async () => {
      const isHidden = drawer.classList.contains("pd-hidden");
      drawer.classList.toggle("pd-hidden", !isHidden);
      if (isHidden) {
        hideToast();
        await syncDefaultMode();
        await loadDirectory(getCurrentDir(), { resetHistory: true });
      }
    });

    closeBtn.addEventListener("click", () => {
      drawer.classList.add("pd-hidden");
    });

    upBtn.addEventListener("click", () => {
      if (navStack.length > 0) {
        const prev = navStack.pop();
        loadDirectory(prev);
        return;
      }
      if (activeParentDir !== null && activeParentDir !== undefined) {
        const parentDisplay =
          activeParentDir === rootDir || activeParentDir === "/"
            ? "/"
            : getParentPath(activeDisplayPath);
        loadDirectory({ dir: activeParentDir, displayPath: parentDisplay });
        return;
      }
      if (typeof activeDir === "string" && activeDir.startsWith("/")) {
        loadDirectory(getParentPath(activeDir));
        return;
      }
      loadDirectory({ dir: rootDir, displayPath: "/" }, { resetHistory: true });
    });

    refreshBtn.addEventListener("click", () => {
      loadDirectory(getCurrentDir(), { resetHistory: true });
    });

    dlDirBtn.addEventListener("click", () => {
      openFolderDownloader(activeDir, activeDisplayPath);
    });

    root.querySelectorAll('input[name="pd-mode"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        currentDownloadMode = radio.value === "aria2" ? "aria2" : "browser";
        modeSynced = true;
        refreshInlineButtonTooltips();
        if (adapter.aria2Notice && radio.value === "aria2") {
          showNotice(adapter.aria2Notice, "info");
        }
      });
    });

    dlSelectedBtn.addEventListener("click", () => {
      handleDownloadSelected();
    });

    function applyEnabledState(enabled) {
      isEnabled = enabled !== false;
      root.classList.toggle("pd-hidden", !isEnabled);
      if (!isEnabled) {
        drawer.classList.add("pd-hidden");
        hideToast();
        clearInlineButtons();
      } else {
        startInlineObserver();
      }
    }

    async function initEnabledVisibility() {
      try {
        if (typeof chrome !== "undefined" && chrome.storage?.local?.get) {
          const stored = await chrome.storage.local.get({
            enabled: true,
            downloadMode: "browser",
          });
          if (stored?.downloadMode) {
            applyDownloadMode(stored.downloadMode);
          }
          applyEnabledState(stored?.enabled !== false);
          return;
        }
      } catch {
        // fall through to background status check
      }

      try {
        const status = await sendMessage({ type: "PANDIRECT_GET_STATUS" });
        if (status?.ok && status.downloadMode) {
          applyDownloadMode(status.downloadMode);
        }
        applyEnabledState(status?.ok ? status.enabled !== false : true);
      } catch {
        applyEnabledState(true);
      }
    }

    if (typeof chrome !== "undefined" && chrome.storage?.onChanged?.addListener) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        if (changes.downloadMode) {
          applyDownloadMode(changes.downloadMode.newValue);
        }
        if (changes.enabled) {
          applyEnabledState(changes.enabled.newValue);
        }
      });
    }

    if (inlineActions && typeof window.addEventListener === "function") {
      window.addEventListener("hashchange", () => {
        cachedAt = 0;
        scheduleInlineScan();
      });
    }

    initEnabledVisibility();
  }

  window.PanDirectDrawer = { mount };
})();
