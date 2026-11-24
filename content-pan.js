(() => {
  if (window.__PANDIRECT_INJECTED__) return;
  window.__PANDIRECT_INJECTED__ = true;

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

  function getParentDir(dir) {
    const clean = (dir || "/").replace(/\/+$/, "");
    if (!clean || clean === "/") return "/";
    const idx = clean.lastIndexOf("/");
    return idx <= 0 ? "/" : clean.slice(0, idx);
  }

  function getSelectedItemsFromDom() {
    const fsIds = new Set();
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
        fsIds.add(attrId);
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
      fsIds: Array.from(fsIds),
      names: Array.from(names),
    };
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

  const root = document.createElement("div");
  root.id = "pandirect-root";
  root.innerHTML = `
    <button id="pd-fab" title="打开 PanDirect 直链下载面板">
      <span class="pd-fab-badge">PD</span>
      <span>PanDirect 直下</span>
    </button>

    <div id="pd-drawer" class="pd-hidden" role="dialog" aria-label="PanDirect 直链下载">
      <div class="pd-header">
        <div class="pd-title-wrap">
          <span class="pd-logo">PD</span>
          <div>
            <div class="pd-title">PanDirect 直链下载</div>
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
  let activeDir = "/";

  function getSelectedMode() {
    const checked = root.querySelector('input[name="pd-mode"]:checked');
    return checked ? checked.value : "browser";
  }

  function showNotice(text, type = "info") {
    noticeEl.textContent = text;
    noticeEl.className = `pd-notice pd-notice-${type}`;
  }

  function hideNotice() {
    noticeEl.className = "pd-notice pd-hidden";
  }

  async function syncDefaultMode() {
    try {
      const status = await sendMessage({ type: "PANDIRECT_GET_STATUS" });
      if (status?.ok) {
        const radio = root.querySelector(
          `input[name="pd-mode"][value="${status.downloadMode || "browser"}"]`
        );
        if (radio) radio.checked = true;
      }
    } catch {
      // ignore
    }
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

  async function openFolderDownloader(folderPath) {
    const mode = getSelectedMode();
    try {
      const res = await sendMessage({
        type: "PANDIRECT_OPEN_FOLDER_DOWNLOADER",
        path: folderPath,
        mode,
      });
      if (!res?.ok) {
        showNotice(res?.error || "打开文件夹下载器失败", "error");
      }
    } catch (err) {
      showNotice(err?.message || "调用失败", "error");
    }
  }

  async function triggerDownloadFsIds(fsIds) {
    const mode = getSelectedMode();
    showNotice(
      mode === "aria2"
        ? `正在获取直链并推送 ${fsIds.length} 个文件到 Aria2...`
        : `正在预检直链并启动浏览器原生下载（${fsIds.length} 个文件）...`,
      "info"
    );

    try {
      const res = await sendMessage({
        type: "PANDIRECT_DOWNLOAD_FSIDS",
        fsIds,
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

  function renderFileList(files) {
    if (!files || files.length === 0) {
      listEl.innerHTML = `<div class="pd-empty">当前目录为空</div>`;
      return;
    }

    listEl.innerHTML = "";
    files.forEach((file) => {
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
        const openBtn = document.createElement("button");
        openBtn.className = "pd-btn-ghost pd-btn-sm";
        openBtn.textContent = "进入";
        openBtn.addEventListener("click", () => loadDirectory(file.path));

        const dlFolderBtn = document.createElement("button");
        dlFolderBtn.className = "pd-btn-primary pd-btn-sm";
        dlFolderBtn.textContent = "下整夹";
        dlFolderBtn.title = "打开整文件夹流式下载器（保留完整子目录结构）";
        dlFolderBtn.addEventListener("click", () => openFolderDownloader(file.path));

        btnWrap.appendChild(openBtn);
        btnWrap.appendChild(dlFolderBtn);
      } else {
        const dlBtn = document.createElement("button");
        dlBtn.className = "pd-btn-primary pd-btn-sm";
        dlBtn.textContent = "直下";
        dlBtn.addEventListener("click", () => triggerDownloadFsIds([file.fsId]));
        btnWrap.appendChild(dlBtn);
      }

      row.appendChild(btnWrap);
      listEl.appendChild(row);
    });
  }

  async function loadDirectory(targetDir) {
    activeDir = targetDir || getCurrentPathFromUrl();
    pathEl.textContent = activeDir;
    upBtn.classList.toggle("pd-hidden", activeDir === "/");
    hideNotice();
    listEl.innerHTML = `<div class="pd-empty">正在读取目录 ${activeDir} ...</div>`;

    try {
      const res = await sendMessage({
        type: "PANDIRECT_LIST_FILES",
        dir: activeDir,
      });

      if (!res?.ok) {
        cachedFiles = [];
        showNotice(res?.error || "读取目录失败", "error");
        listEl.innerHTML = `
          <div class="pd-empty">
            读取失败。如果是应用沙盒限制，可尝试点击下方进入专属目录：
            <div style="margin-top:8px;">
              <button id="pd-try-apps" class="pd-btn-ghost pd-btn-sm">尝试打开 /apps/PanDirect</button>
            </div>
          </div>
        `;
        const tryAppsBtn = listEl.querySelector("#pd-try-apps");
        if (tryAppsBtn) {
          tryAppsBtn.addEventListener("click", () => loadDirectory("/apps/PanDirect"));
        }
        return;
      }

      cachedFiles = res.files || [];
      renderFileList(cachedFiles);
    } catch (err) {
      showNotice(err?.message || "请求失败", "error");
    }
  }

  fab.addEventListener("click", async () => {
    const isHidden = drawer.classList.contains("pd-hidden");
    drawer.classList.toggle("pd-hidden", !isHidden);
    if (isHidden) {
      await syncDefaultMode();
      await loadDirectory(getCurrentPathFromUrl());
    }
  });

  closeBtn.addEventListener("click", () => {
    drawer.classList.add("pd-hidden");
  });

  upBtn.addEventListener("click", () => {
    loadDirectory(getParentDir(activeDir));
  });

  refreshBtn.addEventListener("click", () => {
    loadDirectory(getCurrentPathFromUrl());
  });

  dlDirBtn.addEventListener("click", () => {
    openFolderDownloader(activeDir);
  });

  dlSelectedBtn.addEventListener("click", async () => {
    const domSel = getSelectedItemsFromDom();
    const nameSet = new Set(domSel.names);
    const idSet = new Set(domSel.fsIds);

    const matchedItems = cachedFiles.filter(
      (f) => idSet.has(f.fsId) || nameSet.has(f.name)
    );

    const selectedFolders = matchedItems.filter((f) => f.isdir);
    const selectedFiles = matchedItems.filter((f) => !f.isdir);

    if (selectedFolders.length === 1 && selectedFiles.length === 0) {
      await openFolderDownloader(selectedFolders[0].path);
      return;
    }

    if (selectedFolders.length > 0 && selectedFiles.length === 0) {
      showNotice("勾选了多个文件夹，请逐个点击对应文件夹右侧的「下整夹」。", "info");
      return;
    }

    let targetFsIds = selectedFiles.map((f) => f.fsId);
    if (targetFsIds.length === 0 && domSel.fsIds.length > 0) {
      targetFsIds = domSel.fsIds;
    }

    if (targetFsIds.length === 0) {
      showNotice(
        "未检测到页面已勾选的文件，请先在网盘列表勾选文件，或直接在下方列表点击「直下 / 下整夹」。",
        "info"
      );
      return;
    }

    await triggerDownloadFsIds(targetFsIds);
  });
})();
