const enabledToggle = document.getElementById("enabledToggle");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const ruleBadge = document.getElementById("ruleBadge");
const authPill = document.getElementById("authPill");
const appKeyInput = document.getElementById("appKeyInput");
const oauthBtn = document.getElementById("oauthBtn");
const authActionsRow = document.getElementById("authActionsRow");
const tokenExpireText = document.getElementById("tokenExpireText");
const logoutBtn = document.getElementById("logoutBtn");
const oauthFeedback = document.getElementById("oauthFeedback");
const aria2Details = document.getElementById("aria2Details");
const aria2UrlInput = document.getElementById("aria2UrlInput");
const aria2SecretInput = document.getElementById("aria2SecretInput");
const saveAria2Btn = document.getElementById("saveAria2Btn");
const testAria2Btn = document.getElementById("testAria2Btn");
const aria2Feedback = document.getElementById("aria2Feedback");
const dlinkInput = document.getElementById("dlinkInput");
const filenameInput = document.getElementById("filenameInput");
const downloadBtn = document.getElementById("downloadBtn");
const downloadFeedback = document.getElementById("downloadFeedback");
const uaInput = document.getElementById("uaInput");
const saveUaBtn = document.getElementById("saveUaBtn");
const uaFeedback = document.getElementById("uaFeedback");
const versionText = document.getElementById("versionText");
const editionTag = document.getElementById("editionTag");
const providersHint = document.getElementById("providersHint");

function setFeedback(el, text, type) {
  el.textContent = text;
  el.className = "feedback" + (type ? ` ${type}` : "");
}

function formatRemainingDays(expiresAt) {
  if (!expiresAt) return "有效";
  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return "已过期，请重新授权";
  const days = Math.ceil(diffMs / (86400 * 1000));
  return `Token 剩余约 ${days} 天`;
}

function renderStatus(res) {
  enabledToggle.checked = Boolean(res.enabled);
  uaInput.value = res.userAgent || "pan.baidu.com";
  ruleBadge.textContent = `${res.activeRuleCount || 0} 条规则`;

  if (res.version) {
    versionText.textContent = `v${res.version}`;
  }

  if (editionTag && res.edition) {
    editionTag.textContent = res.editionLabel || res.edition;
    editionTag.className = `edition-tag ${res.edition}`;
  }

  if (providersHint && Array.isArray(res.providers) && res.providers.length > 0) {
    const names = res.providers
      .map((p) => (p.tier === "community" ? `${p.name}（社区）` : p.name))
      .join("、");
    providersHint.textContent = `已启用网盘：${names} · 自动注入合规下载请求头。`;
  }

  if (res.enabled) {
    statusDot.classList.add("active");
    statusText.textContent = "已启用 · 自动注入下载规则";
  } else {
    statusDot.classList.remove("active");
    statusText.textContent = "已暂停 · 未拦截下载请求";
  }

  if (res.appKey && !appKeyInput.value) {
    appKeyInput.value = res.appKey;
  }

  if (res.tokenValid) {
    authPill.textContent = "已授权";
    authPill.className = "pill ok";
    authActionsRow.style.display = "flex";
    tokenExpireText.textContent = formatRemainingDays(res.tokenExpiresAt);
    oauthBtn.textContent = "重新授权";
  } else if (res.hasToken) {
    authPill.textContent = "已过期";
    authPill.className = "pill warn";
    authActionsRow.style.display = "flex";
    tokenExpireText.textContent = "Token 已过期，请重新点击授权";
    oauthBtn.textContent = "重新授权";
  } else {
    authPill.textContent = "未授权";
    authPill.className = "pill";
    authActionsRow.style.display = "none";
    oauthBtn.textContent = "百度授权";
  }

  const modeRadio = document.querySelector(
    `input[name="downloadMode"][value="${res.downloadMode || "browser"}"]`
  );
  if (modeRadio) modeRadio.checked = true;
  if (res.downloadMode === "aria2") {
    aria2Details.open = true;
  }

  if (res.aria2Url && !aria2UrlInput.value) {
    aria2UrlInput.value = res.aria2Url;
  }
  if (res.aria2HasSecret && !aria2SecretInput.placeholder.includes("已设置")) {
    aria2SecretInput.placeholder = "已设置密钥（留空表示不修改）";
  }
}

async function refreshStatus() {
  const res = await chrome.runtime.sendMessage({ type: "PANDIRECT_GET_STATUS" });
  if (res?.ok) {
    renderStatus(res);
  } else {
    statusText.textContent = "状态读取失败";
  }
}

enabledToggle.addEventListener("change", async () => {
  enabledToggle.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "PANDIRECT_SET_CONFIG",
      enabled: enabledToggle.checked,
    });
    if (res?.ok) renderStatus(res);
  } finally {
    enabledToggle.disabled = false;
  }
});

oauthBtn.addEventListener("click", async () => {
  const appKey = appKeyInput.value.trim();
  if (!appKey) {
    setFeedback(oauthFeedback, "请先粘贴你的 AppKey", "err");
    return;
  }

  oauthBtn.disabled = true;
  setFeedback(oauthFeedback, "正在打开百度官方授权窗口...", "");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "PANDIRECT_OAUTH_LOGIN",
      provider: "baidu",
      appKey,
    });
    if (res?.ok) {
      renderStatus(res);
      setFeedback(
        oauthFeedback,
        "已打开百度授权窗口，点一次确认后窗口将自动关闭",
        "ok"
      );
    } else {
      setFeedback(oauthFeedback, res?.error || "授权失败", "err");
    }
  } catch (err) {
    setFeedback(oauthFeedback, err?.message || "授权过程出错", "err");
  } finally {
    oauthBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  const res = await chrome.runtime.sendMessage({
    type: "PANDIRECT_OAUTH_LOGOUT",
    provider: "baidu",
  });
  if (res?.ok) {
    renderStatus(res);
    setFeedback(oauthFeedback, "已清除本地授权 Token", "ok");
  }
});

document.querySelectorAll('input[name="downloadMode"]').forEach((radio) => {
  radio.addEventListener("change", async () => {
    const mode = radio.value;
    if (mode === "aria2") aria2Details.open = true;
    const res = await chrome.runtime.sendMessage({
      type: "PANDIRECT_SET_CONFIG",
      downloadMode: mode,
    });
    if (res?.ok) renderStatus(res);
  });
});

saveAria2Btn.addEventListener("click", async () => {
  const aria2Url = aria2UrlInput.value.trim();
  if (!aria2Url) {
    setFeedback(aria2Feedback, "RPC 地址不能为空", "err");
    return;
  }
  const payload = { type: "PANDIRECT_SET_CONFIG", aria2Url };
  if (aria2SecretInput.value.trim()) {
    payload.aria2Secret = aria2SecretInput.value.trim();
  }
  const res = await chrome.runtime.sendMessage(payload);
  if (res?.ok) {
    renderStatus(res);
    aria2SecretInput.value = "";
    setFeedback(aria2Feedback, "Aria2 配置已保存", "ok");
  } else {
    setFeedback(aria2Feedback, res?.error || "保存失败", "err");
  }
});

testAria2Btn.addEventListener("click", async () => {
  testAria2Btn.disabled = true;
  setFeedback(aria2Feedback, "正在连接 Aria2...", "");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "PANDIRECT_TEST_ARIA2",
      aria2Url: aria2UrlInput.value.trim(),
      aria2Secret: aria2SecretInput.value.trim() || undefined,
    });
    if (res?.ok) {
      setFeedback(aria2Feedback, `连接成功！Aria2 版本：${res.version}`, "ok");
    } else {
      setFeedback(aria2Feedback, res?.error || "连接失败", "err");
    }
  } finally {
    testAria2Btn.disabled = false;
  }
});

saveUaBtn.addEventListener("click", async () => {
  const ua = uaInput.value.trim();
  if (!ua) {
    setFeedback(uaFeedback, "User-Agent 不能为空", "err");
    return;
  }
  const res = await chrome.runtime.sendMessage({
    type: "PANDIRECT_SET_CONFIG",
    provider: "baidu",
    providerConfig: { userAgent: ua },
  });
  if (res?.ok) {
    renderStatus(res);
    setFeedback(uaFeedback, "已保存并立即生效", "ok");
  } else {
    setFeedback(uaFeedback, res?.error || "保存失败", "err");
  }
});

downloadBtn.addEventListener("click", async () => {
  const url = dlinkInput.value.trim();
  const filename = filenameInput.value.trim();
  if (!url) {
    setFeedback(downloadFeedback, "请先粘贴下载直链", "err");
    return;
  }

  const modeChecked = document.querySelector('input[name="downloadMode"]:checked');
  const mode = modeChecked ? modeChecked.value : "browser";

  downloadBtn.disabled = true;
  setFeedback(downloadFeedback, "正在发起下载...", "");
  try {
    const res = await chrome.runtime.sendMessage({
      type: "PANDIRECT_DOWNLOAD",
      url,
      filename: filename || undefined,
      mode,
    });
    if (res?.ok) {
      setFeedback(
        downloadFeedback,
        mode === "aria2"
          ? `已推送到 Aria2（GID: ${res.gid}）`
          : `已启动浏览器下载（任务 #${res.downloadId}）`,
        "ok"
      );
    } else {
      setFeedback(downloadFeedback, res?.error || "下载失败", "err");
    }
  } finally {
    downloadBtn.disabled = false;
  }
});

refreshStatus();
