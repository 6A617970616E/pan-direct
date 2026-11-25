const params = new URLSearchParams(window.location.search);
const targetProviderId = params.get("provider") || "baidu";
const targetFolderPath = params.get("path") || "/";
const targetFolderLabel = params.get("label") || "";
const preferredMode = params.get("mode") || "browser";

const folderPathText = document.getElementById("folderPathText");
const providerPill = document.getElementById("providerPill");
const fileCountPill = document.getElementById("fileCountPill");
const totalSizePill = document.getElementById("totalSizePill");
const rescanBtn = document.getElementById("rescanBtn");
const startBrowserBtn = document.getElementById("startBrowserBtn");
const pushAria2Btn = document.getElementById("pushAria2Btn");
const retryBtn = document.getElementById("retryBtn");
const stopBtn = document.getElementById("stopBtn");
const concurrencySelect = document.getElementById("concurrencySelect");
const skipExistingCheck = document.getElementById("skipExistingCheck");
const bannerEl = document.getElementById("banner");
const overallStatusText = document.getElementById("overallStatusText");
const overallSpeedText = document.getElementById("overallSpeedText");
const overallBar = document.getElementById("overallBar");
const fileListEl = document.getElementById("fileList");
const feedbackLink = document.getElementById("feedbackLink");

const FEEDBACK_ISSUES_BASE_URL =
  "https://github.com/6A617970616E/pan-direct/issues/new";

const initialDisplayLabel =
  targetFolderLabel || (targetFolderPath === "0" ? "/" : targetFolderPath);
folderPathText.textContent = initialDisplayLabel;
if (providerPill) {
  providerPill.textContent = targetProviderId;
}

let tasks = [];
let totalBytes = 0;
let isRunning = false;
let stopRequested = false;
let activeAbortControllers = new Set();
let lastChosenDirHandle = null;
let lastRunMode = preferredMode;
let currentProviderName = "";

// Speed tracking
let bytesCompletedBeforeActive = 0;
let speedSampleBytes = 0;
let speedSampleTime = Date.now();
let currentSpeedBps = 0;

function detectBrowserSummary() {
  const ua =
    typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
      ? navigator.userAgent
      : "";
  if (!ua) return "";

  let browser = "Browser";
  const edgeMatch = ua.match(/Edg\/([\d.]+)/);
  const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
  const firefoxMatch = ua.match(/Firefox\/([\d.]+)/);
  if (edgeMatch) browser = `Edge ${edgeMatch[1].split(".")[0]}`;
  else if (chromeMatch) browser = `Chrome ${chromeMatch[1].split(".")[0]}`;
  else if (firefoxMatch) browser = `Firefox ${firefoxMatch[1].split(".")[0]}`;

  let os = "";
  if (/Windows/i.test(ua)) os = "Windows";
  else if (/Macintosh|Mac OS X/i.test(ua)) os = "macOS";
  else if (/CrOS/i.test(ua)) os = "ChromeOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  return os ? `${browser} / ${os}` : browser;
}

function updateFeedbackLink({
  providerName = currentProviderName,
  mode = lastRunMode,
} = {}) {
  if (!feedbackLink) return;
  const query = new URLSearchParams();
  query.set("template", "bug_report.yml");

  const manifest =
    typeof chrome !== "undefined" &&
    typeof chrome.runtime?.getManifest === "function"
      ? chrome.runtime.getManifest()
      : null;
  if (manifest?.version) {
    const editionHint =
      typeof manifest.name === "string" && manifest.name.includes("Community")
        ? "(Community)"
        : "";
    query.set(
      "version",
      [`v${manifest.version}`, editionHint].filter(Boolean).join(" ")
    );
  }

  const browserText = detectBrowserSummary();
  if (browserText) {
    query.set("browser", browserText);
  }

  if (providerName) {
    query.set("provider", providerName);
  }

  query.set("scene", "整文件夹流式下载器");
  if (mode === "aria2") {
    query.set("mode", "推送 Aria2");
  } else if (mode === "browser") {
    query.set("mode", "浏览器原生直下");
  }

  feedbackLink.href = `${FEEDBACK_ISSUES_BASE_URL}?${query.toString()}`;
}

updateFeedbackLink();

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function showBanner(text, type = "info") {
  bannerEl.textContent = text;
  bannerEl.className = `banner ${type}`;
}

function hideBanner() {
  bannerEl.className = "banner hidden";
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

function updateRowUi(task) {
  if (!task.dom) return;
  const { statusEl, barEl } = task.dom;
  statusEl.className = `status-label ${task.state}`;
  statusEl.textContent = task.statusText;
  statusEl.title = task.statusText;

  const pct =
    task.size > 0
      ? Math.min(100, Math.round((task.loaded / task.size) * 100))
      : task.state === "done" || task.state === "skipped"
      ? 100
      : 0;
  barEl.style.width = `${pct}%`;
  barEl.style.background =
    task.state === "done"
      ? "#10b981"
      : task.state === "error"
      ? "#ef4444"
      : task.state === "skipped"
      ? "#f59e0b"
      : "#2563eb";
}

function updateOverallUi() {
  const doneCount = tasks.filter(
    (t) => t.state === "done" || t.state === "skipped"
  ).length;
  const failedCount = tasks.filter((t) => t.state === "error").length;
  const loadedBytes = tasks.reduce((sum, t) => sum + (t.loaded || 0), 0);

  const pct =
    totalBytes > 0
      ? Math.min(100, Math.round((loadedBytes / totalBytes) * 100))
      : tasks.length > 0
      ? Math.round((doneCount / tasks.length) * 100)
      : 0;

  overallBar.style.width = `${pct}%`;
  overallStatusText.textContent = `已完成 ${doneCount} / ${tasks.length} 个文件${
    failedCount > 0 ? `（失败 ${failedCount} 个）` : ""
  } · ${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)} (${pct}%)`;

  const now = Date.now();
  const elapsed = (now - speedSampleTime) / 1000;
  if (elapsed >= 0.5) {
    const delta = Math.max(0, loadedBytes - speedSampleBytes);
    currentSpeedBps = delta / elapsed;
    speedSampleBytes = loadedBytes;
    speedSampleTime = now;
  }

  overallSpeedText.textContent = isRunning
    ? `${formatBytes(currentSpeedBps)}/s`
    : "空闲";
}

function renderEmptyFileList(text) {
  fileListEl.textContent = "";
  const emptyEl = document.createElement("div");
  emptyEl.className = "empty";
  emptyEl.textContent = text;
  fileListEl.appendChild(emptyEl);
}

function renderTaskList() {
  if (tasks.length === 0) {
    renderEmptyFileList("该文件夹内没有可下载的文件");
    return;
  }

  fileListEl.textContent = "";
  const frag = document.createDocumentFragment();

  tasks.forEach((task) => {
    const row = document.createElement("div");
    row.className = "file-row";

    const pathDiv = document.createElement("div");
    pathDiv.className = "file-path";
    pathDiv.textContent = task.relativePath;
    pathDiv.title = task.relativePath;

    const sizeDiv = document.createElement("div");
    sizeDiv.className = "file-size";
    sizeDiv.textContent = formatBytes(task.size);

    const statusCell = document.createElement("div");
    statusCell.className = "status-cell";

    const statusEl = document.createElement("div");
    statusEl.className = `status-label ${task.state}`;
    statusEl.textContent = task.statusText;

    const track = document.createElement("div");
    track.className = "mini-track";
    const barEl = document.createElement("div");
    barEl.className = "mini-fill";
    barEl.style.width = "0%";
    track.appendChild(barEl);

    statusCell.appendChild(statusEl);
    statusCell.appendChild(track);

    row.appendChild(pathDiv);
    row.appendChild(sizeDiv);
    row.appendChild(statusCell);
    frag.appendChild(row);

    task.dom = { statusEl, barEl };
  });

  fileListEl.appendChild(frag);
}

function setButtonsState() {
  const hasTasks = tasks.length > 0;
  const hasFailed = tasks.some((t) => t.state === "error");

  startBrowserBtn.disabled = isRunning || !hasTasks;
  pushAria2Btn.disabled = isRunning || !hasTasks;
  rescanBtn.disabled = isRunning;
  stopBtn.classList.toggle("hidden", !isRunning);
  retryBtn.classList.toggle("hidden", isRunning || !hasFailed);
}

async function scanFolder() {
  hideBanner();
  tasks = [];
  totalBytes = 0;
  fileCountPill.textContent = "扫描中...";
  totalSizePill.textContent = "0 B";
  renderEmptyFileList(`正在递归扫描 ${initialDisplayLabel} ...`);
  setButtonsState();

  try {
    const res = await sendMessage({
      type: "PANDIRECT_LIST_FOLDER_RECURSIVE",
      provider: targetProviderId,
      path: targetFolderPath,
    });

    if (!res?.ok) {
      showBanner(res?.error || "扫描目录失败", "err");
      fileCountPill.textContent = "扫描失败";
      renderEmptyFileList("扫描失败，请确认已完成网盘授权且有目录权限。");
      return;
    }

    if (res.providerName) {
      currentProviderName = res.providerName;
      if (providerPill) {
        providerPill.textContent = res.providerName;
      }
      updateFeedbackLink({ providerName: currentProviderName });
    }

    if (res.displayPath && !targetFolderLabel) {
      folderPathText.textContent = res.displayPath;
    }

    tasks = (res.files || []).map((f) => ({
      ...f,
      id: f.id || f.fsId,
      state: "pending",
      statusText: "等待开始",
      loaded: 0,
      dom: null,
    }));
    totalBytes = res.totalSize || 0;

    fileCountPill.textContent = `${tasks.length} 个文件`;
    totalSizePill.textContent = formatBytes(totalBytes);

    if (res.truncated) {
      const limitLabel = Number(res.maxFiles || 10000).toLocaleString("en-US");
      showBanner(
        `目录内文件数量超过 ${limitLabel} 上限，当前仅展示前 ${limitLabel} 个文件。`,
        "info"
      );
    } else if (preferredMode === "aria2") {
      showBanner("扫描完成！点击「全部推送到 Aria2」即可保留目录结构批量推送。", "info");
    }

    renderTaskList();
    updateOverallUi();
    setButtonsState();
  } catch (err) {
    showBanner(err?.message || "扫描异常", "err");
    fileCountPill.textContent = "扫描失败";
  }
}

async function getNestedFileHandle(rootDirHandle, relativePath, create = true) {
  const parts = relativePath.split("/").filter(Boolean);
  let dir = rootDirHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create });
  }
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

async function checkFileExistsWithSameSize(rootDirHandle, relativePath, expectedSize) {
  try {
    const handle = await getNestedFileHandle(rootDirHandle, relativePath, false);
    const file = await handle.getFile();
    return file.size === expectedSize;
  } catch {
    return false;
  }
}

async function downloadSingleFileToDisk(task, rootDirHandle) {
  if (stopRequested) return;

  if (skipExistingCheck.checked && task.size >= 0) {
    const same = await checkFileExistsWithSameSize(
      rootDirHandle,
      task.relativePath,
      task.size
    );
    if (same) {
      task.state = "skipped";
      task.loaded = task.size;
      task.statusText = "已跳过（本地已存在）";
      updateRowUi(task);
      updateOverallUi();
      return;
    }
  }

  task.state = "active";
  task.loaded = 0;
  task.statusText = "获取直链中...";
  updateRowUi(task);

  const meta = await sendMessage({
    type: "PANDIRECT_GET_FILE_STREAM_URL",
    provider: targetProviderId,
    itemId: task.id || task.fsId,
    fsId: task.fsId || task.id,
  });

  if (!meta?.ok || !meta.url) {
    throw new Error(meta?.error || "获取直链失败");
  }

  if (stopRequested) return;

  const controller = new AbortController();
  activeAbortControllers.add(controller);
  let writable = null;

  try {
    task.statusText = "连接下载节点...";
    updateRowUi(task);

    const res = await fetch(meta.url, {
      method: "GET",
      credentials: meta.credentials || "omit",
      redirect: "follow",
      signal: controller.signal,
    });

    if (!res.ok) {
      let snippet = "";
      try {
        snippet = (await res.text()).replace(/\s+/g, " ").trim().slice(0, 120);
      } catch {
        // ignore
      }
      throw new Error(`HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`);
    }

    const fileHandle = await getNestedFileHandle(
      rootDirHandle,
      task.relativePath,
      true
    );
    writable = await fileHandle.createWritable();

    if (!res.body) {
      const buf = await res.arrayBuffer();
      await writable.write(buf);
      await writable.close();
      writable = null;
      task.loaded = buf.byteLength;
    } else {
      const reader = res.body.getReader();
      let lastUiTick = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (stopRequested) {
          controller.abort();
          throw new Error("用户已停止");
        }
        await writable.write(value);
        task.loaded += value.byteLength;

        const now = Date.now();
        if (now - lastUiTick >= 200) {
          const pct =
            task.size > 0
              ? Math.min(100, Math.round((task.loaded / task.size) * 100))
              : 0;
          task.statusText = `下载中 ${pct}% (${formatBytes(task.loaded)})`;
          updateRowUi(task);
          updateOverallUi();
          lastUiTick = now;
        }
      }

      await writable.close();
      writable = null;
    }

    task.state = "done";
    task.loaded = task.size || task.loaded;
    task.statusText = "已完成";
    updateRowUi(task);
    updateOverallUi();
  } catch (err) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    activeAbortControllers.delete(controller);
  }
}

async function pushSingleFileToAria2(task) {
  if (stopRequested) return;
  task.state = "active";
  task.statusText = "获取直链并推送 Aria2...";
  updateRowUi(task);

  const res = await sendMessage({
    type: "PANDIRECT_PUSH_ITEM_TO_ARIA2",
    provider: targetProviderId,
    itemId: task.id || task.fsId,
    fsId: task.fsId || task.id,
    relativePath: task.relativePath,
  });

  if (!res?.ok) {
    throw new Error(res?.error || "Aria2 推送失败");
  }

  task.state = "done";
  task.loaded = task.size;
  task.statusText = `已推送 Aria2 (${res.gid})`;
  updateRowUi(task);
  updateOverallUi();
}

async function runQueue(targetTasks, mode, dirHandle) {
  isRunning = true;
  stopRequested = false;
  lastRunMode = mode;
  updateFeedbackLink({ mode });
  bytesCompletedBeforeActive = tasks.reduce((s, t) => s + (t.loaded || 0), 0);
  speedSampleBytes = bytesCompletedBeforeActive;
  speedSampleTime = Date.now();
  currentSpeedBps = 0;
  setButtonsState();

  const concurrency = Math.max(1, Math.min(3, Number(concurrencySelect.value) || 2));
  let cursor = 0;

  async function worker() {
    while (!stopRequested) {
      const idx = cursor++;
      if (idx >= targetTasks.length) break;
      const task = targetTasks[idx];

      try {
        if (mode === "aria2") {
          await pushSingleFileToAria2(task);
        } else {
          await downloadSingleFileToDisk(task, dirHandle);
        }
      } catch (err) {
        if (stopRequested || err?.name === "AbortError") {
          task.state = "error";
          task.statusText = "已停止";
        } else {
          task.state = "error";
          task.statusText = `失败：${err?.message || String(err)}`;
        }
        updateRowUi(task);
        updateOverallUi();
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, targetTasks.length) },
    () => worker()
  );
  await Promise.all(workers);

  isRunning = false;
  updateOverallUi();
  setButtonsState();

  const failedCount = tasks.filter((t) => t.state === "error").length;
  if (stopRequested) {
    showBanner("任务已停止，可点击「重试失败项」继续剩余文件。", "info");
  } else if (failedCount === 0) {
    showBanner(
      mode === "aria2"
        ? `全部 ${tasks.length} 个文件已按原始目录结构推送到 Aria2！`
        : `全部 ${tasks.length} 个文件已下载完成并按原始目录结构保存！`,
      "ok"
    );
  } else {
    showBanner(`处理完成，有 ${failedCount} 个文件失败，可点击「重试失败项」。`, "err");
  }
}

startBrowserBtn.addEventListener("click", async () => {
  if (typeof window.showDirectoryPicker !== "function") {
    showBanner("当前浏览器不支持 File System Access API，请使用最新版 Chrome 或 Edge。", "err");
    return;
  }

  try {
    const dirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
    lastChosenDirHandle = dirHandle;
    hideBanner();

    const pending = tasks.filter((t) => t.state !== "done" && t.state !== "skipped");
    if (pending.length === 0) {
      showBanner("所有文件已完成。", "ok");
      return;
    }

    await runQueue(pending, "browser", dirHandle);
  } catch (err) {
    if (err?.name !== "AbortError") {
      showBanner(`无法打开本地目录：${err?.message || err}`, "err");
    }
  }
});

pushAria2Btn.addEventListener("click", async () => {
  hideBanner();
  const pending = tasks.filter((t) => t.state !== "done" && t.state !== "skipped");
  if (pending.length === 0) {
    showBanner("所有文件已推送完成。", "ok");
    return;
  }
  await runQueue(pending, "aria2", null);
});

retryBtn.addEventListener("click", async () => {
  const failed = tasks.filter((t) => t.state === "error");
  if (failed.length === 0) return;

  failed.forEach((t) => {
    t.state = "pending";
    t.loaded = 0;
    t.statusText = "等待重试";
    updateRowUi(t);
  });

  if (lastRunMode === "browser") {
    if (!lastChosenDirHandle) {
      try {
        lastChosenDirHandle = await window.showDirectoryPicker({ mode: "readwrite" });
      } catch {
        return;
      }
    }
    await runQueue(failed, "browser", lastChosenDirHandle);
  } else {
    await runQueue(failed, "aria2", null);
  }
});

stopBtn.addEventListener("click", () => {
  stopRequested = true;
  activeAbortControllers.forEach((ctrl) => ctrl.abort());
  activeAbortControllers.clear();
});

rescanBtn.addEventListener("click", () => {
  scanFolder();
});

scanFolder();
