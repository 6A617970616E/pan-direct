/**
 * PanDirect Web Bridge
 *
 * Allows authorized PanDirect web pages (e.g., localhost during dev, or your
 * production domain configured in manifest.json) to:
 *   1. Detect whether the PanDirect extension is installed and active.
 *   2. Trigger a native browser download with PanDirect's DNR header rules active.
 *
 * Protocol (window.postMessage):
 *   Page -> Extension:
 *     { source: "pandirect-page", requestId: "...", action: "PING" }
 *     { source: "pandirect-page", requestId: "...", action: "DOWNLOAD", payload: { url, filename?, provider? } }
 *
 *   Extension -> Page:
 *     { source: "pandirect-ext", requestId: "...", ok: true|false, data?: ..., error?: ... }
 */

const PAGE_SOURCE = "pandirect-page";
const EXT_SOURCE = "pandirect-ext";

// Mark presence on the document element so pages can detect without race conditions
document.documentElement.dataset.pandirectInstalled = "true";

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== PAGE_SOURCE || !msg.action) return;

  const requestId = msg.requestId || null;

  const reply = (payload) => {
    window.postMessage(
      {
        source: EXT_SOURCE,
        requestId,
        ...payload,
      },
      window.location.origin
    );
  };

  if (msg.action === "PING") {
    chrome.runtime.sendMessage({ type: "PANDIRECT_GET_STATUS" }, (res) => {
      if (chrome.runtime.lastError) {
        reply({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (!res?.ok) {
        reply({ ok: false, error: res?.error || "扩展状态不可用" });
        return;
      }
      reply({
        ok: true,
        data: {
          version: res.version,
          edition: res.edition,
          editionLabel: res.editionLabel,
          enabled: res.enabled,
          downloadMode: res.downloadMode,
        },
      });
    });
    return;
  }

  if (msg.action === "DOWNLOAD") {
    const url = msg.payload?.url;
    const filename = msg.payload?.filename;
    const provider = msg.payload?.provider;
    if (!url || typeof url !== "string") {
      reply({ ok: false, error: "缺少有效的下载链接 url" });
      return;
    }

    chrome.runtime.sendMessage(
      { type: "PANDIRECT_DOWNLOAD", url, filename, provider },
      (res) => {
        if (chrome.runtime.lastError) {
          reply({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        if (res?.ok) {
          reply({ ok: true, data: { downloadId: res.downloadId } });
        } else {
          reply({ ok: false, error: res?.error || "下载启动失败" });
        }
      }
    );
  }
});
