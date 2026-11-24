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
        直接复用浏览器已登录的 <code>pan.quark.cn</code> 会话，免配置即可浏览器直下与整文件夹流式写盘。
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

      <details class="sub-details">
        <summary class="clickable sub-summary">夸克高级设置（客户端 UA / 本地 Aria2 Cookie）</summary>
        <div class="sub-body">
          <label class="label">夸克客户端 User-Agent（用于绕过网页端 code=23018 限制）</label>
          <div class="row">
            <input type="text" data-role="uaInput" placeholder="quark-cloud-drive/2.5.56 ..." />
            <button type="button" class="btn-secondary" data-role="saveUaBtn">保存</button>
          </div>

          <label class="label" style="margin-top: 8px;">
            本地 Aria2 专用 Cookie（可选；浏览器直下无需填写，绝不自动抓 Cookie）
          </label>
          <div class="row">
            <input type="password" data-role="cookieInput" placeholder="可选：仅推送本机 Aria2 时粘贴" />
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
      const cookieVal = cookieInput.value.trim();
      const res = await sendMessage({
        type: "PANDIRECT_SET_CONFIG",
        provider: "quark",
        providerConfig: { aria2Cookie: cookieVal },
      });
      if (res?.ok) {
        onStatusUpdate(res);
        cookieInput.value = "";
        setFeedback(
          cookieVal ? "本地 Aria2 专用 Cookie 已保存" : "已清空本地 Aria2 专用 Cookie",
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

  if (st.userAgent && !uaInput.value) {
    uaInput.value = st.userAgent;
  }

  cookieInput.placeholder = st.hasAria2Cookie
    ? "已设置本地 Aria2 Cookie（留空点保存可清空）"
    : "可选：仅推送本机 Aria2 时粘贴";
}
