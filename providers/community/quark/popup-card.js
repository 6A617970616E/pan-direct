/**
 * Popup settings card for the Quark Netdisk community provider.
 * Included ONLY in Community / Dev builds (excluded from Store builds).
 */
export function renderQuarkPopupCard({ container, provider, sendMessage, onStatusUpdate }) {
  let card = container.querySelector('[data-provider-card="quark"]');

  if (!card) {
    card = document.createElement("section");
    card.className = "card";
    card.dataset.providerCard = "quark";
    card.innerHTML = `
      <div class="card-head">
        <span class="card-title">夸克网盘（社区实验版）</span>
        <span class="pill" data-role="pill">未检测</span>
      </div>

      <p class="hint" data-role="hint">
        直接复用浏览器已登录的 <code>pan.quark.cn</code> 会话，浏览器直下、整文件夹写盘与推送本机 Aria2 均免配可用（Cookie 仅实时传给本机 Aria2，不落盘不上传）。
      </p>

      <div class="row" style="margin-top: 8px;">
        <button type="button" class="btn-primary" data-role="checkBtn" style="flex: 1;">
          检测夸克登录态
        </button>
        <button type="button" class="btn-secondary" data-role="openBtn">
          打开夸克
        </button>
      </div>

      <div class="row-between" data-role="actionsRow" style="display: none;">
        <span class="muted-sm" data-role="accountText"></span>
        <button type="button" class="btn-link danger" data-role="clearBtn">清除缓存</button>
      </div>

      <div class="row-between" data-role="manualCookieRow" style="display: none; margin-top: 6px;">
        <span class="muted-sm">当前正在使用手动覆盖的 Aria2 Cookie</span>
        <button type="button" class="btn-link" data-role="resetCookieBtn">恢复自动复用</button>
      </div>

      <details class="sub-details">
        <summary class="clickable sub-summary">夸克高级设置（客户端 UA / 手动覆盖 Aria2 Cookie）</summary>
        <div class="sub-body">
          <label class="label">夸克客户端 User-Agent（用于绕过网页端 code=23018 限制）</label>
          <div class="row">
            <input type="text" data-role="uaInput" placeholder="quark-cloud-drive/2.5.56 ..." />
            <button type="button" class="btn-secondary" data-role="saveUaBtn">保存</button>
          </div>

          <label class="label" style="margin-top: 8px;">
            手动覆盖 Aria2 Cookie（通常留空即可，默认自动复用本机浏览器会话）
          </label>
          <div class="row">
            <input type="password" data-role="cookieInput" placeholder="留空：自动读取当前夸克会话（仅发往本机 Aria2）" />
            <button type="button" class="btn-secondary" data-role="saveCookieBtn">保存</button>
          </div>
        </div>
      </details>

      <div class="feedback" data-role="feedback"></div>
    `;

    container.appendChild(card);

    const checkBtn = card.querySelector('[data-role="checkBtn"]');
    const openBtn = card.querySelector('[data-role="openBtn"]');
    const clearBtn = card.querySelector('[data-role="clearBtn"]');
    const resetCookieBtn = card.querySelector('[data-role="resetCookieBtn"]');
    const uaInput = card.querySelector('[data-role="uaInput"]');
    const saveUaBtn = card.querySelector('[data-role="saveUaBtn"]');
    const cookieInput = card.querySelector('[data-role="cookieInput"]');
    const saveCookieBtn = card.querySelector('[data-role="saveCookieBtn"]');
    const feedback = card.querySelector('[data-role="feedback"]');

    const setFeedback = (text, type = "") => {
      feedback.textContent = text;
      feedback.className = "feedback" + (type ? ` ${type}` : "");
    };

    checkBtn.addEventListener("click", async () => {
      checkBtn.disabled = true;
      setFeedback("正在检测浏览器夸克登录会话...");
      try {
        const res = await sendMessage({
          type: "PANDIRECT_PROVIDER_AUTH_START",
          provider: "quark",
          openLoginIfNeeded: true,
        });
        if (res?.ok) {
          onStatusUpdate(res);
          if (res.authResult?.loggedIn) {
            setFeedback(
              `已检测到夸克登录态（${res.authResult.nickname}），打开 pan.quark.cn 即可使用！`,
              "ok"
            );
          } else {
            setFeedback(
              "未检测到夸克登录态，已为你打开 pan.quark.cn，登录后重新检测即可。",
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
      chrome.tabs.create({ url: "https://pan.quark.cn/list#/list/all" });
    });

    clearBtn.addEventListener("click", async () => {
      const res = await sendMessage({
        type: "PANDIRECT_PROVIDER_AUTH_LOGOUT",
        provider: "quark",
      });
      if (res?.ok) {
        onStatusUpdate(res);
        cookieInput.value = "";
        setFeedback("已清除夸克本地缓存与 Aria2 Cookie 配置", "ok");
      }
    });

    resetCookieBtn.addEventListener("click", async () => {
      const res = await sendMessage({
        type: "PANDIRECT_SET_CONFIG",
        provider: "quark",
        providerConfig: { aria2Cookie: "" },
      });
      if (res?.ok) {
        onStatusUpdate(res);
        cookieInput.value = "";
        setFeedback("已清除手动 Cookie，恢复自动复用浏览器夸克会话", "ok");
      } else {
        setFeedback(res?.error || "清除失败", "err");
      }
    });

    saveUaBtn.addEventListener("click", async () => {
      const ua = uaInput.value.trim();
      if (!ua) {
        setFeedback("夸克 User-Agent 不能为空", "err");
        return;
      }
      const res = await sendMessage({
        type: "PANDIRECT_SET_CONFIG",
        provider: "quark",
        providerConfig: { userAgent: ua },
      });
      if (res?.ok) {
        onStatusUpdate(res);
        setFeedback("夸克客户端 UA 已保存并生效", "ok");
      } else {
        setFeedback(res?.error || "保存失败", "err");
      }
    });

    saveCookieBtn.addEventListener("click", async () => {
      const cookieVal = cookieInput.value.trim().replace(/^cookie\s*:\s*/i, "").trim();
      if (cookieVal && !/(?:^|;\s*)__puus=[^;]+/.test(cookieVal)) {
        setFeedback(
          "手动 Cookie 格式无效：必须包含 __puus=xxx（本机 Aria2 建议留空保存以自动复用）",
          "err"
        );
        return;
      }
      const res = await sendMessage({
        type: "PANDIRECT_SET_CONFIG",
        provider: "quark",
        providerConfig: { aria2Cookie: cookieVal },
      });
      if (res?.ok) {
        onStatusUpdate(res);
        cookieInput.value = "";
        setFeedback(
          cookieVal ? "本地 Aria2 专用 Cookie 已保存" : "已清空手动 Cookie，恢复自动复用浏览器会话",
          "ok"
        );
      } else {
        setFeedback(res?.error || "保存失败", "err");
      }
    });
  }

  // Update dynamic state from status response
  const st = provider.status || {};
  const pill = card.querySelector('[data-role="pill"]');
  const actionsRow = card.querySelector('[data-role="actionsRow"]');
  const manualCookieRow = card.querySelector('[data-role="manualCookieRow"]');
  const accountText = card.querySelector('[data-role="accountText"]');
  const uaInput = card.querySelector('[data-role="uaInput"]');
  const cookieInput = card.querySelector('[data-role="cookieInput"]');

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
    actionsRow.style.display = st.hasAria2Cookie ? "flex" : "none";
    accountText.textContent = "请先登录 pan.quark.cn";
  } else {
    pill.textContent = "免配会话";
    pill.className = "pill";
    actionsRow.style.display = st.hasAria2Cookie ? "flex" : "none";
    accountText.textContent = st.hasAria2Cookie ? "已设置本地 Aria2 Cookie" : "";
  }

  if (manualCookieRow) {
    manualCookieRow.style.display = st.hasAria2Cookie ? "flex" : "none";
  }

  if (st.userAgent && !uaInput.value) {
    uaInput.value = st.userAgent;
  }

  cookieInput.placeholder = st.hasAria2Cookie
    ? "已设置手动覆盖 Cookie（留空点保存恢复自动复用）"
    : "留空：自动读取当前夸克会话（仅发往本机 Aria2）";
}
