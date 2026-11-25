import { DEFAULT_CORE_CONFIG } from "./constants.js";
import { isHttpUrl, sanitizeFilename, sanitizeRelativePath } from "./utils.js";

const ARIA2_PUSH_TIMEOUT_MS = 15000;
const ARIA2_TEST_TIMEOUT_MS = 10000;

/**
 * Maps standard HTTP header strings ("Name: value") into Aria2 RPC options.
 * Extracts User-Agent and Referer into Aria2's dedicated `user-agent` / `referer`
 * options so Aria2 never emits its default `aria2/<ver>` UA (including proxy CONNECT)
 * or duplicates headers, while preserving remaining headers (e.g. Cookie) in `header`.
 */
export function buildAria2HeaderOptions(headers = []) {
  const options = {};
  const customHeaders = [];

  for (const raw of headers || []) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx <= 0) continue;

    const name = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (!name || !value) continue;

    const lower = name.toLowerCase();
    if (lower === "user-agent") {
      options["user-agent"] = value;
    } else if (lower === "referer") {
      options.referer = value;
    } else {
      customHeaders.push(`${name}: ${value}`);
    }
  }

  if (customHeaders.length > 0) {
    options.header = customHeaders;
  }

  return options;
}

async function callAria2Rpc(rpcUrl, payload, { timeoutMs, authFallbackMsg } = {}) {
  if (!isHttpUrl(rpcUrl)) {
    throw new Error(
      `Aria2 RPC 地址无效（${rpcUrl}），仅支持 http:// 或 https:// 地址。`
    );
  }

  const controller = new AbortController();
  const effectiveTimeout = timeoutMs || ARIA2_PUSH_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  let res;
  try {
    res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(
        `连接 Aria2 RPC 超时（${rpcUrl}），请检查 Aria2 / Motrix 服务状态。`
      );
    }
    throw new Error(
      `无法连接 Aria2 RPC（${rpcUrl}），请确认 Aria2 / Motrix 已启动。`
    );
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  let parsedJson = false;
  try {
    data = await res.json();
    parsedJson = true;
  } catch {
    parsedJson = false;
  }

  // Aria2 returns HTTP 400 with a JSON-RPC error payload on auth/param errors;
  // check data.error before failing on !res.ok so actionable error details are preserved.
  if (parsedJson && data?.error) {
    throw new Error(
      authFallbackMsg
        ? data.error.message || authFallbackMsg
        : `Aria2 返回错误：${data.error.message || JSON.stringify(data.error)}`
    );
  }

  if (!res.ok) {
    throw new Error(
      parsedJson
        ? `Aria2 RPC 请求失败（HTTP ${res.status}）`
        : `Aria2 RPC 返回异常响应（HTTP ${res.status}，非 JSON 数据）`
    );
  }

  if (!parsedJson || !data || typeof data !== "object") {
    throw new Error(`Aria2 RPC 返回非 JSON 数据（HTTP ${res.status}）`);
  }

  return data;
}

/**
 * Push a download URL to local Aria2 / Motrix via JSON-RPC 2.0.
 */
export async function pushToAria2({
  url,
  filename,
  relativePath,
  headers = [],
  coreConfig,
}) {
  const rpcUrl = (coreConfig.aria2Url || DEFAULT_CORE_CONFIG.aria2Url).trim();
  if (!rpcUrl) {
    throw new Error("请先在 PanDirect 设置中填写 Aria2 RPC 地址。");
  }

  const aria2Options = buildAria2HeaderOptions(headers);

  // Preserve subdirectory path in Aria2 when downloading folders
  const safeOut = relativePath
    ? sanitizeRelativePath(relativePath)
    : sanitizeFilename(filename);
  if (safeOut) {
    aria2Options.out = safeOut;
  }

  const params = [];
  if (coreConfig.aria2Secret) {
    params.push(`token:${coreConfig.aria2Secret}`);
  }
  params.push([url]);
  params.push(aria2Options);

  const payload = {
    jsonrpc: "2.0",
    id: `pandirect_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    method: "aria2.addUri",
    params,
  };

  const data = await callAria2Rpc(rpcUrl, payload, {
    timeoutMs: ARIA2_PUSH_TIMEOUT_MS,
  });

  return { mode: "aria2", gid: data.result };
}

export async function testAria2Connection({ aria2Url, aria2Secret, coreConfig }) {
  const rpcUrl = (aria2Url || coreConfig.aria2Url || DEFAULT_CORE_CONFIG.aria2Url).trim();
  const secret =
    typeof aria2Secret === "string"
      ? aria2Secret.trim()
      : coreConfig.aria2Secret || "";

  const params = secret ? [`token:${secret}`] : [];
  const data = await callAria2Rpc(
    rpcUrl,
    {
      jsonrpc: "2.0",
      id: `pandirect_ver_${Date.now()}`,
      method: "aria2.getVersion",
      params,
    },
    {
      timeoutMs: ARIA2_TEST_TIMEOUT_MS,
      authFallbackMsg: "Aria2 鉴权失败",
    }
  );

  return { version: data.result?.version || "unknown" };
}
