import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { createBackgroundRuntime } from "../core/background-router.js";
import { pushToAria2, testAria2Connection } from "../core/aria2.js";
import { baiduProvider } from "../providers/official/baidu/provider.js";
import {
  isAllowedQuarkDownloadUrl,
  isTrustedLocalAria2Url,
  quarkProvider,
} from "../providers/community/quark/provider.js";
import { xunleiProvider } from "../providers/community/xunlei/provider.js";
import { buildEdition } from "../scripts/build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const POPUP_SENDER = {
  id: "test-ext-id",
  url: "chrome-extension://test-ext-id/popup/popup.html",
};

const DOWNLOADER_SENDER = {
  id: "test-ext-id",
  url: "chrome-extension://test-ext-id/downloader/downloader.html",
};

const BAIDU_TAB_SENDER = {
  id: "test-ext-id",
  tab: { url: "https://pan.baidu.com/disk/main#/index?path=%2F" },
};

const QUARK_TAB_SENDER = {
  id: "test-ext-id",
  tab: { url: "https://pan.quark.cn/list#/list/all" },
};

const LOCALHOST_BRIDGE_SENDER = {
  id: "test-ext-id",
  tab: { url: "http://localhost:3000/app" },
};

function createFullChromeMock(initialLocal = {}) {
  const localStore = { ...initialLocal };
  const sessionStore = {};
  let dynamicRules = [];
  let sessionRules = [];
  const downloads = [];
  let failNextDownload = false;

  const mockChrome = {
    runtime: {
      id: "test-ext-id",
      getManifest: () => ({ version: "0.4.0" }),
      getURL: (p) => `chrome-extension://test-ext-id/${p.replace(/^\/+/, "")}`,
    },
    storage: {
      local: {
        get: async (keys) => {
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = localStore[k];
            return out;
          }
          if (keys && typeof keys === "object") {
            const out = {};
            for (const [k, defVal] of Object.entries(keys)) {
              out[k] = localStore[k] !== undefined ? localStore[k] : defVal;
            }
            return out;
          }
          return { ...localStore };
        },
        set: async (obj) => {
          Object.assign(localStore, obj);
        },
      },
      session: {
        get: async (keys) => {
          const out = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            out[k] = sessionStore[k];
          }
          return out;
        },
        set: async (obj) => {
          Object.assign(sessionStore, obj);
        },
        remove: async (keys) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            delete sessionStore[k];
          }
        },
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [...dynamicRules],
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }) => {
        const removeSet = new Set(removeRuleIds);
        dynamicRules = dynamicRules.filter((r) => !removeSet.has(r.id));
        dynamicRules.push(...addRules);
      },
      getSessionRules: async () => [...sessionRules],
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
        const removeSet = new Set(removeRuleIds);
        sessionRules = sessionRules.filter((r) => !removeSet.has(r.id));
        sessionRules.push(...addRules);
      },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    tabs: {
      create: async (opts) => ({ id: 101, ...opts }),
      query: async () => [],
    },
    windows: {
      create: async (opts) => ({ id: 201, tabs: [{ id: 301 }], ...opts }),
      remove: async () => {},
    },
    downloads: {
      download: async (opts) => {
        if (failNextDownload) {
          failNextDownload = false;
          throw new Error("Download failed");
        }
        const id = downloads.length + 1;
        downloads.push({ id, url: opts.url, finalUrl: opts.url, ...opts });
        return id;
      },
      search: async ({ id }) => downloads.filter((d) => d.id === id),
    },
  };

  return {
    mockChrome,
    state: {
      localStore,
      sessionStore,
      downloads,
      getDynamicRules: () => dynamicRules,
      getSessionRules: () => sessionRules,
      setFailNextDownload: (val) => {
        failNextDownload = Boolean(val);
      },
    },
  };
}

test("DOM XSS fix: content-drawer.js renders untrusted URL paths and folder names strictly via textContent", async () => {
  const drawerCode = fs.readFileSync(
    path.join(REPO_ROOT, "core", "ui", "content-drawer.js"),
    "utf8"
  );

  const xssPayload = '<img src=x onerror="window.__XSS__=1">';
  const innerHtmlWrites = [];

  function createEl(tag = "div", initialClasses = []) {
    const classSet = new Set(initialClasses);
    const children = [];
    const listeners = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      id: "",
      style: {},
      title: "",
      _textContent: "",
      _innerHTML: "",
      children,
      classList: {
        add: (c) => classSet.add(c),
        remove: (c) => classSet.delete(c),
        contains: (c) => classSet.has(c),
        toggle: (c, force) => {
          const next = force === undefined ? !classSet.has(c) : Boolean(force);
          if (next) classSet.add(c);
          else classSet.delete(c);
          return next;
        },
      },
      get textContent() {
        return this._textContent;
      },
      set textContent(val) {
        this._textContent = String(val ?? "");
        children.length = 0;
      },
      get innerHTML() {
        return this._innerHTML;
      },
      set innerHTML(val) {
        this._innerHTML = String(val ?? "");
        innerHtmlWrites.push({ id: this.id, html: this._innerHTML });
      },
      appendChild(child) {
        children.push(child);
        return child;
      },
      addEventListener(evt, fn) {
        if (!listeners.has(evt)) listeners.set(evt, []);
        listeners.get(evt).push(fn);
      },
      trigger(evt) {
        for (const fn of listeners.get(evt) || []) fn({});
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    };
    return el;
  }

  const childMap = {
    "#pd-fab": createEl("button"),
    "#pd-drawer": createEl("div", ["pd-hidden"]),
    "#pd-close": createEl("button"),
    "#pd-title": createEl("div"),
    "#pd-current-path": createEl("div"),
    "#pd-notice": createEl("div", ["pd-hidden"]),
    "#pd-list": createEl("div"),
    "#pd-up": createEl("button", ["pd-hidden"]),
    "#pd-refresh": createEl("button"),
    "#pd-dl-dir": createEl("button"),
    "#pd-dl-selected": createEl("button"),
  };
  childMap["#pd-list"].id = "pd-list";

  const fakeWindow = {};
  const fakeDocument = {
    createElement: (tag) => {
      const el = createEl(tag);
      el.querySelector = (sel) => childMap[sel] || null;
      el.querySelectorAll = () => [];
      return el;
    },
    body: {
      appendChild: () => {},
    },
  };

  let respondList = null;
  const fakeChrome = {
    storage: {
      local: { get: async () => ({ enabled: true, downloadMode: "browser" }) },
      onChanged: { addListener: () => {} },
    },
    runtime: {
      sendMessage: (msg, cb) => {
        if (msg.type === "PANDIRECT_GET_STATUS") {
          cb({ ok: true, enabled: true, downloadMode: "browser" });
          return;
        }
        if (msg.type === "PANDIRECT_LIST_FILES") {
          respondList = cb;
          return;
        }
        cb({ ok: true });
      },
    },
  };

  vm.runInNewContext(drawerCode, {
    window: fakeWindow,
    document: fakeDocument,
    chrome: fakeChrome,
    setTimeout,
  });

  fakeWindow.PanDirectDrawer.mount({
    providerId: "baidu",
    providerName: `百度${xssPayload}`,
    getCurrentDir: () => xssPayload,
    fallbackDir: `/apps/${xssPayload}`,
    fallbackHint: `提示${xssPayload}`,
  });

  await new Promise((r) => setTimeout(r, 0));

  // Open drawer -> calls loadDirectory(getCurrentDir()) with XSS payload in activeDisplayPath
  childMap["#pd-fab"].trigger("click");
  await new Promise((r) => setTimeout(r, 0));

  // Verify loading text was set via textContent on child element, NEVER via innerHTML
  assert.equal(childMap["#pd-list"].children.length, 1);
  assert.ok(childMap["#pd-list"].children[0].textContent.includes(xssPayload));
  assert.equal(
    innerHtmlWrites.some((w) => w.html.includes(xssPayload)),
    false,
    "XSS payload must never be written to innerHTML"
  );

  // Trigger error fallback path with untrusted strings as well
  respondList({ ok: false, error: "errno=-6" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(
    innerHtmlWrites.some((w) => w.html.includes(xssPayload)),
    false,
    "Fallback UI must never write interpolated text to innerHTML"
  );
});

test("HTML injection fix: downloader.js renders URL label strictly via textContent", () => {
  const downloaderCode = fs.readFileSync(
    path.join(REPO_ROOT, "downloader", "downloader.js"),
    "utf8"
  );

  const payload = '<img src=x onerror="alert(1)">';
  const innerHtmlWrites = [];

  function makeEl(id = "") {
    const children = [];
    return {
      id,
      className: "",
      disabled: false,
      checked: true,
      value: "2",
      style: {},
      title: "",
      children,
      _textContent: "",
      get textContent() {
        return this._textContent;
      },
      set textContent(val) {
        this._textContent = String(val ?? "");
        children.length = 0;
      },
      set innerHTML(val) {
        innerHtmlWrites.push({ id: this.id, html: String(val ?? "") });
      },
      classList: { toggle: () => {} },
      addEventListener: () => {},
      appendChild(c) {
        children.push(c);
        return c;
      },
    };
  }

  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };

  vm.runInNewContext(downloaderCode, {
    window: {
      location: {
        search: `?provider=baidu&path=/&label=${encodeURIComponent(payload)}`,
      },
    },
    document: {
      getElementById: (id) => getEl(id),
      createElement: () => makeEl(),
      createDocumentFragment: () => makeEl("frag"),
    },
    chrome: {
      runtime: {
        sendMessage: () => {},
      },
    },
    URLSearchParams,
  });

  const fileListEl = getEl("fileList");
  assert.equal(fileListEl.children.length, 1);
  assert.ok(fileListEl.children[0].textContent.includes(payload));
  assert.equal(innerHtmlWrites.length, 0);
});

test("302 redirect allowlist enforcement, no response-body leakage, and ephemeral session rule cleanup", async () => {
  const { mockChrome, state } = createFullChromeMock({
    enabled: true,
    accessToken: "valid-token",
    tokenExpiresAt: Date.now() + 3600_000,
  });
  globalThis.chrome = mockChrome;

  const originalFetch = globalThis.fetch;
  let fetchMode = "evil-redirect";

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (fetchMode === "evil-redirect") {
      return {
        ok: true,
        status: 200,
        url: "https://evil.example.com/phishing",
        headers: new Headers(),
        body: { cancel: async () => {} },
      };
    }
    if (fetchMode === "non-2xx-secret") {
      return {
        ok: false,
        status: 403,
        url: u,
        text: async () => "SECRET_SESSION_LEAK_TOKEN_XYZ_987654321",
        body: { cancel: async () => {} },
      };
    }
    return {
      ok: true,
      status: 206,
      url: "https://bjbgp01.baidupcs.com/file/ok123?sig=1",
      headers: new Headers(),
      body: { cancel: async () => {} },
    };
  };

  try {
    const runtime = createBackgroundRuntime([baiduProvider, quarkProvider]);

    // 1. 302 redirect to a host outside provider allowlist MUST be rejected with no DNR rule installed
    await assert.rejects(
      () =>
        runtime.handleMessage(
          {
            type: "PANDIRECT_DOWNLOAD",
            provider: "baidu",
            url: "https://d.pcs.baidu.com/file/redir",
            filename: "test.zip",
            mode: "browser",
          },
          POPUP_SENDER
        ),
      /白名单|仅允许下载/
    );
    assert.equal(state.getSessionRules().length, 0);
    assert.equal(state.downloads.length, 0);

    // 2. Non-2xx response must NOT leak raw response body into error message
    fetchMode = "non-2xx-secret";
    await assert.rejects(
      () =>
        runtime.handleMessage(
          {
            type: "PANDIRECT_DOWNLOAD",
            provider: "quark",
            url: "https://dl-pc-zb.pds.quark.cn/download/secret.bin",
            mode: "browser",
          },
          POPUP_SENDER
        ),
      (err) => {
        assert.match(err.message, /HTTP 403/);
        assert.equal(err.message.includes("SECRET_SESSION_LEAK"), false);
        return true;
      }
    );

    // 3. Failed chrome.downloads.download() cleans up ephemeral session rule immediately
    fetchMode = "ok";
    state.setFailNextDownload(true);
    await assert.rejects(
      () =>
        runtime.handleMessage(
          {
            type: "PANDIRECT_DOWNLOAD",
            provider: "baidu",
            url: "https://d.pcs.baidu.com/file/ok123",
            filename: "ok.bin",
            mode: "browser",
          },
          POPUP_SENDER
        ),
      /Download failed/
    );
    assert.equal(state.getSessionRules().length, 0);

    // 4. Successful download installs session rule without main_frame, then cleans up on download completion
    const dlRes = await runtime.handleMessage(
      {
        type: "PANDIRECT_DOWNLOAD",
        provider: "baidu",
        url: "https://d.pcs.baidu.com/file/ok123",
        filename: "ok.bin",
        mode: "browser",
      },
      POPUP_SENDER
    );
    assert.equal(dlRes.ok, true);
    assert.equal(state.getSessionRules().length, 1);
    assert.equal(
      state.getSessionRules()[0].condition.resourceTypes.includes("main_frame"),
      false
    );
    assert.equal(
      state.getSessionRules()[0].condition.urlFilter,
      "|https://bjbgp01.baidupcs.com/file/ok123?sig=1|"
    );

    await runtime.handleDownloadChanged({
      id: dlRes.downloadId,
      state: { current: "complete" },
    });
    assert.equal(state.getSessionRules().length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Multi-select browser download keeps distinct per-URL ephemeral session rules on same and different CDN hosts", async () => {
  const { mockChrome, state } = createFullChromeMock({
    enabled: true,
    accessToken: "valid-token",
    tokenExpiresAt: Date.now() + 3600_000,
  });
  globalThis.chrome = mockChrome;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("xpan/multimedia")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          errno: 0,
          list: [
            { fs_id: 1, filename: "alpha.pdf", size: 100, dlink: "https://d.pcs.baidu.com/file/1" },
            { fs_id: 2, filename: "beta.mp4", size: 200, dlink: "https://d.pcs.baidu.com/file/2" },
            { fs_id: 3, filename: "gamma.zip", size: 300, dlink: "https://d.pcs.baidu.com/file/3" },
            { fs_id: 4, filename: "delta.txt", size: 400, dlink: "https://d.pcs.baidu.com/file/4" },
          ],
        }),
      };
    }

    // Files 1 & 2 share the exact same CDN host AND pathname (differ only by query string)
    if (u.startsWith("https://d.pcs.baidu.com/file/1")) {
      return {
        ok: true,
        status: 206,
        url: "https://edge1.baidupcs.com/download/?fid=1",
        headers: new Headers(),
        body: { cancel: async () => {} },
      };
    }
    if (u.startsWith("https://d.pcs.baidu.com/file/2")) {
      return {
        ok: true,
        status: 206,
        url: "https://edge1.baidupcs.com/download/?fid=2",
        headers: new Headers(),
        body: { cancel: async () => {} },
      };
    }
    // File 3 shares edge1 host with different path
    if (u.startsWith("https://d.pcs.baidu.com/file/3")) {
      return {
        ok: true,
        status: 206,
        url: "https://edge1.baidupcs.com/file/gamma_hash",
        headers: new Headers(),
        body: { cancel: async () => {} },
      };
    }
    // File 4 resolves to a different CDN host
    if (u.startsWith("https://d.pcs.baidu.com/file/4")) {
      return {
        ok: true,
        status: 206,
        url: "https://edge2.pcsdata.baidu.com/file/delta_hash",
        headers: new Headers(),
        body: { cancel: async () => {} },
      };
    }
    throw new Error(`Unexpected fetch: ${u}`);
  };

  try {
    const runtime = createBackgroundRuntime([baiduProvider]);
    const res = await runtime.handleMessage(
      {
        type: "PANDIRECT_DOWNLOAD_ITEMS",
        provider: "baidu",
        itemIds: ["1", "2", "3", "4"],
        mode: "browser",
        preferFrameDownload: true,
      },
      BAIDU_TAB_SENDER
    );

    assert.equal(res.ok, true);
    assert.equal(res.results.length, 4);
    assert.ok(res.results.every((r) => r.ok));

    // ALL 4 ephemeral session rules must coexist simultaneously with distinct IDs and exact filenames
    const sessionRules = state.getSessionRules();
    assert.equal(sessionRules.length, 4);
    assert.equal(new Set(sessionRules.map((r) => r.id)).size, 4);

    const expected = [
      ["|https://edge1.baidupcs.com/download/?fid=1|", "alpha.pdf"],
      ["|https://edge1.baidupcs.com/download/?fid=2|", "beta.mp4"],
      ["|https://edge1.baidupcs.com/file/gamma_hash|", "gamma.zip"],
      ["|https://edge2.pcsdata.baidu.com/file/delta_hash|", "delta.txt"],
    ];

    for (const [filter, expectedFilename] of expected) {
      const rule = sessionRules.find((r) => r.condition.urlFilter === filter);
      assert.ok(rule, `Missing session rule for ${filter}`);
      assert.deepEqual(rule.condition.resourceTypes, ["sub_frame"]);
      assert.deepEqual(rule.condition.initiatorDomains, ["pan.baidu.com"]);
      const cd = rule.action.responseHeaders?.find(
        (h) => h.header === "content-disposition"
      );
      assert.ok(cd && cd.value.includes(encodeURIComponent(expectedFilename)));
    }

    // Disabling PanDirect clears ALL ephemeral session rules immediately
    await runtime.handleMessage(
      { type: "PANDIRECT_SET_CONFIG", enabled: false },
      POPUP_SENDER
    );
    assert.equal(state.getSessionRules().length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Localhost bridge is excluded from Community & Store builds and minimized in Dev", async () => {
  const tempDist = fs.mkdtempSync(path.join(os.tmpdir(), "pandirect-sec-dist-"));
  try {
    for (const edition of ["store", "community"]) {
      const res = buildEdition({ rootDir: REPO_ROOT, distDir: tempDist, edition });
      assert.equal(
        fs.existsSync(path.join(res.outDir, "core", "content-bridge.js")),
        false,
        `${edition} build must not ship core/content-bridge.js`
      );
      const manifest = JSON.parse(
        fs.readFileSync(path.join(res.outDir, "manifest.json"), "utf8")
      );
      assert.equal(
        manifest.content_scripts.some((cs) =>
          cs.matches.some((m) => m.includes("localhost") || m.includes("127.0.0.1"))
        ),
        false,
        `${edition} manifest must not inject content scripts on localhost`
      );
    }
  } finally {
    fs.rmSync(tempDist, { recursive: true, force: true });
  }

  // Runtime edition gating: community/store reject localhost bridge messages; dev returns minimal status only
  const { mockChrome } = createFullChromeMock({
    enabled: true,
    appKey: "secret-app-key-123",
    aria2Url: "http://192.168.1.99:6800/jsonrpc",
    aria2Secret: "top-secret-rpc-token",
  });
  globalThis.chrome = mockChrome;

  const communityRuntime = createBackgroundRuntime([baiduProvider, quarkProvider], {
    edition: "community",
  });
  await assert.rejects(
    () =>
      communityRuntime.handleMessage(
        { type: "PANDIRECT_GET_STATUS" },
        LOCALHOST_BRIDGE_SENDER
      ),
    /未授权/
  );
  await assert.rejects(
    () =>
      communityRuntime.handleMessage(
        {
          type: "PANDIRECT_DOWNLOAD",
          url: "https://dl-pc-zb.pds.quark.cn/download/demo.bin",
        },
        LOCALHOST_BRIDGE_SENDER
      ),
    /未授权/
  );

  const devRuntime = createBackgroundRuntime([baiduProvider, quarkProvider], {
    edition: "dev",
  });
  const devBridgeStatus = await devRuntime.handleMessage(
    { type: "PANDIRECT_GET_STATUS" },
    LOCALHOST_BRIDGE_SENDER
  );
  assert.equal(devBridgeStatus.ok, true);
  assert.equal(devBridgeStatus.enabled, true);
  assert.equal(devBridgeStatus.appKey, undefined);
  assert.equal(devBridgeStatus.aria2Url, undefined);
  assert.equal(devBridgeStatus.aria2HasSecret, undefined);
  assert.equal(devBridgeStatus.providers, undefined);
});

test("Background router enforces per-message sender boundaries and SET_CONFIG field whitelist", async () => {
  const { mockChrome, state } = createFullChromeMock({
    enabled: true,
    accessToken: "original-oauth-token",
    tokenExpiresAt: Date.now() + 3600_000,
  });
  globalThis.chrome = mockChrome;

  const runtime = createBackgroundRuntime([baiduProvider, quarkProvider, xunleiProvider]);

  // Content scripts & downloader cannot mutate config, trigger OAuth, or probe Aria2
  for (const untrustedSender of [BAIDU_TAB_SENDER, DOWNLOADER_SENDER, {}]) {
    await assert.rejects(
      () =>
        runtime.handleMessage(
          { type: "PANDIRECT_SET_CONFIG", enabled: false },
          untrustedSender
        ),
      /未授权/
    );
    await assert.rejects(
      () =>
        runtime.handleMessage(
          { type: "PANDIRECT_OAUTH_LOGIN", provider: "baidu", appKey: "evil" },
          untrustedSender
        ),
      /未授权/
    );
    await assert.rejects(
      () =>
        runtime.handleMessage(
          { type: "PANDIRECT_TEST_ARIA2", aria2Url: "http://127.0.0.1:6800/jsonrpc" },
          untrustedSender
        ),
      /未授权/
    );
  }

  // Popup & content scripts cannot call downloader-only endpoints
  for (const nonDownloader of [POPUP_SENDER, BAIDU_TAB_SENDER]) {
    await assert.rejects(
      () =>
        runtime.handleMessage(
          { type: "PANDIRECT_LIST_FOLDER_RECURSIVE", provider: "baidu", path: "/" },
          nonDownloader
        ),
      /未授权/
    );
    await assert.rejects(
      () =>
        runtime.handleMessage(
          { type: "PANDIRECT_PUSH_ITEM_TO_ARIA2", provider: "baidu", itemId: "1" },
          nonDownloader
        ),
      /未授权/
    );
  }

  // Cross-provider isolation: Quark tab cannot list/download Baidu files or sync Xunlei session
  await assert.rejects(
    () =>
      runtime.handleMessage(
        { type: "PANDIRECT_LIST_FILES", provider: "baidu", dir: "/" },
        QUARK_TAB_SENDER
      ),
    /未授权/
  );
  await assert.rejects(
    () =>
      runtime.handleMessage(
        {
          type: "PANDIRECT_PROVIDER_SYNC_SESSION",
          provider: "xunlei",
          session: { authorization: "Bearer injected" },
        },
        BAIDU_TAB_SENDER
      ),
    /未授权/
  );

  // SET_CONFIG from popup allows userAgent but refuses to overwrite accessToken / tokenExpiresAt
  await runtime.handleMessage(
    {
      type: "PANDIRECT_SET_CONFIG",
      provider: "baidu",
      providerConfig: {
        userAgent: "custom-ua",
        accessToken: "injected-token",
        tokenExpiresAt: 9999999999999,
      },
    },
    POPUP_SENDER
  );
  const cfg = await runtime.storage.getProviderConfig("baidu");
  assert.equal(cfg.userAgent, "custom-ua");
  assert.equal(cfg.accessToken, "original-oauth-token");
  assert.equal(state.localStore.accessToken, "original-oauth-token");
});

test("core/aria2 validates URLs, handles HTTP 400 JSON-RPC errors, non-JSON responses, and timeouts", async () => {
  const originalFetch = globalThis.fetch;

  try {
    // 1. Invalid scheme rejected before fetch
    await assert.rejects(
      () =>
        pushToAria2({
          url: "https://d.pcs.baidu.com/file/1",
          filename: "a.bin",
          coreConfig: { aria2Url: "file:///etc/passwd" },
        }),
      /地址无效/
    );

    // 2. HTTP 400 with JSON-RPC error preserves Aria2's error message
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        jsonrpc: "2.0",
        error: { code: 1, message: "Unauthorized" },
      }),
    });
    await assert.rejects(
      () =>
        testAria2Connection({
          aria2Url: "http://localhost:6800/jsonrpc",
          coreConfig: {},
        }),
      /Unauthorized/
    );

    // 3. Non-JSON 502 HTML error yields clear status error instead of raw SyntaxError
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    });
    await assert.rejects(
      () =>
        pushToAria2({
          url: "https://d.pcs.baidu.com/file/1",
          filename: "a.bin",
          coreConfig: { aria2Url: "http://localhost:6800/jsonrpc" },
        }),
      /HTTP 502.*非 JSON/
    );

    // 4. AbortError surfaces clear timeout error
    globalThis.fetch = async () => {
      const err = new Error("Aborted");
      err.name = "AbortError";
      throw err;
    };
    await assert.rejects(
      () =>
        testAria2Connection({
          aria2Url: "http://localhost:6800/jsonrpc",
          coreConfig: {},
        }),
      /超时/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PRIVACY.md, Quark allowlist/trust checks, and provider comments stay accurate and consistent", () => {
  const privacy = fs.readFileSync(path.join(REPO_ROOT, "PRIVACY.md"), "utf8");
  assert.ok(privacy.includes("--save-session"));
  assert.ok(privacy.includes(".local"));

  const quarkSource = fs.readFileSync(
    path.join(REPO_ROOT, "providers", "community", "quark", "provider.js"),
    "utf8"
  );
  assert.equal(
    quarkSource.includes("Never reads or exports cookies via chrome.cookies"),
    false
  );

  // Double-check Quark URL guards
  assert.equal(isAllowedQuarkDownloadUrl("https://pan.quark.cn/account/info"), false);
  assert.equal(isAllowedQuarkDownloadUrl("https://dl-pc-zb.pds.quark.cn/file/1"), true);
  assert.equal(isTrustedLocalAria2Url("http://my-nas.local:6800/jsonrpc"), false);
  assert.equal(isTrustedLocalAria2Url("http://127.0.0.1:6800/jsonrpc"), true);
});
