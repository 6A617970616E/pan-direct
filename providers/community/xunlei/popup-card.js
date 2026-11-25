/**
 * Popup settings card for the Xunlei Cloud Drive community provider.
 * Included ONLY in Community / Dev builds (excluded from Store builds).
 */
export function renderXunleiPopupCard({ container, provider, sendMessage, onStatusUpdate }) {
  let card = container.querySelector('[data-provider-card="xunlei"]');

  if (!card) {
    card = document.createElement("section");
    card.className = "card";
    card.dataset.providerCard = "xunlei";
    card.innerHTML = `
      <div class="card-head">
        <span class="card-title">迅雷云盘（社区实验版）</span>
        <span class="pill" data-role="pill">未检测</span>
      </div>

      <p class="hint" data-role="hint">
        直接复用浏览器已登录的 <code>pan.xunlei.com</code> 会话（凭据仅临时保存在内存会话中，不落盘不上传），支持单文件直下、整文件夹写盘与推送 Aria2。
      </p>

      <div class="row" style="margin-top: 8px;">
        <button type="button" class="btn-primary" data-role="checkBtn" style="flex: 1;">
          检测迅雷登录态
        </button>
        <button type="button" class="btn-secondary" data-role="openBtn">
          打开迅雷
        </button>
      </div>

      <div class="row-between" data-role="actionsRow" style="display: none;">
        <span class="muted-sm" data-role="accountText"></span>
        <button type="button" class="btn-link danger" data-role="clearBtn">清除缓存</button>
      </div>

      <details class="sub-details">
        <summary class="clickable sub-summary">迅雷高级设置（下载 UA）</summary>
        <div class="sub-body">
          <label class="label">迅雷 CDN 下载 User-Agent（平时无需修改，用于匹配高速通道档位）</label>
          <div class="row">
            <input type="text" data-role="uaInput" placeholder="Dalvik/2.1.0 ..." />
            <button type="button" class="btn-secondary" data-role="saveUaBtn">保存</button>
          </div>
        </div>
      </details>

      <div class="feedback" data-role="feedback"></div>
    `;

    container.appendChild(card);

    const checkBtn = card.querySelector('[data-role="checkBtn"]');
    const openBtn = card.querySelector('[data-role="openBtn"]');
    const clearBtn = card.querySelector('[data-role="clearBtn"]');
    const uaInput = card.querySelector('[data-role="uaInput"]');
    const saveUaBtn = card.querySelector('[data-role="saveUaBtn"]');
    const feedback = card.querySelector('[data-role="feedback"]');

    const setFeedback = (text, type = "") => {
      feedback.textContent = text;
      feedback.className = "feedback" + (type ? ` ${type}` : "");
    };

    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      setFeedback("正在检测浏览器迅雷云盘登录会话...");
      try {
        const res = await sendMessage({
          type: "PANDIRECT_PROVIDER_AUTH_START",
          provider: "xunlei",
          openLoginIfNeeded: true,
        });
        if (res?.ok) {
          onStatusUpdate(res);
          if (res.authResult?.loggedIn) {
            const label = res.authResult.nickname
              ? `（${res.authResult.nickname}）`
              : "";
            setFeedback(
              `已检测到迅雷云盘登录态${label}，在 pan.xunlei.com 即可使用！`,
              "ok"
            );
          } else {
            setFeedback(
              "未检测到迅雷云盘登录会话，已为你打开 pan.xunlei.com，登录或刷新页面后重新检测即可。",
              "err"
            );
          }
        } else {
          setFeedback(res?.error || "检测失败", "err");
        }
      } catch (err) {
        setFeedback(err?.message || "检测异常", "err");
      } finally {
        checkBtn.disabled = false;
      }
    });

    openBtn.addEventListener("click", () => {
      chrome.tabs.create({ url: "https://pan.xunlei.com/" });
    });

    clearBtn.addEventListener("click", async () => {
      const res = await sendMessage({
        type: "PANDIRECT_PROVIDER_AUTH_LOGOUT",
        provider: "xunlei",
      });
      if (res?.ok) {
        onStatusUpdate(res);
        setFeedback("已清除迅雷云盘临时会话缓存", "ok");
      }
    });

    saveUaBtn.addEventListener("click", async () => {
      const ua = uaInput.value.trim();
      if (!ua) {
        setFeedback("迅雷 User-Agent 不能为空", "err");
        return;
      }
      const res = await sendMessage({
        type: "PANDIRECT_SET_CONFIG",
        provider: "xunlei",
        providerConfig: { userAgent: ua },
      });
      if (res?.ok) {
        onStatusUpdate(res);
        setFeedback("迅雷下载 UA 已保存并生效", "ok");
      } else {
        setFeedback(res?.error || "保存失败", "err");
      }
    });
  }

  // Update dynamic state from status response
  const st = provider.status || {};
  const pill = card.querySelector('[data-role="pill"]');
  const actionsRow = card.querySelector('[data-role="actionsRow"]');
  const accountText = card.querySelector('[data-role="accountText"]');
  const uaInput = card.querySelector('[data-role="uaInput"]');

  if (st.loggedIn) {
    pill.textContent = "已登录";
    pill.className = "pill ok";
    actionsRow.style.display = "flex";
    accountText.textContent = st.nickname
      ? `账号：${st.nickname}`
      : "浏览器会话有效";
  } else if (st.checkedAt) {
    pill.textContent = "未登录";
    pill.className = "pill warn";
    actionsRow.style.display = "none";
    accountText.textContent = "请先登录 pan.xunlei.com";
  } else {
    pill.textContent = "免配会话";
    pill.className = "pill";
    actionsRow.style.display = "none";
    accountText.textContent = "";
  }

  if (st.userAgent && !uaInput.value) {
    uaInput.value = st.userAgent;
  }
}
